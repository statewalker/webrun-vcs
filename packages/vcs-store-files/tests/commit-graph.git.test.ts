/**
 * Commit-graphs against native git (whichever `git` is on PATH: 2.43 in the sandbox, 2.5x in
 * CI): graphs native git writes (one file, split chains, octopus merges, a large history) read
 * back with every commit's parents, tree, date and generation; our files byte-identical to
 * `git commit-graph write --reachable` with and without `--split` (and `--changed-paths`);
 * `git commit-graph verify` and `git fsck` accept them; gc writes one; replace refs, grafts,
 * shallow repositories and `core.commitGraph=false` disable it; walks over a graph read no
 * commit, and a stale graph still gives native git's answers.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitObjects, History } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, gc, writeCommitGraph } from "../src/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, input, maxBuffer: 1 << 30 }).toString();
const gitStatus = (cwd: string, args: string[]) => {
  try {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};
const version = (() => {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
})();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "commit-graph-"));
  dirs.push(d);
  return d;
};

/**
 * A history through fast-import: `n` commits on main, a branch merged every 7th commit, an
 * octopus of three branches every 23rd, files in nested directories (one with a high-bit name).
 */
function fastImportRepo(n: number, options: { start?: number; dir?: string } = {}): string {
  const dir = options.dir ?? tempDir();
  if (!options.dir) git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines: string[] = [];
  let mark = 0;
  const t0 = 1_600_000_000 + (options.start ?? 0) * 60;
  let main = options.start ? "refs/heads/main^0" : "";
  const commit = (ref: string, parents: string[], time: number, files: [string, string][]) => {
    mark++;
    lines.push(`commit ${ref}`, `mark :${mark}`);
    lines.push(
      `author A <a@example.com> ${time} +0000`,
      `committer C <c@example.com> ${time} +0000`,
    );
    const msg = `commit ${mark}\n`;
    lines.push(`data ${Buffer.byteLength(msg)}`, msg);
    if (parents[0]) lines.push(`from ${parents[0]}`);
    for (const p of parents.slice(1)) lines.push(`merge ${p}`);
    for (const [path, content] of files) {
      lines.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content);
    }
    return `:${mark}`;
  };
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 60;
    const k = (options.start ?? 0) + i;
    const files: [string, string][] = [[`d${k % 5}/s${k % 3}/f${k % 11}.txt`, `${k}\n`]];
    if (k % 13 === 0) files.push([`dé/f${k}.txt`, `${k}\n`]);
    if (k % 7 === 6 && main) {
      const b = commit("refs/heads/side", [main], t - 30, [[`side/f${k}`, `${k}\n`]]);
      main = commit("refs/heads/main", [main, b], t, files);
    } else if (k % 23 === 22 && main) {
      const bs = [1, 2, 3].map((j) =>
        commit(`refs/heads/o${j}`, [main], t - 10 * j, [[`o${j}/f${k}`, `${k}\n`]]),
      );
      main = commit("refs/heads/main", [main, ...bs], t, files);
    } else {
      main = commit("refs/heads/main", main ? [main] : [], t, files);
    }
  }
  git(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`);
  return dir;
}

/** A small repository with an octopus merge, a merge and an annotated tag. */
function smallRepo(): string {
  const dir = fastImportRepo(30);
  git(dir, ["tag", "-a", "-m", "release", "v1", "main~3"]);
  git(dir, ["branch", "topic", "main~5"]);
  return dir;
}

async function open(dir: string) {
  return createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
}

const graphFile = (dir: string) => join(dir, ".git/objects/info/commit-graph");
const graphsDir = (dir: string) => join(dir, ".git/objects/info/commit-graphs");

/** Every graph file of the repository, by name. */
function graphFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(graphFile(dir)))
    out["commit-graph"] = readFileSync(graphFile(dir)).toString("hex");
  if (existsSync(graphsDir(dir))) {
    for (const name of readdirSync(graphsDir(dir)).sort()) {
      out[`commit-graphs/${name}`] = readFileSync(join(graphsDir(dir), name)).toString("hex");
    }
  }
  return out;
}

/** Our `git commit-graph write --reachable [options]`. */
async function ourWrite(
  dir: string,
  options: Parameters<typeof writeCommitGraph>[0] extends infer O ? Partial<O> : never = {},
) {
  const { history, objects, files } = await open(dir);
  return writeCommitGraph({
    files,
    objects,
    refs: history.refs,
    commitGraph: history.commitGraph,
    ...options,
  });
}

/** Native and ours from copies of the same state: the graph files are identical. */
async function expectSameAsNative(
  dir: string,
  args: string[],
  options: Parameters<typeof ourWrite>[1] = {},
) {
  const native = tempDir();
  const ours = tempDir();
  cpSync(dir, native, { recursive: true });
  cpSync(dir, ours, { recursive: true });
  git(native, ["commit-graph", "write", "--reachable", ...args]);
  await ourWrite(ours, options);
  expect(graphFiles(ours)).toEqual(graphFiles(native));
  expect(gitStatus(ours, ["commit-graph", "verify"])).toBe(0);
  return ours;
}

/** The corrected commit date and topological level of each commit, from the parsed commits. */
async function expectedLevels(history: History, ids: string[]) {
  const gen = new Map<string, number>();
  const topo = new Map<string, number>();
  for (const id of [...ids].reverse()) {
    // rev-list order reversed: parents first
    const c = await history.commits.load(id);
    if (!c) throw new Error(id);
    let g = 0;
    let t = 0;
    for (const p of c.parents) {
      g = Math.max(g, gen.get(p) as number);
      t = Math.max(t, topo.get(p) as number);
    }
    const date = c.committer.timestamp;
    gen.set(id, date && date > g ? date : g + 1);
    topo.set(id, t + 1);
  }
  return { gen, topo };
}

/** Every commit read from the graph matches the commit parsed. */
async function expectGraphMatchesCommits(dir: string, layers?: number) {
  const { history } = await open(dir);
  const graph = await history.commitGraph?.get();
  if (!graph) throw new Error("no graph loaded");
  if (layers !== undefined) expect(graph.layers).toHaveLength(layers);
  const ids = git(dir, ["rev-list", "--all", "--topo-order"]).trim().split("\n");
  expect(graph.size).toBe(ids.length);
  const { gen, topo } = await expectedLevels(history, ids);
  for (const id of ids) {
    const c = await history.commits.load(id);
    const g = graph.lookup(id);
    expect(g?.parents).toEqual(c?.parents);
    expect(g?.tree).toBe(c?.tree);
    expect(g?.commitTime).toBe(c?.committer.timestamp);
    expect(g?.topoLevel).toBe(topo.get(id));
    expect(g?.generation).toBe(graph.correctedDates ? gen.get(id) : topo.get(id));
  }
  return graph;
}

describe("reading native commit-graphs", () => {
  it("one file with octopus merges (EDGE)", async () => {
    const dir = smallRepo();
    git(dir, ["commit-graph", "write", "--reachable"]);
    const graph = await expectGraphMatchesCommits(dir, 1);
    expect(graph.correctedDates).toBe(true);
    expect(graph.top.extraEdges).toBeDefined();
  });

  it("a split chain of several layers", async () => {
    const dir = fastImportRepo(20);
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    fastImportRepo(15, { start: 20, dir });
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    fastImportRepo(10, { start: 35, dir });
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge", "--changed-paths"]);
    expect(
      readFileSync(join(graphsDir(dir), "commit-graph-chain"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(3);
    const graph = await expectGraphMatchesCommits(dir, 3);
    // only the top layer has filters
    expect(graph.layers.map((l) => l.bloomSettings !== undefined)).toEqual([false, false, true]);
  });

  it("a large history", async () => {
    const dir = fastImportRepo(2000);
    git(dir, ["commit-graph", "write", "--reachable"]);
    await expectGraphMatchesCommits(dir, 1);
  });

  it("a graph without generation data v2 (commitGraph.generationVersion=1)", async () => {
    const dir = smallRepo();
    git(dir, ["-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable"]);
    const graph = await expectGraphMatchesCommits(dir, 1);
    expect(graph.correctedDates).toBe(false);
  });
});

describe("writing commit-graphs as native git", () => {
  it("--reachable: identical files, verify and fsck accept them", async () => {
    for (const dir of [smallRepo(), fastImportRepo(1500)]) {
      const ours = await expectSameAsNative(dir, []);
      expect(gitStatus(ours, ["fsck", "--no-progress"])).toBe(0);
    }
  });

  it("--changed-paths: identical Bloom filters (high-bit names, more than 512 paths)", async () => {
    const dir = smallRepo();
    const lines: string[] = [
      "commit refs/heads/main",
      "committer C <c@example.com> 1700000000 +0000",
      "data 4",
      "big",
      "from refs/heads/main^0",
    ];
    for (let i = 0; i < 600; i++) lines.push(`M 100644 inline many/f${i}`, "data 2", `${i % 10}\n`);
    git(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`);
    await expectSameAsNative(dir, ["--changed-paths"], { changedPaths: true });
    // an existing graph's filters are kept
    git(dir, ["commit-graph", "write", "--reachable", "--changed-paths"]);
    await expectSameAsNative(dir, []);
  });

  it.skipIf(version < 246)("commitGraph.changedPathsVersion=2 (git 2.46+)", async () => {
    const dir = smallRepo();
    git(dir, ["config", "commitGraph.changedPathsVersion", "2"]);
    await expectSameAsNative(dir, ["--changed-paths"], { changedPaths: true });
  });

  it("--split: a first layer, a base moved from info/commit-graph, merges and no-merge", async () => {
    const dir = fastImportRepo(40);
    // no graph yet
    await expectSameAsNative(dir, ["--split"], { split: true });
    // a single-file graph becomes the base of the chain
    git(dir, ["commit-graph", "write", "--reachable"]);
    fastImportRepo(5, { start: 40, dir });
    await expectSameAsNative(dir, ["--split"], { split: true });
    // a chain of three layers, then a write that merges the small ones
    rmSync(graphFile(dir));
    git(dir, ["commit-graph", "write", "--reachable", "--split"]);
    fastImportRepo(10, { start: 45, dir });
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    fastImportRepo(4, { start: 55, dir });
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    fastImportRepo(6, { start: 59, dir });
    const merged = await expectSameAsNative(dir, ["--split"], { split: true });
    expect(
      readFileSync(join(graphsDir(merged), "commit-graph-chain"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    await expectSameAsNative(dir, ["--split=no-merge"], { split: "no-merge" });
    await expectSameAsNative(dir, ["--split", "--size-multiple=10"], {
      split: true,
      sizeMultiple: 10,
    });
    await expectSameAsNative(dir, ["--split", "--max-commits=5"], { split: true, maxCommits: 5 });
    await expectSameAsNative(dir, ["--split=replace"], { split: "replace" });
    // a single-file write over a chain removes the chain
    const single = await expectSameAsNative(dir, []);
    expect(existsSync(graphsDir(single)) ? readdirSync(graphsDir(single)) : []).toEqual([]);
  });

  it("--append keeps the commits of the existing graph", async () => {
    const dir = fastImportRepo(20);
    git(dir, ["commit-graph", "write", "--reachable"]);
    // a branch deleted: --append still writes its commits
    git(dir, ["branch", "-D", "side"]);
    await expectSameAsNative(dir, ["--append"], { append: true });
  });

  it("gc writes the graph git gc writes, replacing a chain", async () => {
    const dir = smallRepo();
    git(dir, ["commit-graph", "write", "--reachable", "--split"]);
    const native = tempDir();
    cpSync(dir, native, { recursive: true });
    git(native, ["commit-graph", "write", "--reachable"]);
    const { history, files } = await open(dir);
    const result = await gc({ history, files });
    expect(result.commitGraphWritten).toBe(true);
    expect(graphFiles(dir)).toEqual(graphFiles(native));
    expect(gitStatus(dir, ["fsck", "--no-progress"])).toBe(0);
    // gc.writeCommitGraph=false
    rmSync(graphFile(dir));
    git(dir, ["config", "gc.writeCommitGraph", "false"]);
    const again = await open(dir);
    expect((await gc({ history: again.history, files: again.files })).commitGraphWritten).toBe(
      false,
    );
    expect(existsSync(graphFile(dir))).toBe(false);
  });
});

describe("when the graph is not used", () => {
  /** Native git writes no graph here, neither do we, and an existing one is not read. */
  async function expectDisabled(dir: string) {
    git(dir, ["commit-graph", "write", "--reachable"]);
    expect(existsSync(graphFile(dir))).toBe(false);
    expect((await ourWrite(dir)).written).toBe(false);
    expect(existsSync(graphFile(dir))).toBe(false);
  }

  it("with replace refs: not read, not written by gc (git commit-graph write ignores them)", async () => {
    const dir = smallRepo();
    git(dir, ["replace", "main~2", "main~4"]);
    // `git commit-graph write` disables replace refs: the graph is written, identically
    await expectSameAsNative(dir, []);
    git(dir, ["commit-graph", "write", "--reachable"]);
    const { history, files } = await open(dir);
    expect(existsSync(graphFile(dir))).toBe(true);
    expect(await history.commitGraph?.get()).toBeUndefined();
    // git gc writes none
    rmSync(graphFile(dir));
    git(dir, ["gc", "-q"]);
    expect(existsSync(graphFile(dir))).toBe(false);
    expect((await gc({ history, files })).commitGraphWritten).toBe(false);
    expect(existsSync(graphFile(dir))).toBe(false);
    // core.useReplaceRefs=false: used again
    git(dir, ["config", "core.useReplaceRefs", "false"]);
    git(dir, ["commit-graph", "write", "--reachable"]);
    expect(await (await open(dir)).history.commitGraph?.get()).toBeDefined();
  });

  it("with grafts", async () => {
    const dir = smallRepo();
    const [a, b] = git(dir, ["rev-parse", "main~1", "main~6"]).trim().split("\n");
    execFileSync("mkdir", ["-p", join(dir, ".git/info")]);
    execFileSync("sh", ["-c", `echo "${a} ${b}" > .git/info/grafts`], { cwd: dir });
    await expectDisabled(dir);
  });

  it("in a shallow repository", async () => {
    const src = smallRepo();
    const dir = tempDir();
    git(dir, ["clone", "-q", "--depth=3", `file://${src}`, "."]);
    await expectDisabled(dir);
  });

  it("with core.commitGraph=false", async () => {
    const dir = smallRepo();
    git(dir, ["commit-graph", "write", "--reachable"]);
    git(dir, ["config", "core.commitGraph", "false"]);
    const { history } = await open(dir);
    expect(await history.commitGraph?.get()).toBeUndefined();
    const result = await ourWrite(dir);
    expect(result.written).toBe(false);
    expect(result.warnings).toEqual([
      "attempting to write a commit-graph, but 'core.commitGraph' is disabled",
    ]);
  });
});

/** Counts the object reads of a backend (the commit store reads through the same kernel). */
function countReads(objects: GitObjects) {
  const counter = { reads: 0 };
  const get = objects.get.bind(objects);
  const getNow = objects.getNow?.bind(objects);
  objects.get = (id, options) => {
    counter.reads++;
    return get(id, options);
  };
  if (getNow) {
    objects.getNow = (id) => {
      counter.reads++;
      return getNow(id);
    };
  }
  return counter;
}

describe("walks over a native graph", () => {
  it("read no commit for parents, trees and dates", async () => {
    const dir = fastImportRepo(300);
    git(dir, ["commit-graph", "write", "--reachable"]);
    const head = git(dir, ["rev-parse", "main"]).trim();
    const { history, objects } = await open(dir);
    const counter = countReads(objects);
    let n = 0;
    for await (const _ of history.commits.walkAncestry(head)) n++;
    expect(n).toBe(Number(git(dir, ["rev-list", "--count", "main"]).trim()));
    expect(await history.commits.getTree(head)).toBe(git(dir, ["rev-parse", "main^{tree}"]).trim());
    expect(counter.reads).toBe(0);
    // without a graph every commit is read
    rmSync(graphFile(dir));
    const plain = await open(dir);
    const plainCounter = countReads(plain.objects);
    for await (const _ of plain.history.commits.walkAncestry(head)) n--;
    expect(n).toBe(0);
    expect(plainCounter.reads).toBeGreaterThan(300);
  });

  it("a stale graph and new commits give native git's merge bases and ancestry", async () => {
    const dir = fastImportRepo(60);
    git(dir, ["commit-graph", "write", "--reachable"]);
    fastImportRepo(30, { start: 60, dir });
    // a criss-cross after the graph
    git(dir, ["branch", "cx1", "main~3"]);
    git(dir, ["branch", "cx2", "side"]);
    const mk = (branch: string, other: string) => {
      const tree = git(dir, ["rev-parse", `${branch}^{tree}`]).trim();
      const id = git(dir, ["commit-tree", tree, "-p", branch, "-p", other, "-m", "x"]).trim();
      git(dir, ["update-ref", `refs/heads/${branch}`, id]);
    };
    const b1 = git(dir, ["rev-parse", "cx1"]).trim();
    const b2 = git(dir, ["rev-parse", "cx2"]).trim();
    mk("cx1", b2);
    git(dir, ["update-ref", "refs/heads/tmp", b1]);
    mk("cx2", "tmp");
    const { history } = await open(dir);
    expect((await history.commitGraph?.get())?.size).toBeLessThan(
      Number(git(dir, ["rev-list", "--count", "--all"]).trim()),
    );
    const refs = [
      "main",
      "main~10",
      "main~45",
      "main~80",
      "side",
      "o1",
      "o2",
      "cx1",
      "cx2",
      "v0",
    ].filter((r) => gitStatus(dir, ["rev-parse", "--verify", "-q", r]) === 0);
    const ids = refs.map((r) => git(dir, ["rev-parse", r]).trim());
    for (const a of ids) {
      for (const b of ids) {
        const native = git(dir, ["merge-base", "--all", a, b]).trim().split("\n").filter(Boolean);
        expect(await history.commits.findMergeBase(a, b)).toEqual(native);
        expect(await history.commits.isAncestor(a, b)).toBe(
          gitStatus(dir, ["merge-base", "--is-ancestor", a, b]) === 0,
        );
      }
    }
  });
});
