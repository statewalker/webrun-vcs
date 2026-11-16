/**
 * The index's cache-tree (`TREE` extension): for each directory of the index, the tree
 * object its entries make and how many entries that is, so a commit need not hash every
 * directory again.
 *
 * ```typescript
 * // after a merge switched the index to `result` (stored), with a conflict at a.txt
 * const tree = await cacheTreeOfTree(trees, result);
 * invalidateCacheTreePath(tree, "a.txt");
 * staging.setCacheTree?.(tree);
 * await staging.write(); // the index carries TREE, as native git writes it
 * ```
 *
 * The layout is git's (`cache-tree.c`, `write_one`): per node, its name (empty for the root),
 * NUL, the entry count in decimal (-1: invalid), a space, the number of subtrees, a newline,
 * then the 20-byte tree id when valid; the subtrees follow, ordered by name length first and
 * then by bytes (`subtree_name_cmp`).
 */
import { FileMode, type ObjectId, objectIdToBytes, type Trees } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils";

/** One directory of a cache-tree. */
export interface CacheTree {
  /** The index entries under this directory, recursively; -1 when the node is invalid. */
  entryCount: number;
  /** The tree object of a valid node. */
  id?: ObjectId;
  /** The directories below, in git's order (see `compareSubtreeNames`). */
  subtrees: { name: string; tree: CacheTree }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** git's `subtree_name_cmp`: shorter names first, then bytes. */
function compareSubtreeNames(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The cache-tree of an index that holds exactly the stored tree `treeId` (every node valid),
 * as git's `cache_tree_update` computes it for such an index.
 */
export async function cacheTreeOfTree(
  trees: Pick<Trees, "load">,
  treeId: ObjectId,
): Promise<CacheTree> {
  const node: CacheTree = { entryCount: 0, id: treeId, subtrees: [] };
  const entries = await trees.load(treeId);
  if (!entries) throw new Error(`tree ${treeId} not found`);
  const dirs: { name: string; id: ObjectId }[] = [];
  for await (const entry of entries) {
    if (entry.mode === FileMode.TREE) dirs.push({ name: entry.name, id: entry.id });
    else node.entryCount++;
  }
  for (const dir of dirs) {
    const tree = await cacheTreeOfTree(trees, dir.id);
    node.entryCount += tree.entryCount;
    node.subtrees.push({ name: dir.name, tree });
  }
  node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
  return node;
}

/**
 * The cache-tree of an index that holds exactly the stored tree `treeId`, from `previous`
 * (the index's cache-tree before, the paths that changed invalidated): a valid node whose
 * tree is still the one there is kept without reading it, as `cache_tree_update` keeps the
 * valid nodes and computes the others. Only the trees under invalid nodes are read.
 */
export async function updateCacheTree(
  trees: Pick<Trees, "load">,
  treeId: ObjectId,
  previous: CacheTree | undefined,
): Promise<CacheTree> {
  if (!previous) return cacheTreeOfTree(trees, treeId);
  if (previous.entryCount >= 0 && previous.id === treeId) return copyCacheTree(previous);
  const entries = await trees.load(treeId);
  if (!entries) throw new Error(`tree ${treeId} not found`);
  const node: CacheTree = { entryCount: 0, id: treeId, subtrees: [] };
  const dirs: { name: string; id: ObjectId }[] = [];
  for await (const entry of entries) {
    if (entry.mode === FileMode.TREE) dirs.push({ name: entry.name, id: entry.id });
    else node.entryCount++;
  }
  for (const dir of dirs) {
    const before = previous.subtrees.find((s) => s.name === dir.name)?.tree;
    const tree = await updateCacheTree(trees, dir.id, before);
    node.entryCount += tree.entryCount;
    node.subtrees.push({ name: dir.name, tree });
  }
  node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
  return node;
}

/** A deep copy, to change without touching `tree`. */
export function copyCacheTree(tree: CacheTree): CacheTree {
  return {
    entryCount: tree.entryCount,
    ...(tree.id ? { id: tree.id } : {}),
    subtrees: tree.subtrees.map((s) => ({ name: s.name, tree: copyCacheTree(s.tree) })),
  };
}

/**
 * Invalidate `path` (a file's path) as git's `cache_tree_invalidate_path`: every directory
 * on the way is invalid, and a subtree of the file's own name goes.
 */
export function invalidateCacheTreePath(tree: CacheTree, path: string): void {
  let node: CacheTree | undefined = tree;
  let rest = path;
  while (node) {
    node.entryCount = -1;
    node.id = undefined;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      node.subtrees = node.subtrees.filter((s) => s.name !== rest);
      return;
    }
    const name = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
    node = node.subtrees.find((s) => s.name === name)?.tree;
  }
}

/**
 * Mark the directories holding an intent-to-add entry at `path` invalid, up to the root, as
 * `cache_tree_update` leaves them (such an entry is in the index, not in the tree); a
 * directory only such entries make is added, invalid.
 */
export function invalidateCacheTreeForIntentToAdd(tree: CacheTree, path: string): void {
  let node = tree;
  const parts = path.split("/");
  parts.pop();
  node.entryCount = -1;
  node.id = undefined;
  for (const name of parts) {
    let sub = node.subtrees.find((s) => s.name === name)?.tree;
    if (!sub) {
      sub = { entryCount: -1, subtrees: [] };
      node.subtrees.push({ name, tree: sub });
      node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
    }
    sub.entryCount = -1;
    sub.id = undefined;
    node = sub;
  }
}

/** Whether every node is valid (git's `cache_tree_fully_valid`, without the object lookup). */
export function cacheTreeFullyValid(tree: CacheTree): boolean {
  if (tree.entryCount < 0 || !tree.id) return false;
  return tree.subtrees.every((s) => cacheTreeFullyValid(s.tree));
}

/** The `TREE` extension payload of `tree`. */
export function encodeCacheTree(tree: CacheTree): Uint8Array {
  const parts: Uint8Array[] = [];
  const write = (name: string, node: CacheTree) => {
    parts.push(enc.encode(`${name}\0${node.entryCount} ${node.subtrees.length}\n`));
    if (node.entryCount >= 0 && node.id) parts.push(objectIdToBytes(node.id));
    for (const sub of node.subtrees) write(sub.name, sub.tree);
  };
  write("", tree);
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Parse a `TREE` extension payload; throws on a malformed one. */
export function parseCacheTree(data: Uint8Array): CacheTree {
  let at = 0;
  const read = (): { name: string; tree: CacheTree } => {
    const nul = data.indexOf(0, at);
    const nl = nul < 0 ? -1 : data.indexOf(10, nul);
    if (nul < 0 || nl < 0) throw new Error("TREE extension: truncated node");
    const name = dec.decode(data.subarray(at, nul));
    const m = /^(-?\d+) (\d+)$/.exec(dec.decode(data.subarray(nul + 1, nl)));
    if (!m) throw new Error("TREE extension: bad node header");
    at = nl + 1;
    const tree: CacheTree = { entryCount: Number(m[1]), subtrees: [] };
    if (tree.entryCount >= 0) {
      if (at + 20 > data.length) throw new Error("TREE extension: truncated id");
      tree.id = bytesToHex(data.subarray(at, at + 20));
      at += 20;
    }
    const count = Number(m[2]);
    for (let i = 0; i < count; i++) tree.subtrees.push(read());
    return { name, tree };
  };
  const root = read().tree;
  if (at !== data.length) throw new Error("TREE extension: trailing bytes");
  return root;
}
