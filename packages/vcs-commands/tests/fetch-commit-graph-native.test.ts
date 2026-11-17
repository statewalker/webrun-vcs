/**
 * `fetch.writeCommitGraph` against native git: after a fetch, git writes a split commit-graph
 * of what the refs reach (builtin/fetch.c: write_commit_graph_reachable with
 * COMMIT_GRAPH_WRITE_SPLIT). Twins cloned from one upstream fetch the same new commits, native
 * git in one and `FetchCommand` in the other; the chain file and every layer must be byte for
 * byte the same, and `git commit-graph verify` must accept ours.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const URL = "http://git.test/src.git";
let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The commit-graph files of a repository: name -> bytes (the chain, its layers, a single file). */
function graphFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const info = join(dir, ".git/objects/info");
  if (existsSync(join(info, "commit-graph"))) {
    out.set("commit-graph", readFileSync(join(info, "commit-graph")));
  }
  const graphs = join(info, "commit-graphs");
  if (existsSync(graphs)) {
    for (const name of readdirSync(graphs)) {
      out.set(`commit-graphs/${name}`, readFileSync(join(graphs, name)));
    }
  }
  return out;
}

describeGit("fetch.writeCommitGraph, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;
  let counter = 0;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-graph-native-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function commit(work: string, n = 1): void {
    for (let i = 0; i < n; i++) {
      const name = `f${counter++}.txt`;
      execFileSync("sh", ["-c", `echo ${name} > ${name}`], { cwd: work });
      run(work, "add", name);
      run(work, "commit", "-q", "-m", `commit ${name}`);
    }
  }

  /** The upstream `work` published as `src.git`; `native` and `ours` cloned from it. */
  function setup(config: Record<string, string> = { "fetch.writeCommitGraph": "true" }) {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, "init", "-q", "-b", "main", work);
    commit(work, 3);
    run(root, "clone", "-q", "--bare", work, src);
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, "clone", "-q", src, native);
    run(root, "clone", "-q", src, ours);
    run(ours, "config", "remote.origin.url", URL);
    for (const dir of [native, ours]) {
      for (const [key, value] of Object.entries(config)) run(dir, "config", key, value);
    }
    const push = () =>
      run(work, "push", "-q", "--force", src, "refs/heads/*:refs/heads/*", "refs/tags/*");
    const fetchOurs = async (configure: (c: ReturnType<Git["fetch"]>) => unknown = () => {}) => {
      const command = (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: ours }) });
      configure(command);
      return command.call();
    };
    const expectSame = () => {
      const n = graphFiles(native);
      const o = graphFiles(ours);
      expect([...o.keys()].sort()).toEqual([...n.keys()].sort());
      for (const [name, bytes] of n) {
        expect([name, Buffer.compare(o.get(name) as Buffer, bytes)]).toEqual([name, 0]);
      }
      if (o.size > 0) run(ours, "commit-graph", "verify");
    };
    return { work, native, ours, push, fetchOurs, expectSame };
  }

  it("writes the split layers native git writes, fetch after fetch", async () => {
    const { work, native, push, fetchOurs, expectSame } = setup();
    // a side branch merged in, an octopus-free history with a merge
    commit(work, 2);
    run(work, "checkout", "-q", "-b", "side", "HEAD~1");
    commit(work, 2);
    run(work, "checkout", "-q", "main");
    run(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    push();
    run(native, "fetch", "-q", "origin");
    const first = await fetchOurs();
    expectSame();
    expect(first.commitGraph?.length).toBe(1);
    expect(graphFiles(native).has("commit-graphs/commit-graph-chain")).toBe(true);

    // a small fetch adds a layer; a larger one merges it with the one below (--split=merge)
    commit(work, 1);
    push();
    run(native, "fetch", "-q", "origin");
    const second = await fetchOurs();
    expectSame();
    expect(second.commitGraph?.length).toBe(2);

    commit(work, 20);
    push();
    run(native, "fetch", "-q", "origin");
    await fetchOurs();
    expectSame();
  });

  it("keeps the changed-path filters of the graph there", async () => {
    const { work, native, ours, push, fetchOurs, expectSame } = setup();
    for (const dir of [native, ours]) {
      run(dir, "commit-graph", "write", "--reachable", "--split", "--changed-paths");
    }
    expectSame();
    commit(work, 4);
    push();
    run(native, "fetch", "-q", "origin");
    await fetchOurs();
    expectSame();
  });

  it("--no-write-commit-graph and the default write none; --write-commit-graph writes", async () => {
    const { work, native, ours, push, fetchOurs, expectSame } = setup({});
    commit(work, 2);
    push();
    run(native, "fetch", "-q", "origin");
    const none = await fetchOurs();
    expect(none.commitGraph).toBeUndefined();
    expectSame();
    expect(graphFiles(ours).size).toBe(0);

    run(native, "config", "fetch.writeCommitGraph", "true");
    run(ours, "config", "fetch.writeCommitGraph", "true");
    commit(work, 1);
    push();
    run(native, "fetch", "-q", "--no-write-commit-graph", "origin");
    await fetchOurs((c) => c.setWriteCommitGraph(false));
    expectSame();
    expect(graphFiles(ours).size).toBe(0);

    run(native, "config", "fetch.writeCommitGraph", "false");
    run(ours, "config", "fetch.writeCommitGraph", "false");
    commit(work, 1);
    push();
    run(native, "fetch", "-q", "--write-commit-graph", "origin");
    const written = await fetchOurs((c) => c.setWriteCommitGraph(true));
    expectSame();
    expect(written.commitGraph?.length).toBe(1);
  });
});
