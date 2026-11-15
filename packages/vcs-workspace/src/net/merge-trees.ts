/**
 * The three-way merge of a workspace sync: path by path over flat trees, and line by line
 * (`mergeLines` of `@statewalker/vcs-utils`: byte-preserving, git's markers) for text files both
 * sides changed. A conflict is never resolved silently: the file keeps both sides — markers
 * for text, the other side next to it for binary content, the changed side for a change
 * against a deletion — and its path is reported. With several merge bases (a criss-cross), the
 * bases are first merged into a virtual base, recursively, as git's recursive strategy does.
 */

import { type History, type ObjectId, probeBlob } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import {
  type FlatEntry,
  type FlatTree,
  MODE_EXECUTABLE,
  MODE_FILE,
  readCommitTree,
  sameEntry,
} from "./flat-tree.js";

/** What {@link mergeFlatTrees} produced. */
export interface FlatMergeResult {
  /** The merged files (conflicting paths hold both sides, as described above) */
  files: FlatTree;
  /** The paths that conflicted, sorted */
  conflicts: string[];
}

/** How the two sides are named in markers and in the names of moved-aside files. */
export interface MergeLabels {
  /** After `<<<<<<<` (default `ours`) */
  oursLabel?: string;
  /** After `>>>>>>>` (default `theirs`) */
  theirsLabel?: string;
  /** Suffix of our files moved aside: `<path>.<oursTag>` (default `ours`) */
  oursTag?: string;
  /** Suffix of their files moved aside: `<path>.<theirsTag>` (default `theirs`) */
  theirsTag?: string;
  /**
   * Merging merge bases into a virtual base: binary conflicts keep our side only (nothing is
   * moved aside), as git does for the inner merges of its recursive strategy
   */
  virtual?: boolean;
}

const TEXT_MODES = new Set([MODE_FILE, MODE_EXECUTABLE]);

async function loadText(history: History, entry: FlatEntry | undefined) {
  if (!entry) return new Uint8Array(0);
  if (!TEXT_MODES.has(entry.mode)) return undefined;
  const probe = await probeBlob(history.blobs, entry.id, { loadText: true });
  return probe.binary ? undefined : probe.content;
}

/** A name for a file moved aside that no tree involved holds: `<path>.<tag>`, `-2`, ... */
function uniqueName(path: string, tag: string, taken: Set<string>): string {
  let name = `${path}.${tag}`;
  for (let n = 2; taken.has(name) || taken.has(name.toLowerCase()); n++) {
    name = `${path}.${tag}-${n}`;
  }
  taken.add(name);
  taken.add(name.toLowerCase());
  return name;
}

/** Merges `ours` and `theirs` against their common ancestor `base`. */
export async function mergeFlatTrees(
  history: History,
  base: FlatTree,
  ours: FlatTree,
  theirs: FlatTree,
  labels: MergeLabels = {},
): Promise<FlatMergeResult> {
  const oursTag = labels.oursTag ?? "ours";
  const theirsTag = labels.theirsTag ?? "theirs";
  const files: FlatTree = new Map();
  const conflicts = new Set<string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const taken = new Set<string>();
  for (const p of paths) {
    taken.add(p);
    taken.add(p.toLowerCase());
  }
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (sameEntry(o, b) || sameEntry(o, t)) {
      if (t) files.set(path, t);
      continue;
    }
    if (sameEntry(t, b)) {
      if (o) files.set(path, o);
      continue;
    }
    // both sides changed the path, differently
    if (!o || !t) {
      // a change against a deletion: the change is kept
      files.set(path, (o ?? t) as FlatEntry);
      conflicts.add(path);
      continue;
    }
    if (o.id === t.id) {
      // same content, different modes: our mode, reported
      files.set(path, o);
      conflicts.add(path);
      continue;
    }
    const [bt, ot, tt] = [
      await loadText(history, b),
      await loadText(history, o),
      await loadText(history, t),
    ];
    if (bt && ot && tt) {
      const merged = mergeLines(bt, ot, tt, {
        oursLabel: labels.oursLabel ?? "ours",
        theirsLabel: labels.theirsLabel ?? "theirs",
      });
      const id = await history.blobs.store([merged.content]);
      // a mode change on one side only is kept
      const mode = o.mode === b?.mode ? t.mode : o.mode;
      files.set(path, { id, mode });
      if (merged.conflicts > 0 || o.mode !== t.mode) conflicts.add(path);
      continue;
    }
    // binary (or not a regular file): both kept, theirs beside ours
    files.set(path, o);
    if (!labels.virtual) files.set(uniqueName(path, theirsTag, taken), t);
    conflicts.add(path);
  }
  // a path that is a file on one side and a directory on the other: the file moves aside
  for (const path of [...files.keys()].sort()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const file = files.get(dir);
      if (!file) continue;
      files.delete(dir);
      const fromOurs = sameEntry(ours.get(dir), file);
      files.set(uniqueName(dir, fromOurs ? oursTag : theirsTag, taken), file);
      conflicts.add(dir);
    }
  }
  return { files, conflicts: [...conflicts].sort() };
}

/**
 * The best common ancestors of two sets of commits (git's `merge-base --all` for `a` and `b`):
 * the common ancestors no other common ancestor descends from, sorted.
 */
export async function findMergeBases(
  history: History,
  a: ObjectId[],
  b: ObjectId[],
): Promise<ObjectId[]> {
  const ancestors = async (heads: ObjectId[]) => {
    const seen = new Set<ObjectId>();
    const queue = [...heads];
    while (queue.length > 0) {
      const id = queue.pop() as ObjectId;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of await history.commits.getParents(id)) if (!seen.has(p)) queue.push(p);
    }
    return seen;
  };
  const fromA = await ancestors(a);
  const fromB = await ancestors(b);
  const common = [...fromA].filter((id) => fromB.has(id));
  // a common ancestor reachable from another one's parents is not a best one
  const covered = new Set<ObjectId>();
  const queue: ObjectId[] = [];
  for (const id of common) queue.push(...(await history.commits.getParents(id)));
  while (queue.length > 0) {
    const id = queue.pop() as ObjectId;
    if (covered.has(id)) continue;
    covered.add(id);
    queue.push(...(await history.commits.getParents(id)));
  }
  return common.filter((id) => !covered.has(id)).sort();
}

/** One side of a recursive merge: the commits whose history it holds, and its files. */
export interface MergeSide {
  heads: ObjectId[];
  files: FlatTree;
}

const MAX_RECURSION = 16;

/**
 * Merges two sides against their best common ancestors, as git's recursive strategy: one base
 * is used as it is; several are merged with each other first (recursively, conflicts kept in
 * the virtual base), and that virtual base is the base of the merge.
 */
export async function mergeRecursive(
  history: History,
  ours: MergeSide,
  theirs: MergeSide,
  labels: MergeLabels = {},
  depth = 0,
): Promise<FlatMergeResult & { bases: ObjectId[] }> {
  if (depth > MAX_RECURSION) throw new Error("merge bases nest too deep");
  const bases = await findMergeBases(history, ours.heads, theirs.heads);
  let base: FlatTree = new Map();
  if (bases.length > 0) {
    let acc: MergeSide = {
      heads: [bases[0]],
      files: (await readCommitTree(history, bases[0])).files,
    };
    for (const next of bases.slice(1)) {
      const other: MergeSide = {
        heads: [next],
        files: (await readCommitTree(history, next)).files,
      };
      const inner = await mergeRecursive(
        history,
        acc,
        other,
        {
          oursLabel: "Temporary merge branch 1",
          theirsLabel: "Temporary merge branch 2",
          virtual: true,
        },
        depth + 1,
      );
      acc = { heads: [...acc.heads, next], files: inner.files };
    }
    base = acc.files;
  }
  const merged = await mergeFlatTrees(history, base, ours.files, theirs.files, labels);
  return { ...merged, bases };
}
