/**
 * git's sparse index (`sparse-index.c`): with `index.sparse`, a cone-mode sparse checkout
 * writes each directory outside the cone whose entries are all skip-worktree as one entry,
 * a sparse directory (mode 040000, the directory's path with a trailing `/`, the tree's id,
 * skip-worktree), and marks the index with the empty `sdir` extension.
 *
 * ```typescript
 * // reading: every sparse directory expanded (ensure_full_index)
 * const full = await expandSparseIndex(parsed.entries, cacheTree, trees);
 * // writing: collapsed again (convert_to_sparse)
 * const sparse = collapseSparseIndex(full.entries, fullCacheTree, patterns);
 * ```
 *
 * The index is held expanded in memory, as git's commands that need a full index hold it,
 * so every command sees ordinary entries; a write collapses it again when git would.
 */

import { FileMode, type ObjectId, type TreeEntry, type Trees } from "@statewalker/vcs-core";
import { type CacheTree, cacheTreeOfTree, copyCacheTree } from "./cache-tree.js";
import type { StagingEntry } from "./types.js";

/** The `sdir` extension's signature. */
export const SPARSE_DIRECTORIES_EXTENSION = "sdir";

/** Whether an entry is a sparse directory (git's `S_ISSPARSEDIR`). */
export function isSparseDirectoryEntry(entry: StagingEntry): boolean {
  return entry.mode === FileMode.TREE;
}

/** A sparse directory entry for `dir` (with its trailing slash), as `construct_sparse_dir_entry`. */
function sparseDirectoryEntry(dir: string, treeId: ObjectId): StagingEntry {
  return zeroStat(dir, FileMode.TREE, treeId);
}

/** An entry as `make_cache_entry` builds it (no stat data), skip-worktree. */
function zeroStat(path: string, mode: number, objectId: ObjectId): StagingEntry {
  return {
    path,
    mode,
    objectId,
    stage: 0,
    size: 0,
    mtime: 0,
    ctime: 0,
    mtimeNs: 0,
    ctimeNs: 0,
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
    assumeValid: false,
    intentToAdd: false,
    skipWorktree: true,
  };
}

/**
 * git's `ensure_full_index`: each sparse directory replaced by the entries of its tree
 * (skip-worktree, no stat data), and the cache-tree read with the index (`TREE` of the sparse
 * index) turned into the full index's: each sparse directory's node (one entry) becomes its
 * tree's, and the directories above count the entries it now holds.
 *
 * @throws Error when a tree cannot be read
 */
export async function expandSparseIndex(
  entries: readonly StagingEntry[],
  cacheTree: CacheTree | undefined,
  trees: Pick<Trees, "load">,
): Promise<{ entries: StagingEntry[]; cacheTree: CacheTree | undefined }> {
  const out: StagingEntry[] = [];
  const sparse = new Map<string, ObjectId>();
  const walk = async (treeId: ObjectId, prefix: string): Promise<void> => {
    const loaded = await trees.load(treeId);
    if (!loaded) throw new Error(`unable to read tree (${treeId})`);
    const list: TreeEntry[] = [];
    for await (const e of loaded) list.push(e);
    for (const e of list) {
      if (e.mode === FileMode.TREE) await walk(e.id, `${prefix}${e.name}/`);
      else out.push(zeroStat(`${prefix}${e.name}`, e.mode, e.id));
    }
  };
  for (const entry of entries) {
    if (!isSparseDirectoryEntry(entry)) {
      out.push(entry);
      continue;
    }
    sparse.set(entry.path, entry.objectId);
    await walk(entry.objectId, entry.path);
  }
  if (!cacheTree) return { entries: out, cacheTree: undefined };
  const tree = copyCacheTree(cacheTree);
  const expand = async (node: CacheTree, dir: string): Promise<number> => {
    let delta = 0;
    for (const sub of node.subtrees) {
      const path = `${dir}${sub.name}/`;
      const id = sparse.get(path);
      if (id !== undefined) {
        const full = await cacheTreeOfTree(trees, id);
        if (sub.tree.entryCount >= 0) delta += full.entryCount - sub.tree.entryCount;
        sub.tree = full;
      } else {
        delta += await expand(sub.tree, path);
      }
    }
    if (node.entryCount >= 0) node.entryCount += delta;
    return delta;
  };
  await expand(tree, "");
  return { entries: out, cacheTree: tree };
}

/**
 * git's `convert_to_sparse_rec` over a full index whose cache-tree is `cacheTree` (computed
 * for these entries): a directory outside the checkout (`inCheckout`, git's
 * `path_in_sparse_checkout` of the directory's path with its trailing slash) becomes one
 * sparse directory entry when every entry below it is skip-worktree, merged and no gitlink,
 * and its cache-tree node is valid. Also returns the sparse index's cache-tree (git's
 * `cache_tree_update` after the conversion): a sparse directory counts as one entry.
 */
export function collapseSparseIndex(
  entries: readonly StagingEntry[],
  cacheTree: CacheTree,
  inCheckout: (path: string) => boolean,
): { entries: StagingEntry[]; cacheTree: CacheTree } {
  const out: StagingEntry[] = [];
  const collapsed = new Set<string>();
  const rec = (start: number, end: number, ctPath: string, ct: CacheTree): void => {
    let canConvert = ctPath !== "" && !inCheckout(ctPath);
    for (let i = start; canConvert && i < end; i++) {
      const e = entries[i] as StagingEntry;
      if (e.stage !== 0 || e.mode === FileMode.GITLINK || !e.skipWorktree) canConvert = false;
    }
    if (canConvert && ct.id) {
      out.push(sparseDirectoryEntry(ctPath, ct.id));
      collapsed.add(ctPath);
      return;
    }
    let i = start;
    while (i < end) {
      const e = entries[i] as StagingEntry;
      const rest = e.path.slice(ctPath.length);
      const slash = rest.indexOf("/");
      const sub = slash >= 0 ? ct.subtrees.find((s) => s.name === rest.slice(0, slash)) : undefined;
      if (!sub || sub.tree.entryCount < 0) {
        out.push(e);
        i++;
        continue;
      }
      const span = sub.tree.entryCount;
      rec(i, i + span, `${ctPath}${rest.slice(0, slash + 1)}`, sub.tree);
      i += span;
    }
  };
  rec(0, entries.length, "", cacheTree);

  const ids = new Map<string, ObjectId>();
  for (const e of out) if (isSparseDirectoryEntry(e)) ids.set(e.path, e.objectId);
  return { entries: out, cacheTree: sparseCacheTreeOf(cacheTree, out, ids) };
}

/**
 * The cache-tree of a sparse index from its full index's (`cacheTree`): each collapsed
 * directory (`collapsed`, path with its trailing slash, and tree id) a leaf of one entry,
 * every other valid directory counting the sparse entries (`entries`) below it; invalid
 * nodes stay invalid.
 */
export function sparseCacheTreeOf(
  cacheTree: CacheTree,
  entries: readonly StagingEntry[],
  collapsed: ReadonlyMap<string, ObjectId>,
): CacheTree {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set("", (counts.get("") ?? 0) + 1);
    // a sparse directory's own trailing slash ends no directory of its own
    const last = isSparseDirectoryEntry(e) ? e.path.length - 1 : e.path.length;
    for (let k = e.path.indexOf("/"); k >= 0 && k < last; k = e.path.indexOf("/", k + 1)) {
      const dir = e.path.slice(0, k + 1);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const sparseTree = (node: CacheTree, dir: string): CacheTree => {
    const id = collapsed.get(dir);
    if (id !== undefined) return { entryCount: 1, id, subtrees: [] };
    const copy: CacheTree = {
      entryCount: node.entryCount,
      ...(node.id ? { id: node.id } : {}),
      subtrees: node.subtrees.map((s) => ({
        name: s.name,
        tree: sparseTree(s.tree, `${dir}${s.name}/`),
      })),
    };
    if (copy.entryCount >= 0) copy.entryCount = counts.get(dir) ?? 0;
    return copy;
  };
  return sparseTree(cacheTree, "");
}

/**
 * A sparse index kept collapsed, as git's sparse-aware commands keep the sparse directories
 * of the index they read (`convert_to_sparse` does nothing to an index still collapsed): each
 * directory read as a sparse directory (`dirs`) is written as one again when every entry
 * below it is still skip-worktree, merged and no gitlink, and it is still outside the
 * checkout. Its tree is its cache-tree node's when valid, else `treeOf` its entries (paths
 * below the directory). Undefined when a directory read sparse no longer qualifies: git would
 * have expanded the index, and the write converts the full index instead.
 */
export async function recollapseSparseIndex(
  entries: readonly StagingEntry[],
  cacheTree: CacheTree | undefined,
  dirs: Iterable<string>,
  inCheckout: (path: string) => boolean,
  treeOf: (entries: StagingEntry[]) => Promise<ObjectId>,
): Promise<{ entries: StagingEntry[]; cacheTree: CacheTree | undefined } | undefined> {
  const wanted = [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const collapsed = new Map<string, ObjectId>();
  const out: StagingEntry[] = [];
  let i = 0;
  let w = 0;
  while (i < entries.length) {
    const e = entries[i] as StagingEntry;
    while (
      w < wanted.length &&
      (wanted[w] as string) < e.path &&
      !e.path.startsWith(wanted[w] as string)
    )
      w++;
    const dir = wanted[w];
    if (dir === undefined || !e.path.startsWith(dir)) {
      out.push(e);
      i++;
      continue;
    }
    let j = i;
    const below: StagingEntry[] = [];
    while (j < entries.length && (entries[j] as StagingEntry).path.startsWith(dir)) {
      const x = entries[j] as StagingEntry;
      if (x.stage !== 0 || x.mode === FileMode.GITLINK || !x.skipWorktree) return undefined;
      below.push({ ...x, path: x.path.slice(dir.length) });
      j++;
    }
    if (inCheckout(dir)) return undefined;
    const node = cacheTree ? nodeAt(cacheTree, dir) : undefined;
    const id = node && node.entryCount >= 0 && node.id ? node.id : await treeOf(below);
    out.push(sparseDirectoryEntry(dir, id));
    collapsed.set(dir, id);
    i = j;
    w++;
  }
  return {
    entries: out,
    cacheTree: cacheTree ? sparseCacheTreeOf(cacheTree, out, collapsed) : undefined,
  };
}

/** The node of `tree` at `dir` (with its trailing slash). */
function nodeAt(tree: CacheTree, dir: string): CacheTree | undefined {
  let node: CacheTree | undefined = tree;
  for (const name of dir.slice(0, -1).split("/")) {
    node = node?.subtrees.find((s) => s.name === name)?.tree;
    if (!node) return undefined;
  }
  return node;
}
