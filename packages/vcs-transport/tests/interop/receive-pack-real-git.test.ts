/**
 * Our receive-pack against real git.
 *
 * - Oracle: the same hand-built push requests (packs made by `git pack-objects`) go to native
 *   `git receive-pack` and to our `serveOverDuplex`, on repositories with the same content;
 *   the reports must agree (missing objects, non-commit branch tips, funny names, deletes of
 *   missing refs and of the current branch, shallow pushes, unknown ids, corrupt packs). Lines
 *   newer git words differently (its ref transaction's "incorrect old value provided" and the
 *   like for 2.43's "failed to update ref") are normalised.
 * - Native `git push` over smart HTTP (`createFetchHandler` behind a loopback server) and over
 *   `--receive-pack` (a relay to `serveOverDuplex`): hooks, atomic pushes, 403, post-receive,
 *   shallow clients, the checked-out branch, and a large push answered before its import ends.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFetchHandler,
  type ReceiveCommand,
  type ReceivePackServerOptions,
  serveOverDuplex,
} from "../../src/index.js";
import { pushRequest, runReceivePack, ZERO } from "../helpers/receive-pack-harness.js";
import {
  cleanupDir,
  createTransportRepo,
  gitAvailable,
  loopbackEnv,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";
import { type LoopbackHttpServer, serveFetchHandler } from "./http-server.js";

const HAS_GIT = gitAvailable();
const describeGit = HAS_GIT ? describe : describe.skip;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Interop Tester",
  GIT_AUTHOR_EMAIL: "interop@example.com",
  GIT_COMMITTER_NAME: "Interop Tester",
  GIT_COMMITTER_EMAIL: "interop@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const TEST_TIMEOUT = 60000;
const GIT_TIMEOUT = 30000;

function gitSync(cwd: string, args: string[], input?: Uint8Array | string): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: { ...loopbackEnv(), ...GIT_ENV },
    input: input ?? "",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(cwd: string, args: string[], input?: string): string {
  return gitSync(cwd, args, input).toString("utf8").trim();
}

const children = new Set<ChildProcess>();

/** Runs git without blocking the event loop (our server answers in this process). */
function gitAsync(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: { ...loopbackEnv(), ...GIT_ENV },
        timeout: GIT_TIMEOUT,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        children.delete(child);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: stdout.trim(), stderr });
      },
    );
    children.add(child);
  });
}

function commitFile(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A git repository `src` with c1 ← c2 ← c3 on main. */
function sourceRepo(root: string, name = "src"): { dir: string; commits: string[] } {
  git(root, ["init", "-q", "--initial-branch=main", name]);
  const dir = join(root, name);
  const commits = [1, 2, 3].map((i) => commitFile(dir, `f${i}.txt`, `${i}\n`, `c${i}`));
  return { dir, commits };
}

/** Our repository with everything `dir` has (same refs, HEAD → main). */
async function ourCopy(dir: string): Promise<TransportRepo> {
  const repo = await createTransportRepo();
  const pack = gitSync(dir, ["pack-objects", "--revs", "--all", "--stdout", "-q"], "");
  await repo.facade.importPack(
    (async function* () {
      yield new Uint8Array(pack);
    })(),
  );
  for (const line of git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]).split("\n")) {
    const [oid, name] = line.split(" ") as [string, string];
    await repo.refStore.update(name, oid);
  }
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  return repo;
}

/** A pack of exactly the objects listed (git pack-objects without --revs). */
function packOfObjects(dir: string, ids: string[]): Uint8Array {
  const input = ids.length > 0 ? `${ids.join("\n")}\n` : "";
  return new Uint8Array(gitSync(dir, ["pack-objects", "--stdout", "-q"], input));
}

/** A pack of `revs` (rev-list arguments), as a client would send. */
function packOfRevs(dir: string, revs: string[]): Uint8Array {
  return new Uint8Array(
    gitSync(dir, ["pack-objects", "--revs", "--stdout", "-q"], `${revs.join("\n")}\n`),
  );
}

/** Sends a push request to native `git receive-pack <bare>`; returns the report lines. */
function nativeReceivePack(bare: string, request: Uint8Array): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["receive-pack", bare], { env: { ...process.env, ...GIT_ENV } });
    children.add(child);
    let out = Buffer.alloc(0);
    let sent = false;
    child.stdout.on("data", (data: Buffer) => {
      out = Buffer.concat([out, data]);
      if (!sent) {
        // the advertisement ends with the first flush
        let pos = 0;
        while (pos + 4 <= out.length) {
          const n = Number.parseInt(out.subarray(pos, pos + 4).toString(), 16);
          if (n === 0) {
            sent = true;
            out = out.subarray(pos + 4);
            child.stdin.end(Buffer.from(request));
            break;
          }
          if (pos + n > out.length) break;
          pos += n;
        }
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", () => {
      children.delete(child);
      const lines: string[] = [];
      let pos = 0;
      while (pos + 4 <= out.length) {
        const n = Number.parseInt(out.subarray(pos, pos + 4).toString(), 16);
        if (!n) {
          pos += 4;
          continue;
        }
        lines.push(
          out
            .subarray(pos + 4, pos + n)
            .toString("utf8")
            .replace(/\n$/, ""),
        );
        pos += n;
      }
      resolve(lines);
    });
  });
}

/** Report lines with version-dependent wording normalised to git 2.43's. */
function normalise(lines: string[]): string[] {
  return lines.map((line) =>
    line
      .replace(
        / (reference already exists|incorrect old value provided|invalid new value provided|reference does not exist|unknown failure)$/,
        " failed to update ref",
      )
      .replace(/^unpack (?!ok$).*/, "unpack <error>"),
  );
}

describeGit(
  "Interop · our receive-pack vs native git receive-pack (oracle)",
  { timeout: TEST_TIMEOUT },
  () => {
    let root: string;
    let src: { dir: string; commits: string[] };
    let fresh: string; // a commit native git has in src only (not in the servers)
    let scenario = 0;

    beforeAll(() => {
      root = makeTmpDir("vcs-interop-rp-oracle-");
      src = sourceRepo(root);
      // a commit the servers do not have: on a side branch of the source
      git(src.dir, ["checkout", "-q", "-b", "side"]);
      fresh = commitFile(src.dir, "new.txt", "new\n", "c4");
      git(src.dir, ["checkout", "-q", "main"]);
    });
    afterEach(() => {
      for (const child of children) child.kill("SIGKILL");
      children.clear();
    });
    afterAll(() => cleanupDir(root));

    /** Both servers start as copies of src's main; returns both reports. */
    async function both(
      request: Uint8Array,
      options: { empty?: boolean } = {},
    ): Promise<{ native: string[]; ours: string[] }> {
      scenario++;
      const bare = join(root, `bare-${scenario}.git`);
      let repo: TransportRepo;
      if (options.empty) {
        git(root, ["init", "-q", "--bare", "--initial-branch=main", bare]);
        repo = await createTransportRepo();
      } else {
        git(root, [
          "clone",
          "-q",
          "--no-local",
          "--bare",
          "--single-branch",
          "--no-tags",
          src.dir,
          bare,
        ]);
        const copy = join(root, `copy-${scenario}`);
        git(root, ["clone", "-q", "--no-local", "--single-branch", "--no-tags", src.dir, copy]);
        repo = await ourCopy(copy);
      }
      const native = await nativeReceivePack(bare, request);
      const run = await runReceivePack(repo, request.slice(), {});
      // runReceivePack decodes side-band: these requests ask none, so decode plainly
      return { native: normalise(native), ours: normalise(decodePlain(run.bytes)) };
    }

    const [h, p] = [() => src.commits[2] as string, () => src.commits[1] as string];

    it("a commit whose tree was not sent: missing necessary objects", async () => {
      const { native, ours } = await both(
        pushRequest({
          commands: [`${ZERO} ${fresh} refs/heads/m`, `${ZERO} ${h()} refs/heads/ok`],
          caps: "report-status",
          pack: packOfObjects(src.dir, [fresh]),
        }),
      );
      expect(native).toEqual([
        "unpack ok",
        "ng refs/heads/m missing necessary objects",
        "ok refs/heads/ok",
      ]);
      expect(ours).toEqual(native);
    });

    it("a tree on a branch is refused, on a tag accepted", async () => {
      const tree = git(src.dir, ["rev-parse", `${h()}^{tree}`]);
      const { native, ours } = await both(
        pushRequest({
          commands: [`${ZERO} ${tree} refs/heads/t`, `${ZERO} ${tree} refs/tags/t`],
          caps: "report-status",
          pack: packOfObjects(src.dir, []),
        }),
      );
      expect(native).toEqual([
        "unpack ok",
        "ng refs/heads/t failed to update ref",
        "ok refs/tags/t",
      ]);
      expect(ours).toEqual(native);
    });

    it("funny ref names, a one-level delete", async () => {
      const { native, ours } = await both(
        pushRequest({
          commands: [
            `${ZERO} ${h()} refs/heads/a..b`,
            `${ZERO} ${h()} refs/foo`,
            `${ZERO} ${ZERO} refs/bar`,
            `${ZERO} ${h()} HEAD`,
            `${ZERO} ${h()} refs/heads/fine`,
          ],
          caps: "report-status delete-refs",
          pack: packOfObjects(src.dir, []),
        }),
      );
      expect(native).toContain("ng refs/heads/a..b funny refname");
      expect(ours).toEqual(native);
    });

    it("deleting a missing ref is ok; deleting the current branch is prohibited", async () => {
      const { native, ours } = await both(
        pushRequest({
          commands: [`${ZERO} ${ZERO} refs/heads/nonexist`, `${h()} ${ZERO} refs/heads/main`],
          caps: "report-status delete-refs",
        }),
      );
      expect(native).toEqual([
        "unpack ok",
        "ok refs/heads/nonexist",
        "ng refs/heads/main deletion of the current branch prohibited",
      ]);
      expect(ours).toEqual(native);
    });

    it("a stale old value and an unknown new id", async () => {
      const { native, ours } = await both(
        pushRequest({
          commands: [`${p()} ${h()} refs/heads/main`, `${ZERO} ${"1".repeat(40)} refs/heads/u`],
          caps: "report-status",
          pack: packOfObjects(src.dir, []),
        }),
      );
      expect(native).toEqual([
        "unpack ok",
        "ng refs/heads/main failed to update ref",
        "ng refs/heads/u missing necessary objects",
      ]);
      expect(ours).toEqual(native);
    });

    it("a shallow push to an empty repository: shallow update not allowed", async () => {
      const { native, ours } = await both(
        pushRequest({
          shallow: [p()],
          commands: [`${ZERO} ${h()} refs/heads/s`],
          caps: "report-status",
          pack: packOfRevs(src.dir, [h(), `^${src.commits[0]}`]),
        }),
        { empty: true },
      );
      expect(native).toEqual(["unpack ok", "ng refs/heads/s shallow update not allowed"]);
      expect(ours).toEqual(native);
    });

    it("a corrupt pack: an unpack error, every command 'unpacker error'", async () => {
      const { native, ours } = await both(
        pushRequest({
          commands: [`${ZERO} ${h()} refs/heads/j`],
          caps: "report-status",
          pack: new TextEncoder().encode("PACKjunkjunkjunkjunk"),
        }),
      );
      expect(native).toEqual(["unpack <error>", "ng refs/heads/j unpacker error"]);
      expect(ours).toEqual(native);
    });
  },
);

/** Report lines of an answer without side-band. */
function decodePlain(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const n = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (!n) {
      pos += 4;
      continue;
    }
    lines.push(decoder.decode(bytes.subarray(pos + 4, pos + n)).replace(/\n$/, ""));
    pos += n;
  }
  return lines;
}

describeGit(
  "Interop · native git push → our smart-HTTP receive-pack",
  { timeout: TEST_TIMEOUT },
  () => {
    let root: string;
    let src: { dir: string; commits: string[] };
    let repo: TransportRepo;
    let server: LoopbackHttpServer;
    let url: string;
    let options: ReceivePackServerOptions = {};
    /** When the handler returned the response for each POST /git-receive-pack */
    const answeredAt: number[] = [];
    const serverErrors: string[] = [];

    beforeAll(async () => {
      root = makeTmpDir("vcs-interop-rp-http-");
      src = sourceRepo(root);
      // a handler per request: each test sets its own receive-pack options
      const handler = (request: Request) =>
        createFetchHandler({
          resolveRepository: async (repoPath) =>
            repoPath === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
          receivePack: options,
          logger: {
            info: () => {},
            error: (message, error) => serverErrors.push(`${message}: ${String(error)}`),
          },
        })(request);
      server = await serveFetchHandler(async (request) => {
        const response = await handler(request);
        if (new URL(request.url).pathname.endsWith("/git-receive-pack")) {
          answeredAt.push(performance.now());
        }
        return response;
      });
      url = `${server.baseUrl}/repo.git`;
    });

    afterEach(() => {
      for (const child of children) child.kill("SIGKILL");
      children.clear();
      options = {};
    });

    afterAll(async () => {
      await server?.close();
      cleanupDir(root);
    });

    /** A fresh server repository (a copy of src) and a clone to push from. */
    async function fresh(name: string): Promise<string> {
      repo = await ourCopy(src.dir);
      const work = join(root, name);
      git(root, ["clone", "-q", src.dir, work]);
      return work;
    }

    it("pushes a new branch, a fast-forward, a tag and a delete; fsck on a clone of it", async () => {
      const work = await fresh("w-basic");
      const c4 = commitFile(work, "f4.txt", "4\n", "c4");
      git(work, ["tag", "-a", "v4", "-m", "v4"]);
      let r = await gitAsync(work, ["push", url, "main:main", "main:refs/heads/topic", "v4"]);
      expect(r.code, r.stderr).toBe(0);
      expect(await repo.refStore.get("refs/heads/main")).toBe(c4);
      expect(await repo.refStore.get("refs/heads/topic")).toBe(c4);
      r = await gitAsync(work, ["push", url, ":refs/heads/topic"]);
      expect(r.code, r.stderr).toBe(0);
      expect(await repo.refStore.get("refs/heads/topic")).toBeUndefined();
      const check = join(root, "check-basic");
      const clone = await gitAsync(root, ["clone", "-q", url, check]);
      expect(clone.code, clone.stderr).toBe(0);
      expect(git(check, ["fsck", "--strict"])).toBe("");
    });

    it("the update hook refuses one ref and the others land; --atomic refuses all", async () => {
      const work = await fresh("w-update");
      const c4 = commitFile(work, "f4.txt", "4\n", "c4");
      const before = src.commits[2] as string;
      options = {
        hooks: { update: (refName) => (refName === "refs/heads/locked" ? "locked!" : undefined) },
      };
      let r = await gitAsync(work, [
        "push",
        "--atomic",
        url,
        "main:main",
        "main:refs/heads/locked",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("hook declined");
      expect(await repo.refStore.get("refs/heads/main")).toBe(before);

      r = await gitAsync(work, ["push", url, "main:main", "main:refs/heads/locked"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/\[remote rejected\]\s+main -> locked \(hook declined\)/);
      expect(r.stderr).toContain("remote: locked!");
      expect(await repo.refStore.get("refs/heads/main")).toBe(c4);
      expect(await repo.refStore.get("refs/heads/locked")).toBeUndefined();
    });

    it("authorize refusing the push: HTTP 403, nothing imported", async () => {
      const work = await fresh("w-403");
      commitFile(work, "f4.txt", "4\n", "c4");
      const importSpy = vi.fn(repo.facade.importPack.bind(repo.facade));
      repo.facade.importPack = importSpy;
      options = { hooks: { authorize: () => "no pushes today" } };
      const r = await gitAsync(work, ["push", url, "main:main"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("403");
      expect(importSpy).not.toHaveBeenCalled();
      expect(await repo.refStore.get("refs/heads/main")).toBe(src.commits[2]);
    });

    it("post-receive gets the moved refs once git push has its answer", async () => {
      const work = await fresh("w-post");
      const c4 = commitFile(work, "f4.txt", "4\n", "c4");
      let pushDone = false;
      let doneWhenHookRan: boolean | undefined;
      let moved: ReceiveCommand[] = [];
      options = {
        hooks: {
          postReceive: async (commands) => {
            // the hook may be slow: git push is not held back by it
            await new Promise((r) => setTimeout(r, 300));
            doneWhenHookRan = pushDone;
            moved = [...commands];
          },
        },
      };
      const r = await gitAsync(work, ["push", url, "main:main"]);
      pushDone = true;
      expect(r.code, r.stderr).toBe(0);
      await vi.waitFor(() => expect(doneWhenHookRan).toBe(true), { timeout: 5000 });
      expect(moved.map((c) => [c.refName, c.oldOid, c.newOid])).toEqual([
        ["refs/heads/main", src.commits[2], c4],
      ]);
    });

    it("a shallow clone pushing to an empty server: shallow update not allowed", async () => {
      repo = await createTransportRepo();
      const shallow = join(root, "w-shallow");
      git(root, ["clone", "-q", "--depth", "1", `file://${src.dir}`, shallow]);
      commitFile(shallow, "f4.txt", "4\n", "c4");
      const r = await gitAsync(shallow, ["push", url, "main:main"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("shallow update not allowed");
      expect(await repo.refStore.get("refs/heads/main")).toBeUndefined();
    });

    it("a shallow clone pushes on top of history the server has", async () => {
      repo = await ourCopy(src.dir);
      const shallow = join(root, "w-shallow-ok");
      git(root, ["clone", "-q", "--depth", "1", `file://${src.dir}`, shallow]);
      const c4 = commitFile(shallow, "f4.txt", "4\n", "c4");
      const r = await gitAsync(shallow, ["push", url, "main:main"]);
      expect(r.code, r.stderr).toBe(0);
      expect(await repo.refStore.get("refs/heads/main")).toBe(c4);
    });

    it("a non-bare server refuses to update its checked-out branch", async () => {
      const work = await fresh("w-checked-out");
      commitFile(work, "f4.txt", "4\n", "c4");
      options = { bare: false };
      const r = await gitAsync(work, ["push", url, "main:main", "main:refs/heads/other"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("branch is currently checked out");
      expect(await repo.refStore.get("refs/heads/other")).toBeDefined();
    });

    it("a large push is answered (head sent) before its import ends", async () => {
      const work = await fresh("w-large");
      writeFileSync(join(work, "big.bin"), randomBytes(4 * 1024 * 1024));
      git(work, ["add", "big.bin"]);
      git(work, ["commit", "-q", "-m", "big"]);
      const tip = git(work, ["rev-parse", "HEAD"]);
      let importEndedAt = 0;
      const importPack = repo.facade.importPack.bind(repo.facade);
      repo.facade.importPack = async (stream) => {
        const result = await importPack(stream);
        importEndedAt = performance.now();
        return result;
      };
      const start = answeredAt.length;
      const r = await gitAsync(work, ["push", url, "main:main"]);
      expect(r.code, r.stderr).toBe(0);
      expect(await repo.refStore.get("refs/heads/main")).toBe(tip);
      const answered = answeredAt[start] as number;
      expect(answered).toBeGreaterThan(0);
      expect(answered).toBeLessThan(importEndedAt);
      expect(serverErrors).toEqual([]);
    });
  },
);

const RELAY = `
import net from "node:net";
const socket = net.connect(Number(process.argv[2]), "127.0.0.1", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("close", () => {
  process.stdout.on("finish", () => process.exit(0));
  process.stdout.end();
});
socket.on("error", () => process.exit(1));
`;

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

describeGit(
  "Interop · native git push → our receive-pack over a pipe (--receive-pack)",
  { timeout: TEST_TIMEOUT },
  () => {
    let root: string;
    let src: { dir: string; commits: string[] };
    let repo: TransportRepo;
    let tcp: Server;
    let receivePack: string;
    let hooks: Parameters<typeof serveOverDuplex>[0]["hooks"];

    beforeAll(async () => {
      root = makeTmpDir("vcs-interop-rp-pipe-");
      src = sourceRepo(root);
      tcp = createServer({ allowHalfOpen: true }, (socket: Socket) => {
        void (async () => {
          const it = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
          await serveOverDuplex({
            duplex: {
              async *[Symbol.asyncIterator]() {
                while (true) {
                  const next = await it.next();
                  if (next.done) return;
                  yield new Uint8Array(next.value);
                }
              },
              write: (data: Uint8Array) =>
                new Promise<void>((resolve) => {
                  socket.write(data, () => resolve());
                }),
            },
            repository: repo.facade,
            refStore: repo.refStore,
            service: "git-receive-pack",
            hooks,
          });
          socket.end();
        })().catch(() => socket.destroy());
      });
      await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
      const relay = join(root, "relay.mjs");
      writeFileSync(relay, RELAY);
      receivePack = `${shellQuote(process.execPath)} ${shellQuote(relay)} ${(tcp.address() as AddressInfo).port}`;
    });

    afterEach(() => {
      for (const child of children) child.kill("SIGKILL");
      children.clear();
      hooks = undefined;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      cleanupDir(root);
    });

    it("pushes, and the update hook refuses one ref while the other lands", async () => {
      repo = await ourCopy(src.dir);
      const work = join(root, "w-pipe");
      git(root, ["clone", "-q", src.dir, work]);
      const c4 = commitFile(work, "f4.txt", "4\n", "c4");
      hooks = { update: (refName) => refName !== "refs/heads/locked" };
      const r = await gitAsync(work, [
        "push",
        "--receive-pack",
        receivePack,
        "file:///served/repo.git",
        "main:main",
        "main:refs/heads/locked",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/\[remote rejected\]\s+main -> locked \(hook declined\)/);
      expect(await repo.refStore.get("refs/heads/main")).toBe(c4);
      expect(await repo.refStore.get("refs/heads/locked")).toBeUndefined();
    });

    it("authorize refusing the push answers every ref, the pack is not imported", async () => {
      repo = await ourCopy(src.dir);
      const work = join(root, "w-pipe-auth");
      git(root, ["clone", "-q", src.dir, work]);
      commitFile(work, "f4.txt", "4\n", "c4");
      const importSpy = vi.fn(repo.facade.importPack.bind(repo.facade));
      repo.facade.importPack = importSpy;
      hooks = { authorize: () => "read-only mirror" };
      const r = await gitAsync(work, [
        "push",
        "--receive-pack",
        receivePack,
        "file:///served/repo.git",
        "main:main",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/\[remote rejected\]\s+main -> main \(read-only mirror\)/);
      expect(importSpy).not.toHaveBeenCalled();
    });
  },
);

describeGit("Interop · native git push of a large pack refused per ref", { timeout: 90000 }, () => {
  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  it("authorize refusing every ref after the head: git reads its report (the body is drained)", async () => {
    const root = makeTmpDir("vcs-interop-rp-big-");
    try {
      const repo = await createTransportRepo();
      const importSpy = vi.fn(repo.facade.importPack.bind(repo.facade));
      repo.facade.importPack = importSpy;
      const server = await serveFetchHandler(
        createFetchHandler({
          resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
          receivePack: {
            hooks: {
              authorize: (commands) => ({
                ok: false,
                message: "read-only branch",
                rejectedRefs: commands.map((c) => c.refName),
              }),
            },
          },
        }),
      );
      try {
        git(root, ["init", "-q", "--initial-branch=main", "w"]);
        const work = join(root, "w");
        writeFileSync(join(work, "big.bin"), randomBytes(16 * 1024 * 1024));
        git(work, ["add", "big.bin"]);
        git(work, ["commit", "-q", "-m", "big"]);
        const r = await gitAsync(work, [
          "-c",
          "http.postBuffer=1048576",
          "push",
          `${server.baseUrl}/repo.git`,
          "main:main",
        ]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/\[remote rejected\]\s+main -> main \(read-only branch\)/);
        expect(importSpy).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    } finally {
      cleanupDir(root);
    }
  });
});
