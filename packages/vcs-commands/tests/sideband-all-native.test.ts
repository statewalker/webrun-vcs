/**
 * Protocol v2's `sideband-all` (`uploadpack.allowSidebandAll`), against native git (2.43 and
 * 2.5x). git's own suite runs t5702-protocol-v2 with `GIT_TEST_SIDEBAND_ALL=1` (its
 * linux-TEST-vars job); these twins take t5702's fetches and clones with the option set in
 * the served repository's config instead.
 *
 * Each scenario runs a native client against native upload-pack (file://, or
 * `git daemon --inetd`) and the same client against our git:// server, or our client against
 * native upload-pack: git decides what is right. The fetch response a native client reads
 * (`GIT_TRACE_PACKET`, up to the `packfile` line) is compared packet for packet, band byte
 * included.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  type Duplex,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import {
  childDuplex,
  daemonArgs,
  gitAsync,
  openTcpSocket,
  startTcpServer,
} from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { nativeAtLeast } from "./plumbing-native-support.js";
import { gitOut, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** `git daemon --inetd` over `srv` for one connection, with `extra` in its environment. */
function nativeDaemon(extra: Record<string, string> = {}): Duplex {
  return childDuplex(spawn("git", daemonArgs(srv), { env: testEnv(root, extra) }));
}

/** Our working copy of the repository at `dir` (below `root`). */
function oursAt(dir: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/** A fresh directory name below `root`. */
function fresh(name: string): string {
  return join(root, `${name}-${counter++}`);
}

/**
 * The fetch response of the last `command=fetch` in a native client's packet trace, as the
 * client read it (`\1` for a band-1 designator), up to the `packfile` line.
 */
function fetchResponse(trace: string): string[] {
  const lines = readFileSync(trace, "latin1")
    .split("\n")
    .map((l) => /packet: +(fetch|clone)([<>]) (.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  let start = -1;
  lines.forEach((m, i) => {
    if (m[2] === ">" && m[3] === "command=fetch") start = i;
  });
  const out: string[] = [];
  for (const m of lines.slice(start + 1)) {
    if (m[2] !== "<") continue;
    out.push(m[3] as string);
    if ((m[3] as string).endsWith("packfile")) break;
  }
  return out;
}

/**
 * The same fetch response, ACKs included: our server acknowledges the haves the native git's
 * upload-pack acknowledges (2.45+ skips a have whose child came first, 2.43 does not).
 */
function expectSameResponse(mine: string[], theirs: string[], label: string): void {
  expect(mine, label).toEqual(theirs);
}

/** Whether a native client's packet trace shows it sent `sideband-all`. */
function sentSidebandAll(trace: string): boolean {
  return /(fetch|clone)> sideband-all$/m.test(readFileSync(trace, "latin1"));
}

/** pkt-lines of a raw answer, as text (`0000` flush, `0001` delim). */
function pktLines(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const text = new TextDecoder("latin1");
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      out.push(len === 0 ? "0000" : len === 1 ? "0001" : "0002");
      at += 4;
      continue;
    }
    out.push(text.decode(bytes.subarray(at + 4, at + len)).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

function pkt(line: string): string {
  const payload = `${line}\n`;
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/**
 * A raw v2 request to the git:// server behind `duplex`: the advertisement is read, then
 * `request` (pkt-lines) is sent and the whole answer read. Returns the answer's lines.
 */
async function rawV2(duplex: Duplex, path: string, request: string): Promise<string[]> {
  const head = `git-upload-pack ${path}\0host=localhost\0\0version=2\0`;
  await duplex.write(
    new TextEncoder().encode(`${(head.length + 4).toString(16).padStart(4, "0")}${head}`),
  );
  const chunks: number[] = [];
  let sent = false;
  const iterator = duplex[Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 10_000),
      ),
    ]);
    if (next.done) break;
    chunks.push(...next.value);
    if (!sent && new TextDecoder("latin1").decode(new Uint8Array(chunks)).includes("0000")) {
      // the advertisement ends with the first flush
      sent = true;
      chunks.length = 0;
      await duplex.write(new TextEncoder().encode(request));
      await duplex.end?.();
    }
  }
  await duplex.close?.().catch(() => {});
  return pktLines(new Uint8Array(chunks));
}

describeGit("protocol v2 sideband-all, as native git", () => {
  let ours: { port: number; close(): Promise<void> };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sideband-all-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const make = (name: string, sidebandAll: boolean) => {
      const repo = join(srv, name);
      git(root, "init", "-q", "-b", "main", repo);
      for (let n = 1; n <= 4; n++) {
        writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
        git(repo, "add", `f${n}.txt`);
        gitOut(root, repo, ["commit", "-qm", `c${n}`], {
          GIT_AUTHOR_DATE: `170000000${n} +0000`,
          GIT_COMMITTER_DATE: `170000000${n} +0000`,
        });
        ids[`c${n}`] = git(repo, "rev-parse", "HEAD").trim();
      }
      git(repo, "branch", "side", ids.c2 as string);
      git(repo, "tag", "-a", "v1", "-m", "v1", ids.c1 as string);
      git(repo, "repack", "-adq");
      if (sidebandAll) git(repo, "config", "uploadpack.allowSidebandAll", "true");
    };
    make("sba", true);
    make("none", false);
    // ref-in-want too, for the band-3 refusal of an unknown want-ref
    make("sbarefs", true);
    git(join(srv, "sbarefs"), "config", "uploadpack.allowRefInWant", "true");

    const host = await openOurs(
      srv,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "sba",
    );
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: srv }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        // git before 2.45 acknowledges every have it holds
        const compatibility = nativeAtLeast(2, 45) ? "2.56" : "2.43";
        return opened ? servedRepositoryOf(opened, { host: { compatibility } }) : undefined;
      },
    });
    ours = await startTcpServer(async (duplex) => {
      await serveGitConnection({ duplex, resolveRepository });
    });
  });

  afterAll(async () => {
    await ours?.close();
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  const nativeUrl = (repo: string) => `file://${join(srv, repo)}`;
  const ourUrl = (repo: string) => `git://127.0.0.1:${ours.port}/${repo}`;

  /** The `fetch=` capability a native `ls-remote` (v2) read from `url`. */
  const fetchCapability = async (url: string): Promise<string | undefined> => {
    const trace = fresh("trace");
    const r = await gitAsync(root, root, ["-c", "protocol.version=2", "ls-remote", url], {
      GIT_TRACE_PACKET: trace,
    });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(trace, "latin1")
      .split("\n")
      .map((l) => /ls-remote< (fetch=.*)$/.exec(l)?.[1])
      .find((l) => l !== undefined);
  };

  it(`t5701-git-serve.sh: "test capability advertisement": fetch=... sideband-all under uploadpack.allowSidebandAll`, async () => {
    for (const repo of ["none", "sba", "sbarefs"]) {
      expect(await fetchCapability(ourUrl(repo)), repo).toBe(
        await fetchCapability(nativeUrl(repo)),
      );
    }
    expect(await fetchCapability(nativeUrl("sbarefs"))).toBe(
      "fetch=shallow wait-for-done ref-in-want sideband-all",
    );
  });

  /** A native clone of `url` (extra arguments first), its packet trace and its refs. */
  const nativeClone = async (url: string, ...args: string[]) => {
    const dir = fresh("clone");
    const trace = fresh("trace");
    const r = await gitAsync(
      root,
      root,
      ["-c", "protocol.version=2", "clone", "-q", ...args, url, dir],
      { GIT_TRACE_PACKET: trace },
    );
    expect(r.status, r.stderr).toBe(0);
    return { dir, trace, refs: git(dir, "for-each-ref"), fsck: git(dir, "fsck", "--strict") };
  };

  it(`t5702-protocol-v2.sh: "clone with git:// using protocol v2" (sideband-all): a native client and our server`, async () => {
    const theirs = await nativeClone(nativeUrl("sba"));
    const mine = await nativeClone(ourUrl("sba"));
    expect(sentSidebandAll(theirs.trace)).toBe(true);
    expect(sentSidebandAll(mine.trace)).toBe(true);
    expect(fetchResponse(mine.trace)).toEqual(fetchResponse(theirs.trace));
    expect(fetchResponse(mine.trace)).toEqual(["\\1packfile"]);
    expect(mine.refs.replaceAll(ourUrl("sba"), "")).toBe(theirs.refs);
  });

  it(`t5702-protocol-v2.sh: "fetch with git:// using protocol v2" (sideband-all): acknowledgments on band 1`, async () => {
    for (const repo of ["sba", "none"]) {
      const run = async (url: string) => {
        const { dir } = await nativeClone(url, "--single-branch", "-b", "side");
        const trace = fresh("trace");
        const r = await gitAsync(
          root,
          dir,
          ["-c", "protocol.version=2", "fetch", "-q", "origin", "main"],
          { GIT_TRACE_PACKET: trace },
        );
        expect(r.status, r.stderr).toBe(0);
        return { trace, head: git(dir, "rev-parse", "FETCH_HEAD").trim() };
      };
      const theirs = await run(nativeUrl(repo));
      const mine = await run(ourUrl(repo));
      expect(sentSidebandAll(mine.trace), repo).toBe(repo === "sba");
      expectSameResponse(fetchResponse(mine.trace), fetchResponse(theirs.trace), repo);
      expect(mine.head).toBe(ids.c4);
    }
    // the band byte, as git's packet_writer_write sends it
    const { dir } = await nativeClone(ourUrl("sba"), "--single-branch", "-b", "side");
    const trace = fresh("trace");
    await gitAsync(root, dir, ["-c", "protocol.version=2", "fetch", "-q", "origin", "main"], {
      GIT_TRACE_PACKET: trace,
    });
    expect(fetchResponse(trace)[0]).toBe("\\1acknowledgments");
  });

  it(`t5702-protocol-v2.sh: "upload-pack respects client shallows" (sideband-all): shallow-info on band 1`, async () => {
    const theirs = await nativeClone(nativeUrl("sba"), "--depth=2", "--no-local");
    const mine = await nativeClone(ourUrl("sba"), "--depth=2");
    expect(fetchResponse(mine.trace)).toEqual(fetchResponse(theirs.trace));
    expect(fetchResponse(mine.trace)).toContain("\\1shallow-info");
    expect(readFileSync(join(mine.dir, ".git", "shallow"), "utf8")).toBe(
      readFileSync(join(theirs.dir, ".git", "shallow"), "utf8"),
    );
    // deepened by one more
    const deepen = async (dir: string) => {
      const trace = fresh("trace");
      const r = await gitAsync(
        root,
        dir,
        ["-c", "protocol.version=2", "fetch", "-q", "--deepen=1", "origin"],
        { GIT_TRACE_PACKET: trace },
      );
      expect(r.status, r.stderr).toBe(0);
      return fetchResponse(trace);
    };
    expectSameResponse(await deepen(mine.dir), await deepen(theirs.dir), "deepen");
    expect(readFileSync(join(mine.dir, ".git", "shallow"), "utf8")).toBe(
      readFileSync(join(theirs.dir, ".git", "shallow"), "utf8"),
    );
  });

  /** A v2 fetch request (pkt-lines). */
  const request = (...args: string[]) => `${pkt("command=fetch")}0001${args.map(pkt).join("")}0000`;

  const RAW: Array<[string, string, string[]]> = [
    // git's packet_writer_error on band 3, without `ERR `
    [
      `t5703-upload-pack-ref-in-want.sh: "invalid want-ref line" (sideband-all)`,
      "sbarefs",
      ["no-progress", "sideband-all", "want-ref refs/heads/non-existent", "done"],
    ],
    [
      `t5702-protocol-v2.sh: "fetch by hash without tag following with protocol v2 does not list refs" (sideband-all, an object it lacks)`,
      "sba",
      ["no-progress", "sideband-all", `want ${"1".repeat(40)}`, "done"],
    ],
    // without uploadpack.allowSidebandAll the argument is an unexpected line: no answer
    [
      `t5702-protocol-v2.sh: "fetch with git:// using protocol v2" (sideband-all not allowed)`,
      "none",
      ["no-progress", "sideband-all", "want c4", "done"],
    ],
    // the sections before the pack, each on band 1
    [
      `t5703-upload-pack-ref-in-want.sh: "basic want-ref" (sideband-all)`,
      "sbarefs",
      ["no-progress", "sideband-all", "want-ref refs/heads/main", "have c1", "done"],
    ],
  ];
  for (const [title, repo, args] of RAW) {
    it(`${title}: our answer as upload-pack's`, async () => {
      const lines = args.map((a) => a.replace(/ (c\d)$/, (_, k: string) => ` ${ids[k]}`));
      const body = request(...lines);
      const cut = (answer: string[]) => answer.slice(0, answer.indexOf("\x01packfile") + 1);
      const theirs = await rawV2(nativeDaemon(), `/${repo}`, body);
      const mine = await rawV2(await openTcpSocket("127.0.0.1", ours.port), `/${repo}`, body);
      expect(cut(mine)).toEqual(cut(theirs));
      if (theirs.includes("\x01packfile")) expect(mine).toContain("0000");
    });
  }

  // ── our client against native upload-pack ──────────────────────────────────────────────

  /** Fetches `refspecs` with our client from native upload-pack over git:// (traced). */
  const ourFetch = async (dir: string, repo: string, ...refspecs: string[]) => {
    const serverTrace = fresh("trace");
    git(dir, "config", "protocol.version", "2");
    const mine = await oursAt(dir);
    const result = await mine
      .fetch()
      .setRemote(`git://localhost/${repo}`)
      .setRefSpecs(...refspecs)
      .setTransports(
        createDefaultTransports({
          openSocket: async () => nativeDaemon({ GIT_TRACE_PACKET: serverTrace }),
        }),
      )
      .call();
    return { result, serverTrace };
  };

  /** What upload-pack read in its last fetch command. */
  const fetchArgs = (trace: string) => {
    const lines = readFileSync(trace, "latin1")
      .split("\n")
      .map((l) => /upload-pack< (.*)$/.exec(l)?.[1])
      .filter((l): l is string => l !== undefined);
    return lines.slice(lines.lastIndexOf("command=fetch"));
  };

  it(`t5702-protocol-v2.sh: "fetch with git:// using protocol v2" (sideband-all): our client and native upload-pack`, async () => {
    for (const repo of ["sba", "none"]) {
      // the native twin
      const native = fresh("n");
      git(root, "init", "-q", "-b", "main", native);
      const nativeTrace = fresh("trace");
      const r = await gitAsync(
        root,
        native,
        ["-c", "protocol.version=2", "fetch", "-q", nativeUrl(repo), "side"],
        { GIT_TRACE_PACKET: nativeTrace },
      );
      expect(r.status, r.stderr).toBe(0);
      // ours: a first fetch without haves, then one with haves (acknowledgments)
      const dir = fresh("o");
      git(root, "init", "-q", "-b", "main", dir);
      const first = await ourFetch(dir, repo, "+refs/heads/side:refs/remotes/o/side");
      const sent = fetchArgs(first.serverTrace);
      expect(sent.includes("sideband-all"), repo).toBe(repo === "sba");
      // the native client's arguments, in its order (agent and ids aside)
      const options = (args: string[]) =>
        args.filter((a) => /^(thin-pack|no-progress|include-tag|ofs-delta|sideband-all)$/.test(a));
      expect(options(sent).includes("sideband-all")).toBe(
        options(fetchArgs(nativeTrace)).includes("sideband-all"),
      );
      expect(git(dir, "rev-parse", "refs/remotes/o/side").trim()).toBe(ids.c2);
      const second = await ourFetch(dir, repo, "+refs/heads/main:refs/remotes/o/main");
      expect(fetchArgs(second.serverTrace).some((a) => a.startsWith("have "))).toBe(true);
      expect(git(dir, "rev-parse", "refs/remotes/o/main").trim()).toBe(ids.c4);
      expect(gitOut(root, dir, ["fsck", "--strict"])).toBe("");
    }
  });

  it(`t5702-protocol-v2.sh: "upload-pack respects client shallows" (sideband-all): our shallow fetch from native upload-pack`, async () => {
    const native = fresh("n");
    git(root, "init", "-q", "-b", "main", native);
    const r = await gitAsync(root, native, [
      "-c",
      "protocol.version=2",
      "fetch",
      "-q",
      "--depth=2",
      nativeUrl("sba"),
      "main",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const dir = fresh("o");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "protocol.version", "2");
    const mine = await oursAt(dir);
    await mine
      .fetch()
      .setRemote("git://localhost/sba")
      .setRefSpecs("+refs/heads/main:refs/remotes/o/main")
      .setDepth(2)
      .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
      .call();
    const shallow = (d: string) =>
      existsSync(join(d, ".git", "shallow"))
        ? readFileSync(join(d, ".git", "shallow"), "utf8")
        : "";
    expect(shallow(dir)).toBe(shallow(native));
    expect(shallow(dir)).not.toBe("");
  });

  it(`t5702-protocol-v2.sh: "fetch by hash without tag following with protocol v2 does not list refs" (sideband-all): a refusal on band 3 reaches our client`, async () => {
    const missing = "1".repeat(40);
    const native = fresh("n");
    git(root, "init", "-q", "-b", "main", native);
    const theirs = await gitAsync(root, native, [
      "-c",
      "protocol.version=2",
      "fetch",
      "-q",
      nativeUrl("sba"),
      missing,
    ]);
    expect(theirs.status).not.toBe(0);
    const refusal = /fatal: remote error: (.*)$/m.exec(theirs.stderr)?.[1];
    expect(refusal).toBeDefined();
    const dir = fresh("o");
    git(root, "init", "-q", "-b", "main", dir);
    let message = "";
    try {
      await ourFetch(dir, "sba", missing);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(refusal as string);
  });
});
