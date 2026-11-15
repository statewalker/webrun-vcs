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
 * Whether text still holds a conflict marker line: a line starting with seven `<` or seven
 * `>` followed by a space or the line's end (git's `<<<<<<< ours` / `>>>>>>> theirs`). The
 * `=======` separator alone is not taken for one, since Markdown underlines headings with it.
 * Binary content (a NUL in the first 8000 bytes, as git decides it) never holds markers.
 *
 * @example
 * ```ts
 * hasConflictMarkers(new TextEncoder().encode("<<<<<<< main\na\n=======\nb\n>>>>>>> x\n")); // true
 * ```
 */
export function hasConflictMarkers(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return false;
  const LT = 0x3c;
  const GT = 0x3e;
  for (let start = 0; start < bytes.length; ) {
    const c = bytes[start];
    if (c === LT || c === GT) {
      let n = 0;
      while (n < 7 && bytes[start + n] === c) n++;
      const next = bytes[start + 7];
      if (n === 7 && (next === undefined || next === 0x20 || next === 0x0a || next === 0x0d)) {
        return true;
      }
    }
    const eol = bytes.indexOf(0x0a, start);
    if (eol < 0) break;
    start = eol + 1;
  }
  return false;
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
  const graph = commitGraph(history);
  const candidates = await paintDownToCommon(graph, a, b);
  if (candidates.length < 2) return candidates;
  // git's remove_redundant: a candidate another candidate descends from is not a best one.
  // Exact reachability, no date cutoff: commit dates may be skewed. Several candidates only
  // happen in criss-cross histories, so this walk is rare.
  const redundant = new Set<ObjectId>();
  for (const c of candidates) {
    if (redundant.has(c)) continue;
    const others = candidates.filter((o) => o !== c && !redundant.has(o));
    for (const reached of await reachable(graph, c, new Set(others))) redundant.add(reached);
  }
  return candidates.filter((c) => !redundant.has(c)).sort();
}

interface CommitInfo {
  parents: ObjectId[];
  /** Committer time (seconds) */
  time: number;
}

/** Commit parents and times, each commit read once. */
function commitGraph(history: History): (id: ObjectId) => Promise<CommitInfo> {
  const cache = new Map<ObjectId, Promise<CommitInfo>>();
  return (id) => {
    let info = cache.get(id);
    if (!info) {
      info = history.commits.load(id).then((c) => {
        if (!c) throw new Error(`commit ${id} is missing`);
        return { parents: c.parents, time: c.committer.timestamp };
      });
      cache.set(id, info);
    }
    return info;
  };
}

/** A queue of commits, newest first (git's date-ordered commit queue). */
class DateQueue {
  private items: { id: ObjectId; time: number; seq: number }[] = [];
  private seq = 0;
  get size() {
    return this.items.length;
  }
  some(test: (id: ObjectId) => boolean): boolean {
    return this.items.some((item) => test(item.id));
  }
  push(id: ObjectId, time: number) {
    const items = this.items;
    items.push({ id, time, seq: this.seq++ });
    for (let i = items.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (!this.before(items[i], items[up])) break;
      [items[i], items[up]] = [items[up], items[i]];
      i = up;
    }
  }
  pop(): ObjectId | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.before(items[l], items[m])) m = l;
        if (r < items.length && this.before(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top?.id;
  }
  private before(x: { time: number; seq: number }, y: { time: number; seq: number }) {
    return x.time > y.time || (x.time === y.time && x.seq < y.seq);
  }
}

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;

/**
 * git's paint_down_to_common: walks both sides newest first, painting each commit with the
 * sides it is reached from; a commit painted by both is a common ancestor, and everything
 * below it is stale. The walk ends when only stale commits are queued, so it reads the
 * history down to the merge bases, not all of it.
 */
async function paintDownToCommon(
  graph: (id: ObjectId) => Promise<CommitInfo>,
  one: ObjectId[],
  two: ObjectId[],
): Promise<ObjectId[]> {
  const flags = new Map<ObjectId, number>();
  const queue = new DateQueue();
  const paint = async (id: ObjectId, add: number) => {
    const had = flags.get(id) ?? 0;
    if ((had & add) === add) return;
    flags.set(id, had | add);
    queue.push(id, (await graph(id)).time);
  };
  for (const id of one) await paint(id, PARENT1);
  for (const id of two) await paint(id, PARENT2);
  const result: ObjectId[] = [];
  const live = (id: ObjectId) => !((flags.get(id) ?? 0) & STALE);
  while (queue.size > 0 && queue.some(live)) {
    const id = queue.pop() as ObjectId;
    const f = flags.get(id) ?? 0;
    let down = f & (PARENT1 | PARENT2 | STALE);
    if ((f & (PARENT1 | PARENT2)) === (PARENT1 | PARENT2)) {
      if (!(f & RESULT)) {
        flags.set(id, f | RESULT);
        result.push(id);
      }
      down |= STALE;
    }
    for (const parent of (await graph(id)).parents) await paint(parent, down);
  }
  return result.filter(live);
}

/** Which of `targets` are ancestors of `from` (the walk ends once all are found). */
async function reachable(
  graph: (id: ObjectId) => Promise<CommitInfo>,
  from: ObjectId,
  targets: Set<ObjectId>,
): Promise<ObjectId[]> {
  const found: ObjectId[] = [];
  const seen = new Set<ObjectId>([from]);
  const stack = [...(await graph(from)).parents];
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    if (seen.has(id)) continue;
    seen.add(id);
    if (targets.has(id)) {
      found.push(id);
      if (found.length === targets.size) break;
    }
    stack.push(...(await graph(id)).parents);
  }
  return found;
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
