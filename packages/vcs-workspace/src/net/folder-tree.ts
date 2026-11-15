/**
 * A folder (a `FilesApi`) and a git tree, both ways: snapshot the folder's files as blobs and a
 * flat tree, and bring the folder from one tree to another by writing only what differs.
 */

import type { History } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/webrun-files";
import { type FlatTree, MODE_FILE, MODE_GITLINK, sameEntry } from "./flat-tree.js";

/** Decides which folder paths (`dir/file.txt`, no leading slash) are left out of history */
export type IgnorePath = (path: string) => boolean;

/** The default: the folder's own `.git` directory, if it has one, is never committed. */
export const defaultIgnore: IgnorePath = (path) => path === ".git" || path.startsWith(".git/");

function relative(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Every file of the folder, stored as a blob, by path. */
export async function snapshotFolder(
  history: History,
  folder: FilesApi,
  ignore: IgnorePath = defaultIgnore,
): Promise<FlatTree> {
  const files: FlatTree = new Map();
  for await (const info of folder.list("/", { recursive: true })) {
    if (info.kind !== "file") continue;
    const path = relative(info.path);
    if (ignore(path)) continue;
    const id = await history.blobs.store(folder.read(info.path));
    files.set(path, { id, mode: MODE_FILE });
  }
  return files;
}

/** Whether the folder holds exactly `files` (the paths `ignore` keeps). */
export async function folderMatches(
  history: History,
  folder: FilesApi,
  files: FlatTree,
  ignore: IgnorePath = defaultIgnore,
): Promise<boolean> {
  const now = await snapshotFolder(history, folder, ignore);
  if (now.size !== files.size) return false;
  for (const [path, entry] of now) {
    // the folder knows no modes: compare content only
    if (files.get(path)?.id !== entry.id) return false;
  }
  return true;
}

/**
 * Brings the folder from `from` to `to`: removes the paths `to` drops, then writes the paths
 * whose content differs. Submodule entries are skipped (a folder cannot hold them).
 */
export async function checkoutFolder(
  history: History,
  folder: FilesApi,
  from: FlatTree,
  to: FlatTree,
): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  const removed: string[] = [];
  for (const path of from.keys()) {
    if (to.has(path)) continue;
    await folder.remove(`/${path}`);
    removed.push(path);
    await removeEmptyParents(folder, path);
  }
  for (const [path, entry] of to) {
    if (entry.mode === MODE_GITLINK) continue;
    if (sameEntry(from.get(path), entry)) continue;
    const content = await history.blobs.load(entry.id);
    if (!content) throw new Error(`blob ${entry.id} of ${path} is missing`);
    await folder.write(`/${path}`, content);
    written.push(path);
  }
  return { written, removed };
}

async function removeEmptyParents(folder: FilesApi, path: string): Promise<void> {
  const parts = path.split("/");
  parts.pop();
  while (parts.length > 0) {
    const dir = `/${parts.join("/")}`;
    let empty = true;
    for await (const _ of folder.list(dir)) {
      empty = false;
      break;
    }
    if (!empty) return;
    await folder.remove(dir);
    parts.pop();
  }
}
