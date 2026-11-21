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

import {
  collectTreeBytes,
  FileMode,
  type ObjectId,
  objectIdToBytes,
  type TreeEntry,
  type Trees,
  treeModesRewritten,
} from "@statewalker/vcs-core";
import { bytesToHex, createSha1 } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

/** One directory of a cache-tree. */
export interface CacheTree {
  /** The index entries under this directory, recursively; -1 when the node is invalid. */
  entryCount: number;
  /** The tree object of a valid node. */
  id?: ObjectId;
  /** The directories below, in git's order (see `compareSubtreeNames`). */
  subtrees: { name: string; tree: CacheTree }[];
}

/** git's `subtree_name_cmp`: shorter names first, then bytes. */
function compareSubtreeNames(a: string, b: string): number {
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
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
 * (the index's cache-tree before, the paths that changed invalidated; none: every node
 * computed): a valid node whose tree is still the one there is kept without reading it, as
 * `cache_tree_update` keeps the valid nodes and computes the others. Only the trees under
 * invalid nodes are read.
 *
 * A node computed is the tree the index's entries make, whose modes are canonical: where the
 * stored tree holds other modes (100664), that is another tree, valid only when it is stored
 * (git's `WRITE_TREE_REPAIR`) and invalid otherwise, as its parents are.
 */
export async function updateCacheTree(
  trees: Pick<Trees, "load" | "has" | "entries">,
  treeId: ObjectId,
  previous: CacheTree | undefined,
): Promise<CacheTree> {
  if (previous && previous.entryCount >= 0 && previous.id === treeId) {
    return copyCacheTree(previous);
  }
  const entries = await treeEntriesOf(trees, treeId);
  const node: CacheTree = { entryCount: 0, id: treeId, subtrees: [] };
  const dirs: { name: string; id: ObjectId }[] = [];
  for (const entry of entries) {
    if (entry.mode === FileMode.TREE) dirs.push({ name: entry.name, id: entry.id });
    else node.entryCount++;
  }
  let valid = true;
  let changed = treeModesRewritten(entries) ?? entries.length > 0;
  const ids = new Map<string, ObjectId>();
  for (const dir of dirs) {
    const before = previous?.subtrees.find((s) => s.name === dir.name)?.tree;
    const tree = await updateCacheTree(trees, dir.id, before);
    if (tree.entryCount < 0 || !tree.id) valid = false;
    else {
      node.entryCount += tree.entryCount;
      ids.set(dir.name, tree.id);
      if (tree.id !== dir.id) changed = true;
    }
    node.subtrees.push({ name: dir.name, tree });
  }
  node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
  if (valid && changed) {
    const id = await canonicalTreeId(
      entries.map((e) => (e.mode === FileMode.TREE ? { ...e, id: ids.get(e.name) ?? e.id } : e)),
    );
    if (id !== treeId) {
      if (await trees.has(id)) node.id = id;
      else valid = false;
    }
  }
  if (!valid) {
    node.entryCount = -1;
    node.id = undefined;
  }
  return node;
}

/** The index's entries of one directory, for {@link invalidateCacheTreeAgainstIndex}. */
interface IndexDirEntries {
  files: Map<string, { objectId: ObjectId; mode: number }>;
  dirs: Map<string, IndexDirEntries>;
}

/**
 * Invalidate in `tree`, a cache-tree computed from the stored tree `treeId`
 * ({@link updateCacheTree}), every path where the index `entries` (its stage-0 entries by
 * path, modes canonical) are not that tree's: an index entry the tree lacks or holds
 * otherwise, and a path of the tree the index lacks. So the cache-tree describes the index
 * and not the tree, as git's `cache_tree_update` computes it from the index after
 * unpack-trees (a staged change a two-way switch carries over stays in the index).
 *
 * `previous` (the index's own cache-tree before, each path changed since invalidated)
 * saves reading: a directory valid there with the tree's id holds the tree's entries.
 *
 * ```typescript
 * const cacheTree = await updateCacheTree(trees, target, previous);
 * await invalidateCacheTreeAgainstIndex(trees, cacheTree, target, finalIndex, previous);
 * ```
 */
export async function invalidateCacheTreeAgainstIndex(
  trees: Pick<Trees, "load" | "entries">,
  tree: CacheTree,
  treeId: ObjectId,
  entries: ReadonlyMap<string, { objectId: ObjectId; mode: number }>,
  previous?: CacheTree,
): Promise<void> {
  const root: IndexDirEntries = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of entries) {
    let dir = root;
    let from = 0;
    for (let k = path.indexOf("/"); k >= 0; k = path.indexOf("/", from)) {
      const name = path.slice(from, k);
      let next = dir.dirs.get(name);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
      from = k + 1;
    }
    dir.files.set(path.slice(from), entry);
  }
  const walk = async (
    id: ObjectId,
    before: CacheTree | undefined,
    dir: IndexDirEntries,
    prefix: string,
  ): Promise<void> => {
    if (before && before.entryCount >= 0 && before.id === id) return;
    const seenFiles = new Set<string>();
    const seenDirs = new Set<string>();
    for (const entry of await treeEntriesOf(trees, id)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        const sub = dir.dirs.get(entry.name);
        if (!sub) {
          invalidateCacheTreePath(tree, path);
          continue;
        }
        seenDirs.add(entry.name);
        await walk(entry.id, before?.subtrees.find((s) => s.name === entry.name)?.tree, sub, path);
        continue;
      }
      const file = dir.files.get(entry.name);
      seenFiles.add(entry.name);
      if (!file || file.objectId !== entry.id || file.mode !== entry.mode) {
        invalidateCacheTreePath(tree, path);
      }
    }
    for (const name of dir.files.keys()) {
      if (!seenFiles.has(name)) invalidateCacheTreePath(tree, prefix ? `${prefix}/${name}` : name);
    }
    for (const name of dir.dirs.keys()) {
      if (!seenDirs.has(name)) invalidateCacheTreePath(tree, prefix ? `${prefix}/${name}` : name);
    }
  };
  await walk(treeId, previous, root, "");
}

/** The entries of tree `treeId` (modes canonical), shared where the store gives them so. */
async function treeEntriesOf(
  trees: Pick<Trees, "load" | "entries">,
  treeId: ObjectId,
): Promise<readonly TreeEntry[]> {
  const shared = await trees.entries?.(treeId);
  if (shared) return shared;
  const loaded = await trees.load(treeId);
  if (!loaded) throw new Error(`tree ${treeId} not found`);
  const out: TreeEntry[] = [];
  for await (const entry of loaded) out.push(entry);
  return out;
}

/** The id of the tree `entries` make (not stored). */
async function canonicalTreeId(entries: readonly TreeEntry[]): Promise<ObjectId> {
  const bytes = await collectTreeBytes(entries);
  const hasher = createSha1().update(new TextEncoder().encode(`tree ${bytes.length}\0`));
  return bytesToHex(hasher.update(bytes).digest());
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
    parts.push(encodeGitPath(`${name}\0${node.entryCount} ${node.subtrees.length}\n`));
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
    const name = decodeGitPath(data.subarray(at, nul));
    const m = /^(-?\d+) (\d+)$/.exec(decodeGitPath(data.subarray(nul + 1, nl)));
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

/**
 * Check a cache-tree against the index it is written with, for tests and fsck: every valid
 * node must count the tree entries of its directory (stage-0 entries, intent-to-add ones
 * excepted) and name a stored tree holding exactly them (path, mode as the store reads it,
 * object id). A valid node may name a tree stored with other modes (100664) than the index
 * computes, as git keeps such a tree. Returns one line per problem; none: the cache-tree
 * describes the index.
 *
 * @example
 * ```typescript
 * expect(await verifyCacheTree(trees, staging.getCacheTree(), staging.entryList())).toEqual([]);
 * ```
 */
export async function verifyCacheTree(
  trees: Pick<Trees, "load">,
  tree: CacheTree | undefined,
  entries: readonly {
    path: string;
    mode: number;
    objectId: ObjectId;
    stage: number;
    intentToAdd?: boolean;
    skipWorktree?: boolean;
  }[],
): Promise<string[]> {
  const problems: string[] = [];
  if (!tree) return problems;
  const inTree = entries.filter((e) => e.stage === 0 && !e.intentToAdd);
  const flatten = async (id: ObjectId, prefix: string, out: string[]): Promise<boolean> => {
    const list = await trees.load(id);
    if (!list) return false;
    for await (const e of list) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === FileMode.TREE) {
        if (!(await flatten(e.id, path, out))) return false;
      } else out.push(`${e.mode.toString(8)} ${e.id} ${path}`);
    }
    return true;
  };
  const check = async (node: CacheTree, dir: string): Promise<void> => {
    if (node.entryCount >= 0) {
      const under = inTree.filter((e) => (dir ? e.path.startsWith(`${dir}/`) : true));
      if (under.length !== node.entryCount) {
        problems.push(`'${dir}': counts ${node.entryCount} entries, the index has ${under.length}`);
      }
      const stored: string[] = [];
      if (!node.id || !(await flatten(node.id, dir, stored))) {
        problems.push(`'${dir}': tree ${node.id ?? "(none)"} is not stored`);
      } else {
        const expected = under.map((e) => `${e.mode.toString(8)} ${e.objectId} ${e.path}`);
        if (stored.join("\n") !== expected.join("\n")) {
          problems.push(`'${dir}': tree ${node.id} does not hold the index's entries`);
        }
      }
    }
    for (const sub of node.subtrees) await check(sub.tree, dir ? `${dir}/${sub.name}` : sub.name);
  };
  await check(tree, "");
  return problems;
}

/**
 * git's `cache_tree_update(WRITE_TREE_SILENT | WRITE_TREE_REPAIR)` from nothing (unpack-trees
 * after `read-tree` freed the cache-tree): each directory of the index valid with the tree
 * its entries make where that tree is already stored (nothing is written), invalid where it
 * is not or where it holds an intent-to-add entry. `entries` are the index's, in its order.
 * Undefined when the index has unmerged entries (`verify_cache` fails: no cache-tree).
 *
 * As git's `update_one`, a directory whose tree is not stored stops its parent at once
 * (the parent finds no object for it and returns -1), and that failure climbs to the root:
 * every directory on the way stays invalid and the ones after it there are never created,
 * so the `TREE` written matches git's byte for byte.
 *
 * ```typescript
 * staging.setCacheTree?.(await repairCacheTree(trees, staging.entryList?.() ?? []));
 * ```
 */
export async function repairCacheTree(
  trees: Pick<Trees, "has">,
  entries: readonly {
    path: string;
    mode: number;
    objectId: ObjectId;
    stage: number;
    intentToAdd?: boolean;
  }[],
): Promise<CacheTree | undefined> {
  if (entries.some((e) => e.stage !== 0)) return undefined;
  /** The tree id a node computed, kept even while the node is invalid (git's `it->oid`). */
  const oids = new Map<CacheTree, ObjectId>();
  const emptyTree = await canonicalTreeId([]);
  /** `update_one` of the entries from `start` under `base`: how many it covers, or -1. */
  const update = async (node: CacheTree, start: number, base: string): Promise<number> => {
    const children = new Map<string, { tree: CacheTree; count: number }>();
    const inBase = (i: number) => {
      const e = entries[i];
      return e !== undefined && e.path.length > base.length && e.path.startsWith(base);
    };
    let i = start;
    while (inBase(i)) {
      const path = (entries[i] as { path: string }).path;
      const slash = path.indexOf("/", base.length);
      if (slash < 0) {
        i++;
        continue;
      }
      const name = path.slice(base.length, slash);
      const tree: CacheTree = { entryCount: -1, subtrees: [] };
      node.subtrees.push({ name, tree });
      node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
      const count = await update(tree, i, path.slice(0, slash + 1));
      if (count < 0) return -1;
      children.set(name, { tree, count });
      i += count;
    }
    const items: TreeEntry[] = [];
    let toInvalidate = false;
    i = start;
    while (inBase(i)) {
      const e = entries[i] as (typeof entries)[number];
      const slash = e.path.indexOf("/", base.length);
      if (slash >= 0) {
        const name = e.path.slice(base.length, slash);
        const sub = children.get(name) as { tree: CacheTree; count: number };
        i += sub.count;
        const oid = oids.get(sub.tree);
        const containsIta = sub.tree.entryCount < 0;
        if (containsIta) toInvalidate = true;
        // a subtree with no object: the expected miss of an invalid one fails this level
        if (!oid || !(oid === emptyTree || (await trees.has(oid)))) return -1;
        if (containsIta && oid === emptyTree) continue;
        items.push({ name, mode: FileMode.TREE, id: oid });
      } else {
        i++;
        if (e.intentToAdd) {
          toInvalidate = true;
          continue;
        }
        items.push({ name: e.path.slice(base.length), mode: e.mode, id: e.objectId });
      }
    }
    const id = await canonicalTreeId(items);
    if (id === emptyTree || (await trees.has(id))) oids.set(node, id);
    else toInvalidate = true;
    if (toInvalidate) {
      node.entryCount = -1;
      node.id = undefined;
    } else {
      node.entryCount = i - start;
      node.id = id;
    }
    return i - start;
  };
  const root: CacheTree = { entryCount: -1, subtrees: [] };
  await update(root, 0, "");
  return root;
}

/**
 * git's `cache_tree_update(WRITE_TREE_MISSING_OK)` from nothing, as `convert_to_sparse`
 * runs it before collapsing directories: the tree of every directory of the index is stored
 * (`store`) and its node valid, except the directories holding an intent-to-add entry (up
 * to the root), which stay invalid while their trees (without such entries) are still
 * stored. Undefined when the index has unmerged entries.
 *
 * ```typescript
 * const tree = await storeCacheTree((entries) => trees.store(entries), staging.entryList());
 * ```
 */
export async function storeCacheTree(
  store: (entries: TreeEntry[]) => Promise<ObjectId>,
  entries: readonly {
    path: string;
    mode: number;
    objectId: ObjectId;
    stage: number;
    intentToAdd?: boolean;
  }[],
): Promise<CacheTree | undefined> {
  if (entries.some((e) => e.stage !== 0)) return undefined;
  const oids = new Map<CacheTree, ObjectId>();
  const emptyTree = await canonicalTreeId([]);
  const update = async (node: CacheTree, start: number, base: string): Promise<number> => {
    const inBase = (i: number) => {
      const e = entries[i];
      return e !== undefined && e.path.length > base.length && e.path.startsWith(base);
    };
    const children = new Map<string, { tree: CacheTree; count: number }>();
    let i = start;
    while (inBase(i)) {
      const path = (entries[i] as { path: string }).path;
      const slash = path.indexOf("/", base.length);
      if (slash < 0) {
        i++;
        continue;
      }
      const name = path.slice(base.length, slash);
      const tree: CacheTree = { entryCount: -1, subtrees: [] };
      node.subtrees.push({ name, tree });
      const count = await update(tree, i, path.slice(0, slash + 1));
      children.set(name, { tree, count });
      i += count;
    }
    node.subtrees.sort((a, b) => compareSubtreeNames(a.name, b.name));
    const items: TreeEntry[] = [];
    let toInvalidate = false;
    i = start;
    while (inBase(i)) {
      const e = entries[i] as (typeof entries)[number];
      const slash = e.path.indexOf("/", base.length);
      if (slash >= 0) {
        const name = e.path.slice(base.length, slash);
        const sub = children.get(name) as { tree: CacheTree; count: number };
        i += sub.count;
        const oid = oids.get(sub.tree) as ObjectId;
        const containsIta = sub.tree.entryCount < 0;
        if (containsIta) toInvalidate = true;
        if (containsIta && oid === emptyTree) continue;
        items.push({ name, mode: FileMode.TREE, id: oid });
      } else {
        i++;
        if (e.intentToAdd) {
          toInvalidate = true;
          continue;
        }
        items.push({ name: e.path.slice(base.length), mode: e.mode, id: e.objectId });
      }
    }
    const id = await store(items);
    oids.set(node, id);
    if (toInvalidate) {
      node.entryCount = -1;
      node.id = undefined;
    } else {
      node.entryCount = i - start;
      node.id = id;
    }
    return i - start;
  };
  const root: CacheTree = { entryCount: -1, subtrees: [] };
  await update(root, 0, "");
  return root;
}

/**
 * The id of the tree `entries` make (paths relative to it, in index order), hashed and not
 * stored; undefined when an entry is unmerged or intent-to-add (no tree holds it: git's
 * `update_one` leaves such a directory invalid).
 */
export async function treeIdOfEntries(
  entries: readonly {
    path: string;
    mode: number;
    objectId: ObjectId;
    stage: number;
    intentToAdd?: boolean;
  }[],
): Promise<ObjectId | undefined> {
  if (entries.some((e) => e.stage !== 0 || e.intentToAdd)) return undefined;
  const tree = await storeCacheTree(canonicalTreeId, entries);
  return tree && tree.entryCount >= 0 ? tree.id : undefined;
}

/** The node of `tree` at `dir` (a directory path without a trailing slash; "" the root). */
export function cacheTreeNodeAt(tree: CacheTree, dir: string): CacheTree | undefined {
  if (dir === "") return tree;
  let node: CacheTree | undefined = tree;
  for (const name of dir.split("/")) {
    node = node?.subtrees.find((s) => s.name === name)?.tree;
    if (!node) return undefined;
  }
  return node;
}
