/**
 * A seeded differential fuzz of merge-ort's rename handling against `git merge-tree
 * --write-tree --messages`: random histories built around rename/rename (1to2 and 2to1),
 * rename/add and rename/delete, mixed with whole and partial directory renames, merged
 * under `merge.directoryRenames` `true` and `conflict`. The result tree, the conflicted
 * index stages and the messages of our merge (ort-merge.ts, as `merge` runs it) are
 * compared with native git's.
 *
 * All histories go into one repository through `git fast-import`, so a seed costs one
 * `merge-tree` call. `ORT_RENAME_FUZZ_SEEDS=<n>` runs more seeds (default 300); a failure
 * names the seed, `ORT_RENAME_FUZZ_SEED=<seed>` replays one and
 * `ORT_RENAME_FUZZ_DEBUG=1` prints its history.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { flatTree, storeFlatTreeOver } from "../src/commands/merge-support.js";
import { ortResultEntries } from "../src/commands/ort-merge.js";
import { mergeStoredTrees, storedBase } from "../src/commands/ort-recursive.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** mulberry32: a small seeded PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}
type Rng = ReturnType<typeof prng>;
type Tree = Map<string, string>;

const DIRS = ["a", "b", "c", "c/d", "c/e"];
/** Where renamed directories and files go: few names, so that both sides meet */
const TARGET_DIRS = ["a", "b", "c/d", "n", "n/o", "m/k", ""];
const NAMES = ["f", "g", "h", "i"];
const TARGET_NAMES = ["f", "g", "t", "u"];

/** Unique lines (no two files alike: equal similarity scores tie in git's unstable sort) */
function content(tag: string, n = 8): string {
  return Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");
}

/**
 * The content with lines changed: one (well above the 50% similarity of a rename), or up
 * to four of the eight (around it)
 */
function edit(text: string, tag: string, changed = 1): string {
  const lines = text.split("\n");
  for (let k = 0; k < changed; k++)
    lines[Math.min(1 + 2 * k, lines.length - 2)] = `${tag} edited ${k}`;
  return lines.join("\n");
}

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join2 = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Whether `path` can be added to `t` (no file there, no file/directory clash) */
function free(t: Tree, path: string): boolean {
  for (const q of t.keys()) {
    if (q === path || q.startsWith(`${path}/`) || path.startsWith(`${q}/`)) return false;
  }
  return true;
}

function renameFile(rng: Rng, t: Tree, from: string, to: string, tag: string): boolean {
  if (!t.has(from) || !free(t, to)) return false;
  const text = t.get(from) as string;
  t.delete(from);
  const changed = rng.chance(0.6) ? 0 : rng.chance(0.6) ? 1 : 2 + rng.int(3);
  t.set(to, changed ? edit(text, tag, changed) : text);
  return true;
}

/**
 * Moves the files right in `from` to `to` (all, or all but one), or now and then the
 * whole subtree (`from/x/y` to `to/x/y`)
 */
function moveDir(rng: Rng, t: Tree, from: string, to: string, tag: string): void {
  const deep = rng.chance(0.3);
  const files = [...t.keys()].filter((p) => (deep ? p.startsWith(`${from}/`) : dirOf(p) === from));
  const kept = rng.chance(0.2) ? rng.pick(files) : undefined;
  for (const p of files) {
    if (p !== kept) renameFile(rng, t, p, join2(to, p.slice(from.length + 1)), tag);
  }
}

interface Plan {
  /** The kind of the history: what both sides are steered towards */
  kind: string;
  base: Tree;
  main: Tree;
  side: Tree;
  mode: "true" | "conflict";
}

/**
 * A random history for one seed: a base of a few directories, then one of the rename
 * conflicts (both sides renaming one file apart, two files renamed onto one path, a rename
 * meeting an addition or a deletion), a directory renamed on one side (or both) and some
 * noise: edits, additions into the renamed directories, more renames.
 */
function randomPlan(seed: number): Plan {
  const rng = prng(seed);
  const base: Tree = new Map();
  for (const dir of DIRS) {
    if (!rng.chance(0.75)) continue;
    for (const name of NAMES)
      if (rng.chance(0.6)) base.set(join2(dir, name), content(join2(dir, name)));
  }
  if (rng.chance(0.4)) base.set("top", content("top"));
  // now and then a big directory one side leaves alone and the other touches: merge-ort
  // defers it (possible_trivial_merges), reads it for the renames it needs and may redo
  // the merge with the renames it found (redo_after_renames)
  const big = rng.chance(0.25);
  if (big) for (let k = 0; k < 40; k++) base.set(`big/w/f${k}`, content(`big ${k}`, 3));
  if (base.size < 2) {
    base.set("a/f", content("a/f"));
    base.set("b/g", content("b/g"));
  }
  const main = new Map(base);
  const side = new Map(base);
  const sides: [Tree, string][] = [
    [main, "M"],
    [side, "S"],
  ];
  const files = () => [...base.keys()];
  const target = () => join2(rng.pick(TARGET_DIRS), rng.pick(TARGET_NAMES));
  const kind = rng.pick(["1to2", "2to1", "rename/add", "rename/delete", "mixed"]);
  const [one, two] = rng.chance(0.5) ? sides : [sides[1], sides[0]];

  // the directory renames first, so the file renames may land in a renamed directory
  const dirs = [...new Set(files().map(dirOf))].filter((d) => d);
  const dirMoves = rng.int(3);
  for (let k = 0; k < dirMoves && dirs.length > 0; k++) {
    const [t, tag] = k === 0 ? one : rng.pick(sides);
    const from = rng.pick(dirs);
    const to = rng.pick(
      TARGET_DIRS.filter(
        (d) => d !== from && !d.startsWith(`${from}/`) && !from.startsWith(`${d}/`),
      ),
    );
    moveDir(rng, t, from, to, tag);
  }

  /** Where `path` of the base is now on side `t` (followed through a renamed directory) */
  const current = (t: Tree, path: string) => {
    if (t.has(path)) return path;
    const text = base.get(path);
    for (const [p, c] of t) if (c === text || nameOf(p) === nameOf(path)) return p;
    return undefined;
  };
  const src = rng.pick(files());
  if (kind === "1to2" || kind === "mixed") {
    // one file renamed apart on both sides
    for (const [t, tag] of sides) {
      const from = current(t, src);
      if (from) renameFile(rng, t, from, target(), tag);
    }
  }
  if (kind === "2to1" || kind === "mixed") {
    // two files renamed onto one path
    const other = rng.pick(files().filter((p) => p !== src));
    const to = target();
    if (other) {
      const a = current(one[0], src);
      const b = current(two[0], other);
      if (a) renameFile(rng, one[0], a, to, one[1]);
      if (b) renameFile(rng, two[0], b, to, two[1]);
    }
  }
  if (kind === "rename/add" || (kind === "mixed" && rng.chance(0.5))) {
    const to = target();
    const from = current(one[0], src);
    if (from) renameFile(rng, one[0], from, to, one[1]);
    if (free(two[0], to)) two[0].set(to, content(`${two[1]} added ${to}`));
  }
  if (kind === "rename/delete" || (kind === "mixed" && rng.chance(0.5))) {
    const from = current(one[0], src);
    if (from) renameFile(rng, one[0], from, target(), one[1]);
    const gone = current(two[0], src);
    if (gone) two[0].delete(gone);
  }
  if (big) {
    const [t, tag] = rng.pick(sides);
    const f7 = t.get("big/w/f7");
    if (f7) t.set("big/w/f7", edit(f7, tag));
    if (rng.chance(0.5)) renameFile(rng, t, "big/w/f3", target(), tag);
  }
  // noise: additions into the old directories (where a directory rename moves them),
  // edits, deletions, renames
  for (const [t, tag] of sides) {
    const noise = rng.int(4);
    for (let k = 0; k < noise; k++) {
      const op = rng.int(5);
      const paths = [...t.keys()];
      if (op <= 1) {
        const path = join2(rng.pick([...DIRS, ...TARGET_DIRS]), `${rng.pick(NAMES)}${tag}${k}`);
        if (free(t, path)) t.set(path, content(`${tag} new ${path}`));
      } else if (op === 2 && paths.length > 0) {
        const p = rng.pick(paths);
        t.set(p, edit(t.get(p) as string, `${tag}${k}`));
      } else if (op === 3 && paths.length > 1) {
        t.delete(rng.pick(paths));
      } else if (paths.length > 0) {
        renameFile(rng, t, rng.pick(paths), target(), `${tag}${k}`);
      }
    }
  }
  return { kind, base, main, side, mode: rng.pick(["true", "conflict"] as const) };
}

/** A `git fast-import` commit holding `tree` whole. */
function commitStream(ref: string, mark: number, tree: Tree, parent?: number): string {
  let out = `commit ${ref}\nmark :${mark}\ncommitter T <t@e> 1112911993 +0000\ndata 1\nc\n`;
  if (parent) out += `from :${parent}\n`;
  out += "deleteall\n";
  for (const [p, c] of tree) {
    out += `M 100644 inline ${p}\ndata ${Buffer.byteLength(c)}\n${c}\n`;
  }
  return `${out}\n`;
}

/** What one side of the comparison says about a merge. */
interface Outcome {
  tree: string;
  stages: string[];
  messages: string[];
}

/** Native merge-tree's output parsed: tree, conflicted stages, messages. */
function parseMergeTree(stdout: string): Outcome {
  const lines = stdout.split("\n");
  const tree = lines[0];
  const stages: string[] = [];
  let k = 1;
  for (; k < lines.length && lines[k] !== ""; k++) stages.push(lines[k]);
  const messages = lines.slice(k + 1).filter((l) => l !== "");
  return { tree, stages, messages };
}

/** Native git's version as [major, minor] (git on PATH). */
function nativeVersion(): [number, number] {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  const m = /(\d+)\.(\d+)/.exec(r.stdout ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/**
 * git 2.52 changed two directory rename cases ours follows: a path an implicit directory
 * rename moves onto a base file is in the way unless that file is its own rename source
 * (path_in_way, t6423 12[npq]), and a rename a directory rename moves back onto its source
 * stays where it is (process_renames' rename-to-self). Older versions differ there.
 */
function knownOldGitDifference(ours: Outcome, native: Outcome): boolean {
  const inWay = (m: string) => m.includes("in the way of implicit directory rename");
  if (ours.messages.some((m) => inWay(m) && !native.messages.includes(m))) return true;
  const toSelf =
    /^(?:CONFLICT \(file location\)|Path updated): (\S+) renamed to \S+ in \S+, inside a directory that was renamed in \S+[,;] (?:suggesting it should perhaps be moved|moving it) to \1\.$/;
  return native.messages.some((m) => toSelf.test(m));
}

const gitVersion = nativeGitAvailable() ? nativeVersion() : ([0, 0] as [number, number]);
const gitAtLeast252 = gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 52);

/**
 * Builds every plan in a fresh repository (one fast-import), merges each with native
 * `merge-tree` and with ours, and returns what differs.
 */
async function compareMerges(
  root: string,
  plans: Map<string, Plan>,
): Promise<{ failures: string[]; tolerated: number; conflicted: Map<string, number> }> {
  const repo = mkdtempSync(join(root, "r"));
  const env = nativeGitEnv(root);
  const git = (args: string[], input?: string) =>
    spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  let stream = "";
  let mark = 0;
  for (const [name, plan] of plans) {
    stream += commitStream(`refs/heads/b${name}`, ++mark, plan.base);
    const base = mark;
    stream += commitStream(`refs/heads/m${name}`, ++mark, plan.main, base);
    stream += commitStream(`refs/heads/s${name}`, ++mark, plan.side, base);
  }
  const imported = git(["fast-import", "--quiet"], stream);
  if (imported.status !== 0) throw new Error(`fast-import: ${imported.stderr}`);

  const files = createNodeFilesApi({ rootDir: repo });
  const { history } = await createGitFilesBackend({ files });
  // the command layer's tree aliases (git-command.ts wrapTrees)
  const trees = Object.assign(history.trees, {
    loadTree: async function* (id: string) {
      const entries = await history.trees.load(id);
      if (entries) yield* entries;
    },
    storeTree: (entries: Parameters<typeof history.trees.store>[0]) => history.trees.store(entries),
  });
  const ctx = { trees, blobs: history.blobs };
  const commitTree = async (ref: string) => {
    const id = (await history.refs.resolve(`refs/heads/${ref}`))?.objectId as string;
    return (await history.commits.load(id))?.tree as string;
  };

  const failures: string[] = [];
  const conflicted = new Map<string, number>();
  let tolerated = 0;
  for (const [name, plan] of plans) {
    if (process.env.ORT_RENAME_FUZZ_DEBUG) {
      console.log(name, plan.kind, plan.mode, JSON.stringify([...plan.base.keys()]));
      console.log(" main", JSON.stringify([...plan.main.keys()]));
      console.log(" side", JSON.stringify([...plan.side.keys()]));
    }
    const [ours, theirs] = [`m${name}`, `s${name}`];
    const r = git([
      "-c",
      `merge.directoryRenames=${plan.mode}`,
      "merge-tree",
      "--write-tree",
      "--messages",
      ours,
      theirs,
    ]);
    if (r.status !== 0 && r.status !== 1) {
      // older versions trip over some of these histories (fixed by 2.52)
      if (!gitAtLeast252 && r.stderr.includes("Assertion")) {
        tolerated++;
        continue;
      }
      failures.push(`${name}: merge-tree failed: ${r.stderr}`);
      continue;
    }
    const native = parseMergeTree(r.stdout);

    const [bt, ot, tt] = [
      await commitTree(`b${name}`),
      await commitTree(ours),
      await commitTree(theirs),
    ];
    const merge = await mergeStoredTrees(
      ctx,
      storedBase(bt, `b${name}`, () => flatTree(trees, bt)),
      ot,
      tt,
      { oursLabel: ours, theirsLabel: theirs, directoryRenames: plan.mode },
    );
    const target = await ortResultEntries(history.blobs, merge);
    const tree = await storeFlatTreeOver(trees, ot, merge.ours, target);
    const stages: string[] = [];
    const byPath = [...merge.conflicts.values()].sort((x, y) =>
      x.stagePath < y.stagePath ? -1 : x.stagePath > y.stagePath ? 1 : 0,
    );
    for (const c of byPath) {
      for (const [stage, e] of [c.base, c.ours, c.theirs].entries()) {
        if (!e) continue;
        const mode = e.mode.toString(8).padStart(6, "0");
        stages.push(`${mode} ${e.objectId} ${stage + 1}\t${c.stagePath}`);
      }
    }
    const ourOutcome: Outcome = { tree, stages, messages: merge.messages };
    if (merge.messages.some((m) => m.startsWith("CONFLICT"))) {
      conflicted.set(plan.kind, (conflicted.get(plan.kind) ?? 0) + 1);
    }
    const diffs: string[] = [];
    for (const key of ["tree", "stages", "messages"] as const) {
      if (JSON.stringify(ourOutcome[key]) !== JSON.stringify(native[key])) {
        const [o, n] = [JSON.stringify(ourOutcome[key]), JSON.stringify(native[key])];
        diffs.push(`${key}:\n  ours   ${o}\n  native ${n}`);
      }
    }
    if (diffs.length === 0) continue;
    if (!gitAtLeast252 && knownOldGitDifference(ourOutcome, native)) tolerated++;
    else failures.push(`${name} (${plan.kind}, ${plan.mode}): ${diffs.join("\n")}`);
  }
  if (!process.env.ORT_RENAME_FUZZ_KEEP) rmSync(repo, { recursive: true, force: true });
  return { failures, tolerated, conflicted };
}

/**
 * A plan from path lists: the base files (each one's content names its path), then each
 * side's changes as `{ to: from }` (a rename), `{ path: "" }` (a deletion) or
 * `{ path: "new" }` (an addition).
 */
function fixedPlan(
  base: string[],
  main: Record<string, string>,
  side: Record<string, string>,
  mode: Plan["mode"],
): Plan {
  const tree = new Map(base.map((p) => [p, content(p)]));
  const apply = (changes: Record<string, string>) => {
    const t = new Map(tree);
    for (const [to, from] of Object.entries(changes)) {
      if (from === "") t.delete(to);
      else if (from === "new") t.set(to, content(`new ${to}`));
      else {
        t.set(to, tree.get(from) as string);
        t.delete(from);
      }
    }
    return t;
  };
  return { kind: "fixed", base: tree, main: apply(main), side: apply(side), mode };
}

const count = Number(process.env.ORT_RENAME_FUZZ_SEEDS ?? 300);
const start = Number(process.env.ORT_RENAME_FUZZ_START ?? 20000);
const only = process.env.ORT_RENAME_FUZZ_SEED;
const seeds = only ? [Number(only)] : Array.from({ length: count }, (_, i) => start + i);

describeGit("merge-ort renames fuzz against git merge-tree", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ort-rename-fuzz-"));
  });
  afterAll(() => {
    if (process.env.ORT_RENAME_FUZZ_KEEP) console.log("kept", root);
    else rmSync(root, { recursive: true, force: true });
  });

  it("rename conflicts with directory renames merge as native merge-tree merges them", async () => {
    const plans = new Map(seeds.map((seed) => [String(seed), randomPlan(seed)]));
    const { failures, tolerated, conflicted } = await compareMerges(root, plans);
    if (process.env.ORT_RENAME_FUZZ_STATS) {
      console.log("conflicted by kind", Object.fromEntries(conflicted), "tolerated", tolerated);
    }
    expect(failures).toEqual([]);
  }, 900_000);

  // older versions resolve these the old way (knownOldGitDifference)
  it.skipIf(!gitAtLeast252)("the directory rename cases git 2.52 changed", async () => {
    const plans = new Map<string, Plan>();
    for (const mode of ["true", "conflict"] as const) {
      // main renames b/i to a/i, side renames a/ to b/: a/i goes back to b/i (rename-to-self)
      plans.set(
        `self-${mode}`,
        fixedPlan(["a/h", "b/h", "b/i", "top"], { "a/i": "b/i" }, { "b/g": "a/h" }, mode),
      );
      // main deletes a/f and adds b/f, side renames b/ to a/: a/f (side's, as in the base)
      // is in the way of b/f
      plans.set(
        `in-way-${mode}`,
        fixedPlan(
          ["a/f", "a/g", "b/i", "top"],
          { "a/f": "", "b/f": "new" },
          { "a/i": "b/i" },
          mode,
        ),
      );
    }
    const { failures } = await compareMerges(root, plans);
    expect(failures).toEqual([]);
  });
});
