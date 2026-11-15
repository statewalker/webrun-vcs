/**
 * Real `git` as the CLIENT of our upload-pack (`serveOverDuplex`), protocol v2 and v0.
 *
 * git runs the command given by `--upload-pack` for a `file://` URL, with `GIT_PROTOCOL` in its
 * environment. That command here is a tiny relay script that forwards its stdin/stdout to a
 * loopback TCP socket served by this test process, after one header line carrying
 * `GIT_PROTOCOL`, so our server picks the protocol version as git's upload-pack would.
 *
 * Covered: shallow clone (`--depth`), deepening (`--deepen`, `--unshallow`) checked with
 * `git rev-list --count`, and "not our ref" for a want no ref reaches.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { serveOverDuplex } from "../../src/index.js";
import {
  cleanupDir,
  createTransportRepo,
  gitAvailable,
  makeTmpDir,
  type TransportRepo,
} from "./helpers.js";

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

/** Per-test timeout; each git call is killed well before it. */
const TEST_TIMEOUT = 60000;
const GIT_TIMEOUT = 20000;

/** git processes still running (killed after each test). */
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
      { cwd, env: { ...process.env, ...GIT_ENV }, timeout: GIT_TIMEOUT, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        children.delete(child);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: stdout.trim(), stderr });
      },
    );
    children.add(child);
  });
}

/** A word for `sh -c` (git runs `--upload-pack` through the shell). */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await gitAsync(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

const RELAY = `
import net from "node:net";
const socket = net.connect(Number(process.argv[2]), "127.0.0.1", () => {
  socket.write(JSON.stringify({ protocol: process.env.GIT_PROTOCOL ?? "" }) + "\\n");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
// exit once everything relayed reached git: end stdout, exit when it is flushed
socket.on("close", () => {
  process.stdout.on("finish", () => process.exit(0));
  process.stdout.end();
});
socket.on("error", () => process.exit(1));
`;

const encoder = new TextEncoder();

async function commitAt(
  repo: TransportRepo,
  name: string,
  time: number,
  parents: string[] = [],
): Promise<string> {
  const blob = await repo.history.blobs.store([encoder.encode(`${name}\n`)]);
  const tree = await repo.history.trees.store([{ name: `${name}.txt`, mode: 0o100644, id: blob }]);
  const ident = { name: "T", email: "t@example.com", timestamp: time, tzOffset: "+0000" };
  return repo.history.commits.store({
    tree,
    parents,
    author: ident,
    committer: ident,
    message: `${name}\n`,
  });
}

/** Serves `repo` to each relay connection, v2 when its header says GIT_PROTOCOL=version=2. */
function serveRelay(repo: TransportRepo): Server {
  return createServer({ allowHalfOpen: true }, (socket: Socket) => {
    void (async () => {
      const it = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      let buffered = Buffer.alloc(0);
      let newline = -1;
      while (newline < 0) {
        const next = await it.next();
        if (next.done) return;
        buffered = Buffer.concat([buffered, next.value]);
        newline = buffered.indexOf(10);
      }
      const header = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as {
        protocol: string;
      };
      const rest = buffered.subarray(newline + 1);
      const v2 = header.protocol.split(":").includes("version=2");
      await serveOverDuplex({
        duplex: {
          async *[Symbol.asyncIterator]() {
            if (rest.length) yield new Uint8Array(rest);
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
        service: "git-upload-pack",
        protocolVersion: v2 ? "2" : "1",
      });
      socket.end();
    })().catch(() => socket.destroy());
  });
}

describeGit("Interop · real git client ← our upload-pack", () => {
  let root: string;
  let repo: TransportRepo;
  let server: Server;
  let uploadPack: string;
  let commits: string[];
  let dangling: string;
  const url = "file:///served/repo.git";

  beforeAll(async () => {
    root = makeTmpDir("vcs-interop-serve-");
    repo = await createTransportRepo();
    commits = [];
    let parent: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const c = await commitAt(repo, `c${i}`, 1112911993 + i * 100, parent);
      commits.push(c);
      parent = [c];
    }
    dangling = await commitAt(repo, "dangling", 1112912500, [commits[1] as string]);
    await repo.refStore.update("refs/heads/main", commits[3] as string);
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");

    server = serveRelay(repo);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const relay = join(root, "relay.mjs");
    writeFileSync(relay, RELAY);
    uploadPack = `${shellQuote(process.execPath)} ${shellQuote(relay)} ${port}`;
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repo.close();
    cleanupDir(root);
  });

  it("protocol v2: --depth 1 clone, then --deepen 1, then --unshallow", async () => {
    const dst = join(root, "v2.git");
    await gitOk(root, [
      "-c",
      "protocol.version=2",
      "clone",
      "--bare",
      "--depth",
      "1",
      `--upload-pack=${uploadPack}`,
      url,
      dst,
    ]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("1");
    expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[3]);

    const fetch = ["-c", "protocol.version=2", "fetch", `--upload-pack=${uploadPack}`];
    await gitOk(dst, [...fetch, "--deepen=1", url, "refs/heads/main:refs/heads/main"]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("2");
    expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[2]);

    await gitOk(dst, [...fetch, "--unshallow", url, "refs/heads/main:refs/heads/main"]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("4");
    expect(existsSync(join(dst, "shallow"))).toBe(false);
    await gitOk(dst, ["fsck", "--no-dangling"]);
  }, TEST_TIMEOUT);

  it("protocol v0: --depth 2 clone has two commits", async () => {
    const dst = join(root, "v0.git");
    await gitOk(root, [
      "-c",
      "protocol.version=0",
      "clone",
      "--bare",
      "--depth",
      "2",
      `--upload-pack=${uploadPack}`,
      url,
      dst,
    ]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("2");
    expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[2]);
  }, TEST_TIMEOUT);

  it("protocol v2: a want no ref reaches is 'not our ref'; a reachable commit is served", async () => {
    const dst = join(root, "want.git");
    await gitOk(root, ["init", "-q", "--bare", dst]);
    const fetch = ["-c", "protocol.version=2", "fetch", `--upload-pack=${uploadPack}`, url];

    const refused = await gitAsync(dst, [...fetch, `${dangling}:refs/heads/x`]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`not our ref ${dangling}`);

    await gitOk(dst, [...fetch, `${commits[1]}:refs/heads/old`]);
    expect(await gitOk(dst, ["rev-list", "--count", "old"])).toBe("2");
  }, TEST_TIMEOUT);

  it("protocol v0: --depth 2 clone, then --depth=3, then --unshallow", async () => {
    const dst = join(root, "v0-deepen.git");
    await gitOk(root, [
      "-c",
      "protocol.version=0",
      "clone",
      "--bare",
      "--depth",
      "2",
      `--upload-pack=${uploadPack}`,
      url,
      dst,
    ]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("2");

    const fetch = ["-c", "protocol.version=0", "fetch", `--upload-pack=${uploadPack}`];
    await gitOk(dst, [...fetch, "--depth=3", url, "refs/heads/main:refs/heads/main"]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("3");
    expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[1]);

    await gitOk(dst, [...fetch, "--unshallow", url, "refs/heads/main:refs/heads/main"]);
    expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("4");
    expect(existsSync(join(dst, "shallow"))).toBe(false);
    await gitOk(dst, ["fsck", "--no-dangling"]);
  }, TEST_TIMEOUT);

  it("protocol v0: a shallow clone fetches without deepening", async () => {
    const dst = join(root, "v0-plain.git");
    await gitOk(root, [
      "-c",
      "protocol.version=0",
      "clone",
      "--bare",
      "--depth",
      "1",
      `--upload-pack=${uploadPack}`,
      url,
      dst,
    ]);
    // a new commit on top of the client's shallow one: the request has a shallow line, no
    // deepen (the last test: refs/heads/next stays)
    const next = await commitAt(repo, "c5", 1112912600, [commits[3] as string]);
    await repo.refStore.update("refs/heads/next", next);
    const fetch = ["-c", "protocol.version=0", "fetch", `--upload-pack=${uploadPack}`];
    await gitOk(dst, [...fetch, url, "refs/heads/next:refs/heads/next"]);
    expect(await gitOk(dst, ["rev-list", "--count", "next"])).toBe("2");
    expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[3]);
    await gitOk(dst, ["fsck", "--no-dangling"]);
  }, TEST_TIMEOUT);
});
