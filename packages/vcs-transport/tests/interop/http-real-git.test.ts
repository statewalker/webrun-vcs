/**
 * Real `git` as the client of our smart-HTTP server (`createFetchHandler` on a loopback
 * `node:http` server), protocol v2 and v0.
 *
 * git runs here asynchronously (execFile, never execFileSync): the server answers in this
 * process, so a synchronous git call would block it, which is what an earlier version of
 * this suite ran into and blamed on the sandbox.
 *
 * Covered for both versions: clone, `ls-remote`, shallow clone (`--depth`), deepening
 * (`--deepen`, `--unshallow`), a fetch whose negotiation takes several rounds (the client
 * has many commits the server lacks, so git sends several `have` batches, gzipped), and
 * `git fsck`. The server log (the `Git-Protocol` header of each request) and git's packet
 * trace show which protocol was spoken.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFetchHandler } from "../../src/index.js";
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
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const TEST_TIMEOUT = 60000;
const GIT_TIMEOUT = 30000;

/** git processes still running (killed after each test). */
const children = new Set<ChildProcess>();

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git without blocking the event loop; `input` goes to its stdin. */
function gitAsync(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: { ...loopbackEnv(), ...GIT_ENV, ...options.env },
        timeout: GIT_TIMEOUT,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        children.delete(child);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: stdout.trim(), stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    children.add(child);
  });
}

async function gitOk(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  const r = await gitAsync(cwd, args, options);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

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

/** A fast-import stream of `count` commits on `ref`, on top of `from`, newer than the server's. */
function localCommits(ref: string, from: string, count: number): string {
  let stream = "";
  for (let i = 1; i <= count; i++) {
    const message = `local ${i}\n`;
    const content = `local ${i}\n`;
    stream += `commit ${ref}\n`;
    stream += `committer L <l@example.com> ${1300000000 + i * 60} +0000\n`;
    stream += `data ${message.length}\n${message}`;
    if (i === 1) stream += `from ${from}\n`;
    stream += `M 100644 inline local-${i}.txt\ndata ${content.length}\n${content}\n`;
  }
  return stream;
}

describeGit("Interop · real git client ← our smart-HTTP server", { timeout: TEST_TIMEOUT }, () => {
  let root: string;
  let repo: TransportRepo;
  let server: LoopbackHttpServer;
  let url: string;
  let commits: string[];
  const serverLog: string[] = [];

  beforeAll(async () => {
    root = makeTmpDir("vcs-interop-http-");
    repo = await createTransportRepo();
    commits = [];
    let parent: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const c = await commitAt(repo, `c${i}`, 1112911993 + i * 100, parent);
      commits.push(c);
      parent = [c];
    }
    await repo.refStore.update("refs/heads/main", commits[3] as string);
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");

    server = await serveFetchHandler(
      createFetchHandler({
        resolveRepository: async (repoPath) =>
          repoPath === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
        logger: {
          info: (message) => serverLog.push(message),
          error: (message, error) => serverLog.push(`${message}: ${String(error)}`),
        },
      }),
    );
    url = `${server.baseUrl}/repo.git`;
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  afterAll(async () => {
    await server?.close();
    await repo?.close();
    cleanupDir(root);
  });

  /** Requests logged from `start` on. */
  function requestsSince(start: number) {
    return server.requests.slice(start);
  }

  function expectProtocol(start: number, version: "2" | "0") {
    const requests = requestsSince(start);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      if (!r.url.includes("upload-pack")) continue;
      expect(r.status).toBe(200);
      const v2 = (r.gitProtocol ?? "").split(":").includes("version=2");
      expect(v2, `${r.method} ${r.url} Git-Protocol: ${r.gitProtocol}`).toBe(version === "2");
    }
  }

  for (const version of ["2", "0"] as const) {
    it(`protocol v${version}: clone, ls-remote and fsck`, async () => {
      const dst = join(root, `clone-v${version}`);
      const trace = join(root, `trace-v${version}.txt`);
      const start = server.requests.length;
      await gitOk(root, ["-c", `protocol.version=${version}`, "clone", url, dst], {
        env: { GIT_TRACE_PACKET: trace },
      });
      expectProtocol(start, version);
      // git's own packet trace: the server answered "version 2" only for a v2 client
      const traced = readFileSync(trace, "utf8");
      if (version === "2") {
        expect(traced).toMatch(/clone< version 2$/m);
        expect(traced).toMatch(/clone> command=ls-refs$/m);
        expect(traced).toMatch(/clone> command=fetch$/m);
      } else {
        expect(traced).not.toMatch(/< version 2$/m);
        expect(traced).toMatch(/fetch-pack> want /);
      }

      expect(await gitOk(dst, ["rev-parse", "HEAD"])).toBe(commits[3]);
      expect(await gitOk(dst, ["rev-list", "--count", "HEAD"])).toBe("4");
      expect(readFileSync(join(dst, "c4.txt"), "utf8")).toBe("c4\n");
      await gitOk(dst, ["fsck", "--strict", "--no-dangling"]);

      const lsStart = server.requests.length;
      const listed = await gitOk(root, ["-c", `protocol.version=${version}`, "ls-remote", url]);
      expectProtocol(lsStart, version);
      expect(listed).toContain(`${commits[3]}\tHEAD`);
      expect(listed).toContain(`${commits[3]}\trefs/heads/main`);
      const symref = await gitOk(root, [
        "-c",
        `protocol.version=${version}`,
        "ls-remote",
        "--symref",
        url,
        "HEAD",
      ]);
      expect(symref).toContain("ref: refs/heads/main\tHEAD");
    });

    it(`protocol v${version}: --depth 1 clone, then --deepen 1, then --unshallow`, async () => {
      const dst = join(root, `shallow-v${version}.git`);
      const start = server.requests.length;
      const v = ["-c", `protocol.version=${version}`];
      await gitOk(root, [...v, "clone", "--bare", "--depth", "1", url, dst]);
      expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("1");
      expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[3]);

      await gitOk(dst, [...v, "fetch", "--deepen=1", url, "refs/heads/main:refs/heads/main"]);
      expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("2");
      expect(readFileSync(join(dst, "shallow"), "utf8").trim()).toBe(commits[2]);

      await gitOk(dst, [...v, "fetch", "--depth=3", url, "refs/heads/main:refs/heads/main"]);
      expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("3");

      await gitOk(dst, [...v, "fetch", "--unshallow", url, "refs/heads/main:refs/heads/main"]);
      expect(await gitOk(dst, ["rev-list", "--count", "main"])).toBe("4");
      expect(existsSync(join(dst, "shallow"))).toBe(false);
      await gitOk(dst, ["fsck", "--strict", "--no-dangling"]);
      expectProtocol(start, version);
    });

    it(`protocol v${version}: a fetch with much local history negotiates over several rounds`, async () => {
      const dst = join(root, `negotiate-v${version}`);
      const v = ["-c", `protocol.version=${version}`];
      await gitOk(root, [...v, "clone", "--bare", url, dst]);
      // 200 local commits the server never saw, newer than anything it has: git sends them
      // as haves first, in growing batches, before it reaches a common commit
      await gitOk(dst, ["fast-import", "--quiet"], {
        input: localCommits("refs/heads/local", commits[3] as string, 200),
      });
      expect(await gitOk(dst, ["rev-list", "--count", "local"])).toBe("204");

      // the server moves on: a new branch on top of the common history
      const topic = await commitAt(repo, `topic-v${version}`, 1112912600, [commits[3] as string]);
      await repo.refStore.update(`refs/heads/topic-v${version}`, topic);

      const trace = join(root, `negotiate-v${version}.txt`);
      rmSync(trace, { force: true });
      const start = server.requests.length;
      await gitOk(
        dst,
        [...v, "fetch", url, `refs/heads/topic-v${version}:refs/heads/topic-v${version}`],
        { env: { GIT_TRACE_PACKET: trace } },
      );
      expect(await gitOk(dst, ["rev-parse", `topic-v${version}`])).toBe(topic);
      await gitOk(dst, ["fsck", "--strict", "--no-dangling"]);
      expectProtocol(start, version);

      // several upload-pack POSTs, each standing alone; the larger have batches gzipped
      const posts = requestsSince(start).filter(
        (r) => r.method === "POST" && r.url.endsWith("/git-upload-pack"),
      );
      const fetchRounds = version === "2" ? posts.length - 1 : posts.length; // v2: ls-refs first
      expect(fetchRounds).toBeGreaterThanOrEqual(3);
      expect(posts.some((r) => r.contentEncoding === "gzip")).toBe(true);

      // the server found a common commit and said so ("ready" in v2)
      const traced = readFileSync(trace, "utf8");
      expect(traced).toMatch(/< ACK [0-9a-f]{40}/);
      if (version === "2") expect(traced).toMatch(/fetch< ready$/m);
      expect((traced.match(/fetch(-pack)?> have /g) ?? []).length).toBeGreaterThan(32);
    });
  }

  it("serves nothing for an unknown repository", async () => {
    const r = await gitAsync(root, ["ls-remote", `${server.baseUrl}/missing.git`]);
    expect(r.code).not.toBe(0);
    expect(serverLog.some((l) => l.includes("Repository not found: /missing.git"))).toBe(true);
  });
});

describeGit("Interop · real git clones an empty repository (unborn HEAD)", { timeout: TEST_TIMEOUT }, () => {
  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
  });

  it("protocol v2: the clone's HEAD is the server's unborn branch (ls-refs=unborn)", async () => {
    const root = makeTmpDir("vcs-interop-unborn-");
    const repo = await createTransportRepo();
    await repo.history.refs.setSymbolic("HEAD", "refs/heads/trunk");
    const server = await serveFetchHandler(
      createFetchHandler({
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      }),
    );
    try {
      const dst = join(root, "empty");
      const trace = join(root, "trace.txt");
      const r = await gitAsync(
        root,
        [
          "-c",
          "protocol.version=2",
          "-c",
          "init.defaultBranch=master",
          "clone",
          `${server.baseUrl}/r.git`,
          dst,
        ],
        { env: { GIT_TRACE_PACKET: trace } },
      );
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(trace, "utf8")).toMatch(/clone< unborn HEAD symref-target:refs\/heads\/trunk$/m);
      expect(readFileSync(join(dst, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/trunk");
    } finally {
      await server.close();
      await repo.close();
      cleanupDir(root);
    }
  });
});
