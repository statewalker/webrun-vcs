/**
 * Walks over commit-graphs whose generations cannot be trusted, against native git: graphs with
 * zero topological levels (git before 2.18), corrupt records, generations below a parent's
 * (dates past 2^32 and 2^34), each checked pair by pair with `git merge-base --is-ancestor` and
 * `git merge-base --all` run without the graph (`core.commitGraph=false`), which is always
 * right. Also: a stale graph does not make a pruned commit present, a failed graph load is not
 * retried, gc reports a failed graph write, settings come from the global config, the shallow
 * file and replace refs reload the graph, and a merged-away layer gets a new mtime.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommitGraphProvider,
  createCommits,
  loadRepositoryCommitGraph,
} from "@statewalker/vcs-core";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it, vi } from "vitest";
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

/** The output of a command that may exit 1 (`merge-base` of unrelated commits). */
const gitOut = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args);
  } catch (e) {
    if ((e as { status: number }).status === 1) return "";
    throw e;
  }
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "commit-graph-trust-"));
  dirs.push(d);
  return d;
};

const open = (dir: string) =>
  createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
const graphFile = (dir: string) => join(dir, ".git/objects/info/commit-graph");

/** A deterministic pseudo-random sequence (a 32-bit LCG). */
function random(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/**
 * A history through fast-import: commit i has the given parents (indexes of earlier commits)
 * and committer date; each commit gets a branch `c<i>` so a `--reachable` graph has them all.
 * Returns the commit ids by index.
 */
function dagRepo(commits: { parents: number[]; date: number }[]): { dir: string; ids: string[] } {
  const dir = tempDir();
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines: string[] = [];
  commits.forEach((c, i) => {
    lines.push(`commit refs/heads/c${i}`, `mark :${i + 1}`);
    lines.push(`author A <a@example.com> ${c.date} +0000`);
    lines.push(`committer C <c@example.com> ${c.date} +0000`);
    const msg = `commit ${i}\n`;
    lines.push(`data ${Buffer.byteLength(msg)}`, msg);
    const [first, ...rest] = c.parents;
    if (first !== undefined) lines.push(`from :${first + 1}`);
    else lines.push("deleteall");
    for (const p of rest) lines.push(`merge :${p + 1}`);
    lines.push(`M 100644 inline f${i % 7}`, `data ${String(i).length + 1}`, `${i}\n`);
  });
  git(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`);
  const ids = commits.map((_, i) => git(dir, ["rev-parse", `c${i}`]).trim());
  return { dir, ids };
}

/** A random DAG of `n` commits: one or two parents among the earlier ones, dates `date(i)`. */
function randomDag(n: number, seed: number, date: (i: number, r: (n: number) => number) => number) {
  const r = random(seed);
  const commits: { parents: number[]; date: number }[] = [];
  for (let i = 0; i < n; i++) {
    const parents: number[] = [];
    // a second root now and then
    if (i > 0 && !(i === 5)) {
      parents.push(i - 1 - r(Math.min(i, 4)));
      if (i > 2 && r(3) === 0) {
        const p = r(i);
        if (!parents.includes(p)) parents.push(p);
      }
    }
    commits.push({ parents, date: date(i, r) });
  }
  return commits;
}

/** The chunks of a commit-graph file. */
function chunks(bytes: Buffer): Map<string, { offset: number; size: number }> {
  const n = bytes[6] as number;
  const out = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < n; i++) {
    const at = 8 + 12 * i;
    const id = bytes.subarray(at, at + 4).toString("latin1");
    const offset = Number(bytes.readBigUInt64BE(at + 4));
    const next = Number(bytes.readBigUInt64BE(at + 16));
    out.set(id, { offset, size: next - offset });
  }
  return out;
}

/** Changes a commit-graph file in place and fixes its trailing checksum. */
function editGraph(dir: string, edit: (bytes: Buffer, chunk: (id: string) => number) => void) {
  const path = graphFile(dir);
  const bytes = Buffer.from(readFileSync(path));
  const map = chunks(bytes);
  edit(bytes, (id) => {
    const c = map.get(id);
    if (!c) throw new Error(`no ${id} chunk`);
    return c.offset;
  });
  const hash = createHash("sha1")
    .update(bytes.subarray(0, bytes.length - 20))
    .digest();
  hash.copy(bytes, bytes.length - 20);
  rmSync(path, { force: true });
  writeFileSync(path, bytes);
}

/** The graph position of `id` (its index in OIDL). */
function positionIn(bytes: Buffer, oidl: number, id: string): number {
  const n = countCommits(bytes);
  for (let i = 0; i < n; i++) {
    if (bytes.subarray(oidl + 20 * i, oidl + 20 * i + 20).toString("hex") === id) return i;
  }
  throw new Error(`${id} not in the graph`);
}
function countCommits(bytes: Buffer): number {
  const oidf = chunks(bytes).get("OIDF");
  if (!oidf) throw new Error("no OIDF");
  return bytes.readUInt32BE(oidf.offset + 4 * 255);
}

/** Every topological level (CDAT) set to 0, as git before 2.18 wrote them. */
function zeroLevels(dir: string) {
  editGraph(dir, (bytes, chunk) => {
    const cdat = chunk("CDAT");
    for (let i = 0; i < countCommits(bytes); i++) {
      const at = cdat + 36 * i + 28;
      bytes.writeUInt32BE(bytes.readUInt32BE(at) & 3, at);
    }
  });
}

/** Our answers against native git's without the graph, for every pair of `ids`. */
async function expectNativeAnswers(dir: string, ids: string[]) {
  const { history } = await open(dir);
  const off = ["-c", "core.commitGraph=false"];
  // every pair of a small history, a fixed sample of a larger one
  const pairs: [string, string][] = [];
  for (const a of ids) for (const b of ids) pairs.push([a, b]);
  const r = random(ids.length);
  const sample = pairs.length <= 160 ? pairs : pairs.filter(() => r(pairs.length) < 160);
  for (const [a, b] of sample) {
    {
      const native = gitOut(dir, [...off, "merge-base", "--all", a, b])
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(await history.commits.findMergeBase(a, b), `merge-base ${a} ${b}`).toEqual(native);
      expect(await history.commits.isAncestor(a, b), `is-ancestor ${a} ${b}`).toBe(
        gitStatus(dir, [...off, "merge-base", "--is-ancestor", a, b]) === 0,
      );
    }
  }
  return history;
}

const linear = (dates: number[]) =>
  dates.map((date, i) => ({ parents: i === 0 ? [] : [i - 1], date }));

vi.setConfig({ testTimeout: 60_000 });

describe("zero topological levels (git before 2.18): generations are Infinity", () => {
  it("a linear history on a v1 graph", async () => {
    const { dir, ids } = dagRepo(linear([1000, 2000, 3000, 4000]));
    git(dir, ["-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable"]);
    zeroLevels(dir);
    const { history } = await open(dir);
    const graph = await history.commitGraph?.get();
    expect(graph?.size).toBe(4);
    expect(graph?.generationsTrusted).toBe(false);
    expect(graph?.generationOf(ids[0] as string)).toBe(Number.POSITIVE_INFINITY);
    expect(await history.commits.isAncestor(ids[0] as string, ids[3] as string)).toBe(true);
    expect(await history.commits.isAncestor(ids[3] as string, ids[0] as string)).toBe(false);
    await expectNativeAnswers(dir, ids);
  });

  it("clock skew: the root newer than its children", async () => {
    const { dir, ids } = dagRepo([
      { parents: [], date: 5000 },
      { parents: [0], date: 1000 },
      { parents: [0], date: 2000 },
    ]);
    git(dir, ["-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable"]);
    zeroLevels(dir);
    const { history } = await open(dir);
    expect(await history.commits.findMergeBase(ids[1] as string, ids[2] as string)).toEqual([
      ids[0],
    ]);
    await expectNativeAnswers(dir, ids);
  });

  for (const version of [1, 2]) {
    it(`random histories with skewed dates (generation data v${version})`, async () => {
      for (const seed of [1, 2]) {
        const dag = randomDag(24, seed, (i, r) => 100_000 + i * 100 - r(5) * 250);
        const { dir, ids } = dagRepo(dag);
        const args = ["-c", `commitGraph.generationVersion=${version}`, "commit-graph", "write"];
        git(dir, [...args, "--reachable"]);
        zeroLevels(dir);
        await expectNativeAnswers(dir, ids);
      }
    });
  }
});

describe("graphs with corrupt records give the answers of a full walk", () => {
  it("a parent position out of range on the root of a linear history", async () => {
    const { dir, ids } = dagRepo(linear([1000, 2000, 3000, 4000]));
    git(dir, ["commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, chunk) => {
      const pos = positionIn(bytes, chunk("OIDL"), ids[0] as string);
      bytes.writeUInt32BE(0x00ffffff, chunk("CDAT") + 36 * pos + 20);
    });
    const { history } = await open(dir);
    const [c1, , , c4] = ids as [string, string, string, string];
    expect(await history.commits.isAncestor(c1, c4)).toBe(true);
    expect(await history.commits.findMergeBase(c1, c4)).toEqual([c1]);
    expect(await history.commits.getParents(c1)).toEqual([]);
    expect((await history.commitGraph?.get())?.generationsTrusted).toBe(false);
    await expectNativeAnswers(dir, ids);
  });

  it("a corrupt record in the middle of a random history, in a walk already begun", async () => {
    const dag = randomDag(30, 7, (i) => 100_000 + i * 60);
    const { dir, ids } = dagRepo(dag);
    git(dir, ["commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, chunk) => {
      const pos = positionIn(bytes, chunk("OIDL"), ids[12] as string);
      bytes.writeUInt32BE(0x00fffff0, chunk("CDAT") + 36 * pos + 20);
    });
    const { history } = await open(dir);
    // the commit store reads the commit itself for the corrupt record
    expect(await history.commits.getParents(ids[12] as string)).toEqual(
      // native git reads the parents without the graph (2.5x dies on the corrupt record)
      git(dir, ["-c", "core.commitGraph=false", "rev-parse", `${ids[12]}^@`])
        .trim()
        .split("\n")
        .filter(Boolean),
    );
    await expectNativeAnswers(dir, ids);
  });

  it("a generation below a parent's (GDA2 offset), as a graph git 2.43 wrote past 2^34", async () => {
    const { dir, ids } = dagRepo(linear([1000, 2000, 3000, 4000]));
    git(dir, ["commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, chunk) => {
      // c2's corrected date made 2^34 - 1 lower than the date stored: below c1's
      const pos = positionIn(bytes, chunk("OIDL"), ids[1] as string);
      const cdat = chunk("CDAT") + 36 * pos;
      bytes.writeUInt32BE(bytes.readUInt32BE(cdat + 28) | 3, cdat + 28);
    });
    const { history } = await open(dir);
    expect((await history.commitGraph?.get())?.generationsTrusted).toBe(false);
    await expectNativeAnswers(dir, ids);
  });

  for (const base of [2 ** 32 - 3000, 2 ** 34 - 3000]) {
    // git 2.43 keeps the largest parent generation in 32 bits (compute_reachable_generation_numbers):
    // past 2^32 a child can get a corrected date below its parent's
    it(`dates across ${base > 2 ** 33 ? "2^34" : "2^32"} in a graph native git wrote`, async () => {
      const dag = randomDag(20, 3, (i, r) => base + i * 300 - r(3) * 200);
      const { dir, ids } = dagRepo(dag);
      git(dir, ["commit-graph", "write", "--reachable"]);
      await expectNativeAnswers(dir, ids);
    });
  }
});

describe("a stale graph", () => {
  it("does not make a pruned commit present (getHeader with checkExists)", async () => {
    const { dir, ids } = dagRepo(linear([1000, 2000, 3000]));
    git(dir, ["commit-graph", "write", "--reachable"]);
    git(dir, ["update-ref", "-d", "refs/heads/c2"]);
    git(dir, ["reflog", "expire", "--expire=now", "--all"]);
    git(dir, ["-c", "gc.writeCommitGraph=false", "gc", "-q", "--prune=now"]);
    const pruned = ids[2] as string;
    expect(gitStatus(dir, ["cat-file", "-e", pruned])).not.toBe(0);
    const { history } = await open(dir);
    expect((await history.commitGraph?.get())?.has(pruned)).toBe(true);
    expect(await history.commits.getHeader?.(pruned, { checkExists: true })).toBeUndefined();
    expect((await history.commits.getHeader?.(ids[1] as string, { checkExists: true }))?.tree).toBe(
      git(dir, ["rev-parse", `${ids[1]}^{tree}`]).trim(),
    );
  });
});

describe("a graph written and loaded while a walk runs", () => {
  /**
   * Twenty linear commits, a graph over c0..c9 loaded; a commit store whose object reads
   * (commits outside that graph) write a graph of all twenty with native git and load it after
   * `swapAfter` reads, while the walk is on its way.
   */
  async function swappingStore(swapAfter: number) {
    const { dir, ids } = dagRepo(linear(Array.from({ length: 20 }, (_, i) => 1000 * (i + 1))));
    git(dir, ["commit-graph", "write", "--stdin-commits"], `${ids[9]}\n`);
    const files = createNodeFilesApi({ rootDir: dir });
    const { objects } = await open(dir);
    const provider = createCommitGraphProvider(() =>
      loadRepositoryCommitGraph({ files, gitDir: ".git" }),
    );
    expect((await provider.get())?.size).toBe(10);
    let reads = 0;
    // `getNow` left out so every read goes through `get`, where the graph is swapped
    const hooked = new Proxy(objects, {
      get(target, prop, receiver) {
        if (prop === "getNow") return undefined;
        if (prop === "get") {
          return async (id: string) => {
            if (++reads === swapAfter) {
              git(dir, ["commit-graph", "write", "--reachable"]);
              provider.invalidate();
              expect((await provider.get())?.size).toBe(20);
            }
            return target.get(id);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof objects;
    return { ids, commits: createCommits(hooked, { commitGraph: provider }) };
  }

  it("isAncestor keeps the graph it started with", async () => {
    const { ids, commits } = await swappingStore(1);
    expect(await commits.isAncestor(ids[14] as string, ids[19] as string)).toBe(true);
  });

  it("findMergeBase keeps the graph it started with", async () => {
    const { ids, commits } = await swappingStore(1);
    expect(await commits.findMergeBase(ids[14] as string, ids[19] as string)).toEqual([ids[14]]);
    const again = await swappingStore(2);
    const [c12, c19] = [again.ids[12] as string, again.ids[19] as string];
    expect(await again.commits.findMergeBase(c19, c12)).toEqual([c12]);
  });
});

describe("the provider", () => {
  it("remembers a failed load instead of retrying it on each use", async () => {
    let loads = 0;
    const errors: unknown[] = [];
    const provider = createCommitGraphProvider(
      async () => {
        loads++;
        throw new Error("unreadable");
      },
      (e) => errors.push(e),
    );
    expect(await provider.get()).toBeUndefined();
    expect(await provider.get()).toBeUndefined();
    expect(provider.current()).toBeUndefined();
    expect(loads).toBe(1);
    expect(errors).toHaveLength(1);
    provider.invalidate();
    expect(await provider.get()).toBeUndefined();
    expect(loads).toBe(2);
  });

  it("reloads after this process changes the shallow file or a replace ref", async () => {
    const { dir, ids } = dagRepo(linear([1000, 2000, 3000]));
    git(dir, ["commit-graph", "write", "--reachable"]);
    const { history } = await open(dir);
    expect(await history.commitGraph?.get()).toBeDefined();
    await history.refs.set(`refs/replace/${ids[1]}`, ids[0] as string);
    expect(await history.commitGraph?.get()).toBeUndefined();
    await history.refs.remove(`refs/replace/${ids[1]}`);
    expect(await history.commitGraph?.get()).toBeDefined();
    await history.refs.setShallow?.([ids[1] as string]);
    expect(await history.commitGraph?.get()).toBeUndefined();
    await history.refs.setShallow?.([]);
    expect(await history.commitGraph?.get()).toBeDefined();
  });

  it("reads core.commitGraph from the global config with an environment", async () => {
    const { dir } = dagRepo(linear([1000, 2000, 3000]));
    git(dir, ["commit-graph", "write", "--reachable"]);
    const globalConfig = join(tempDir(), "gitconfig");
    writeFileSync(globalConfig, "[core]\n\tcommitGraph = false\n");
    const environment = createNodeGitHostEnvironment({
      env: { HOME: tempDir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig },
    });
    const files = createNodeFilesApi({ rootDir: dir });
    const withGlobal = await createGitFilesBackend({ files, environment });
    expect(await withGlobal.history.commitGraph?.get()).toBeUndefined();
    const without = await createGitFilesBackend({ files });
    expect(await without.history.commitGraph?.get()).toBeDefined();
    const written = await writeCommitGraph({
      files,
      objects: without.objects,
      refs: without.history.refs,
      environment,
    });
    expect(written.written).toBe(false);
  });
});

describe("gc and the commit-graph", () => {
  it("reports a failed graph write and keeps what the repack did, as git gc", async () => {
    const { dir } = dagRepo(linear([1000, 2000, 3000]));
    mkdirSync(join(dir, ".git/objects/info"), { recursive: true });
    writeFileSync(join(dir, ".git/objects/info/commit-graph.lock"), "");
    const { history, files } = await open(dir);
    const result = await gc({ history, files });
    expect(result.commitGraphWritten).toBe(false);
    expect(result.commitGraphError).toMatch(/commit-graph\.lock/);
    expect(result.repack).not.toBeNull();
    expect(readdirSync(join(dir, ".git/objects/pack")).some((f) => f.endsWith(".pack"))).toBe(true);
    expect(git(dir, ["fsck", "--no-progress"])).toBe("");
  });
});

describe("writing split graphs", () => {
  it("renews the mtime of the layers merged away, as git's mark_commit_graphs", async () => {
    const dag = linear(Array.from({ length: 12 }, (_, i) => 1000 + i * 100));
    const { dir } = dagRepo(dag.slice(0, 4));
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    // more commits on top, a second layer
    let tip = git(dir, ["rev-parse", "c3"]).trim();
    const tree = git(dir, ["rev-parse", "c3^{tree}"]).trim();
    for (const [i, c] of dag.slice(4).entries()) {
      const env = { ...GIT_ENV, GIT_COMMITTER_DATE: `@${c.date} +0000` };
      tip = execFileSync("git", ["commit-tree", tree, "-p", tip, "-m", `more ${i}`], {
        cwd: dir,
        env,
      })
        .toString()
        .trim();
    }
    git(dir, ["update-ref", "refs/heads/more", tip]);
    git(dir, ["commit-graph", "write", "--reachable", "--split=no-merge"]);
    const layersDir = join(dir, ".git/objects/info/commit-graphs");
    const before = readdirSync(layersDir).filter((f) => f.endsWith(".graph"));
    expect(before).toHaveLength(2);
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const f of before) utimesSync(join(layersDir, f), old, old);
    const { history, objects, files } = await open(dir);
    // merge every layer into one, keep the merged-away ones (expiry far in the past)
    const result = await writeCommitGraph({
      files,
      objects,
      refs: history.refs,
      split: "replace",
      expireTime: 0,
    });
    expect(result.written).toBe(true);
    for (const f of before) {
      const path = join(layersDir, f);
      expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    }
  });
});
