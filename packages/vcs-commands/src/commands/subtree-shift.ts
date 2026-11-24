/**
 * git's subtree shift (match-trees.c), which `-s subtree` and `-X subtree[=<path>]` apply to
 * a merge's other side and its base before merge-ort reads them: a tree that matches a
 * subdirectory of ours is shifted down into it (ours' tree with that directory replaced),
 * a tree whose subdirectory matches ours is shifted up to it.
 *
 * ```ts
 * const shifted = await shiftTree(trees, oursTree, theirsTree); // -s subtree
 * const byPath = await shiftTreeBy(trees, oursTree, theirsTree, "git-gui"); // -X subtree=git-gui
 * ```
 *
 * Trees are given by id, `undefined` for the empty tree; a shift down stores the spliced
 * trees, as git writes them.
 */

import type { ObjectId, TreeEntry } from "@statewalker/vcs-core";

import type { CommandTrees } from "../git-command.js";

const S_IFMT = 0o170000;
const isDir = (mode: number) => (mode & S_IFMT) === 0o040000;
const isLink = (mode: number) => (mode & S_IFMT) === 0o120000;

function scoreMissing(mode: number): number {
  if (isDir(mode)) return -1000;
  if (isLink(mode)) return -500;
  return -50;
}

function scoreDiffers(m1: number, m2: number): number {
  if (isDir(m1) !== isDir(m2)) return -100;
  if (isLink(m1) !== isLink(m2)) return -50;
  return -5;
}

function scoreMatches(m1: number, m2: number): number {
  if (isDir(m1) !== isDir(m2)) return -100;
  if (isLink(m1) !== isLink(m2)) return -50;
  if (isDir(m1)) return 1000;
  if (isLink(m1)) return 500;
  return 250;
}

const encoder = new TextEncoder();

/** git's base_name_compare: names compared as bytes, a directory's as if `/` followed it. */
function baseNameCompare(a: TreeEntry, b: TreeEntry): number {
  const x = encoder.encode(a.name);
  const y = encoder.encode(b.name);
  const len = Math.min(x.length, y.length);
  for (let i = 0; i < len; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const c1 = x.length > len ? x[len] : isDir(a.mode) ? 0x2f : 0;
  const c2 = y.length > len ? y[len] : isDir(b.mode) ? 0x2f : 0;
  return c1 - c2;
}

async function entries(trees: CommandTrees, id: ObjectId | undefined): Promise<TreeEntry[]> {
  if (id === undefined) return [];
  const out: TreeEntry[] = [];
  for await (const entry of trees.loadTree(id)) out.push(entry);
  return out.sort(baseNameCompare);
}

/** match-trees.c's score_trees: how alike two trees are. */
async function scoreTrees(
  trees: CommandTrees,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
): Promise<number> {
  const a = await entries(trees, one);
  const b = await entries(trees, two);
  let score = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const cmp = i < a.length && j < b.length ? baseNameCompare(a[i], b[j]) : i < a.length ? -1 : 1;
    if (cmp < 0) score += scoreMissing(a[i++].mode);
    else if (cmp > 0) score += scoreMissing(b[j++].mode);
    else {
      score +=
        a[i].id !== b[j].id
          ? scoreDiffers(a[i].mode, b[j].mode)
          : scoreMatches(a[i].mode, b[j].mode);
      i++;
      j++;
    }
  }
  return score;
}

/** match-trees.c's match_trees: the subtree of `one` (recursing) that best matches `two`. */
async function matchTrees(
  trees: CommandTrees,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
  best: { score: number; match: string },
  base: string,
  recurseLimit: number,
): Promise<void> {
  for (const entry of await entries(trees, one)) {
    if (!isDir(entry.mode)) continue;
    const score = await scoreTrees(trees, entry.id, two);
    if (best.score < score) {
      best.match = `${base}${entry.name}`;
      best.score = score;
    }
    if (recurseLimit) {
      await matchTrees(trees, entry.id, two, best, `${base}${entry.name}/`, recurseLimit - 1);
    }
  }
}

/** get_tree_entry: the entry at `path` in tree `id`, undefined when a component is missing. */
async function treeEntryAt(
  trees: CommandTrees,
  id: ObjectId | undefined,
  path: string,
): Promise<{ id: ObjectId; mode: number } | undefined> {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  let current: { id: ObjectId; mode: number } | undefined;
  let tree = id;
  for (const [k, name] of parts.entries()) {
    const entry = (await entries(trees, tree)).find((e) => e.name === name);
    if (!entry) return undefined;
    current = { id: entry.id, mode: entry.mode };
    if (k < parts.length - 1) {
      if (!isDir(entry.mode)) return undefined;
      tree = entry.id;
    }
  }
  return current;
}

/** match-trees.c's splice_tree: tree `one` with its directory at `prefix` replaced by `two`. */
async function spliceTree(
  trees: CommandTrees,
  one: ObjectId | undefined,
  prefix: string,
  two: ObjectId | undefined,
  emptyTree: () => Promise<ObjectId>,
): Promise<ObjectId> {
  const slash = prefix.indexOf("/");
  const top = slash < 0 ? prefix : prefix.slice(0, slash);
  const sub = slash < 0 ? "" : prefix.slice(slash + 1);
  const list = await entries(trees, one);
  const at = list.findIndex((e) => e.name === top);
  if (at < 0) throw new Error(`entry ${top} not found in tree ${one ?? ""}`);
  const found = list[at];
  if (!isDir(found.mode)) throw new Error(`entry ${top} in tree ${one ?? ""} is not a tree`);
  const replacement = sub
    ? await spliceTree(trees, found.id, sub, two, emptyTree)
    : (two ?? (await emptyTree()));
  list[at] = { ...found, id: replacement };
  return trees.storeTree(list);
}

/**
 * match-trees.c's shift_tree: `two` shifted to match the shape of `one` (`-s subtree`,
 * `-X subtree`), as the id of the tree merge-ort then reads.
 */
export async function shiftTree(
  trees: CommandTrees,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
  emptyTree: () => Promise<ObjectId>,
  depthLimit = 2,
): Promise<ObjectId | undefined> {
  const initial = await scoreTrees(trees, one, two);
  const add = { score: initial, match: "" };
  const del = { score: initial, match: "" };
  await matchTrees(trees, one, two, add, "", depthLimit);
  await matchTrees(trees, two, one, del, "", depthLimit);
  if (add.score < del.score) {
    // a subtree of two
    if (!del.match) return two;
    const entry = await treeEntryAt(trees, two, del.match);
    if (!entry) throw new Error(`cannot find path ${del.match} in tree ${two ?? ""}`);
    return entry.id;
  }
  if (!add.match) return two;
  return spliceTree(trees, one, add.match, two, emptyTree);
}

/**
 * match-trees.c's shift_tree_by: `two` shifted by `prefix` (`-X subtree=<path>`), down when
 * `one` holds a directory there (and that matches better), up when `two` does.
 */
export async function shiftTreeBy(
  trees: CommandTrees,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
  prefix: string,
  emptyTree: () => Promise<ObjectId>,
): Promise<ObjectId | undefined> {
  const sub1 = await treeEntryAt(trees, one, prefix);
  const sub2 = await treeEntryAt(trees, two, prefix);
  let candidate = 0;
  if (sub1 && isDir(sub1.mode)) candidate |= 1;
  if (sub2 && isDir(sub2.mode)) candidate |= 2;
  if (candidate === 3) {
    let best = await scoreTrees(trees, one, two);
    candidate = 0;
    let score = await scoreTrees(trees, sub1?.id, two);
    if (score > best) {
      candidate = 1;
      best = score;
    }
    score = await scoreTrees(trees, sub2?.id, one);
    if (score > best) candidate = 2;
  }
  if (!candidate) return two;
  if (candidate === 1) return spliceTree(trees, one, prefix, two, emptyTree);
  return sub2?.id;
}
