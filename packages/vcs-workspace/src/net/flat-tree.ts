/**
 * Trees as flat path maps: read a commit's tree into `path → entry`, and store such a map back
 * as nested git trees. The folder snapshot, the checkout and the merge all work on this form.
 */

import type { History, ObjectId, TreeEntry } from "@statewalker/vcs-core";

/** A regular file */
export const MODE_FILE = 0o100644;
/** A directory (a subtree) */
export const MODE_TREE = 0o040000;
/** A submodule commit: kept in trees, never written to a folder */
export const MODE_GITLINK = 0o160000;

/** One non-directory entry of a tree, by its full path */
export interface FlatEntry {
  id: ObjectId;
  mode: number;
}

/** A whole tree, flattened: full path (`dir/file.txt`, no leading slash) to its entry */
export type FlatTree = Map<string, FlatEntry>;

function isTree(mode: number): boolean {
  return (mode & 0o170000) === MODE_TREE;
}

/** Every non-directory entry under `treeId`, by full path. */
export async function readFlatTree(
  history: History,
  treeId: ObjectId | undefined,
  prefix = "",
  out: FlatTree = new Map(),
): Promise<FlatTree> {
  if (!treeId) return out;
  const entries = await history.trees.load(treeId);
  if (!entries) throw new Error(`tree ${treeId} is missing`);
  for await (const e of entries) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (isTree(e.mode)) await readFlatTree(history, e.id, path, out);
    else out.set(path, { id: e.id, mode: e.mode });
  }
  return out;
}

/** The tree of a commit, flattened (empty for no commit). */
export async function readCommitTree(
  history: History,
  commitId: ObjectId | undefined,
): Promise<{ tree: ObjectId; files: FlatTree }> {
  if (!commitId) {
    const tree = history.trees.getEmptyTreeId();
    return { tree, files: new Map() };
  }
  const tree = await history.commits.getTree(commitId);
  if (!tree) throw new Error(`commit ${commitId} is missing`);
  return { tree, files: await readFlatTree(history, tree) };
}

interface DirNode {
  files: Map<string, FlatEntry>;
  dirs: Map<string, DirNode>;
}

/** Stores `files` as nested git trees; the root tree's id. */
export async function storeFlatTree(history: History, files: FlatTree): Promise<ObjectId> {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split("/");
    const name = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(name, entry);
  }
  const store = async (node: DirNode): Promise<ObjectId> => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ name, mode: e.mode, id: e.id });
    for (const [name, dir] of node.dirs) {
      entries.push({ name, mode: MODE_TREE, id: await store(dir) });
    }
    return history.trees.store(entries);
  };
  return store(root);
}

/** Whether two entries name the same content and mode (both absent counts as equal). */
export function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.mode === b.mode;
}
