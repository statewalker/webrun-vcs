/**
 * A folder (a `FilesApi`) and a git tree, both ways: snapshot the folder's files as blobs, and
 * bring the folder from one tree to another, checking each file just before it is replaced
 * and writing through a temporary file, so an edit made meanwhile is not overwritten.
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import { hashWorktreeFile } from "@statewalker/vcs-working-tree";
import type { FilesApi } from "@statewalker/webrun-files";
import { type FlatEntry, type FlatTree, MODE_GITLINK, sameEntry } from "./flat-tree.js";
import { isSafePath } from "./path-rules.js";

/** Decides which folder paths (`dir/file.txt`, no leading slash) are left out of history */
export type IgnorePath = (path: string) => boolean;

/** The default: the folder's own `.git` directory, if it has one, is never committed. */
export const defaultIgnore: IgnorePath = (path) => path === ".git" || path.startsWith(".git/");

/** Marks the temporary files a checkout writes before moving them in place */
export const SYNC_TEMP_MARK = ".vcs-sync-tmp-";

/** Whether `path` is a temporary file of a checkout (never committed) */
export function isSyncTempFile(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).startsWith(SYNC_TEMP_MARK);
}

/** The folder changed while the sync was bringing it to a new commit. */
export class FolderChangedError extends Error {
  constructor(readonly path?: string) {
    super(
      path ? `the folder changed during the sync (${path})` : "the folder changed during the sync",
    );
    this.name = "FolderChangedError";
  }
}

/** A folder file as a snapshot saw it */
export interface FolderFile {
  id: ObjectId;
  size: number;
  lastModified: number;
}

/** The folder's files by path */
export type FolderSnapshot = Map<string, FolderFile>;

function relative(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Every file of the folder `skip` keeps, stored as a blob. With `cache` (the previous
 * snapshot), a file whose size and modification time did not change is not read again.
 * Temporary checkout files and paths no tree may hold (`.git`, `..`) are always left out.
 */
export async function snapshotFolder(
  history: History,
  folder: FilesApi,
  skip: IgnorePath = defaultIgnore,
  cache?: FolderSnapshot,
): Promise<FolderSnapshot> {
  const files: FolderSnapshot = new Map();
  for await (const info of folder.list("/", { recursive: true })) {
    if (info.kind !== "file") continue;
    const path = relative(info.path);
    if (skip(path) || isSyncTempFile(path) || !isSafePath(path)) continue;
    const known = cache?.get(path);
    if (known && known.size === info.size && known.lastModified === info.lastModified) {
      files.set(path, known);
      continue;
    }
    const id = await history.blobs.store(folder.read(info.path));
    files.set(path, { id, size: info.size, lastModified: info.lastModified });
  }
  return files;
}

/** The blob id of the folder file at `path` now, without storing it (undefined: absent). */
export async function currentFileId(folder: FilesApi, path: string): Promise<ObjectId | undefined> {
  const stats = await folder.stats(`/${path}`);
  if (!stats) return undefined;
  if (stats.kind !== "file") return `directory:${path}`;
  try {
    return await hashWorktreeFile(path, {
      size: async () => {
        const s = await folder.stats(`/${path}`);
        return s?.kind === "file" ? s.size : undefined;
      },
      read: () => folder.read(`/${path}`),
    });
  } catch {
    return (await folder.exists(`/${path}`)) ? `unreadable:${path}` : undefined;
  }
}

/** Options of {@link checkoutFolder}. */
export interface CheckoutFolderOptions {
  /** Paths never written or removed (ignored ones) */
  skip?: IgnorePath;
}

function written(entry: FlatEntry | undefined): FlatEntry | undefined {
  return entry && entry.mode !== MODE_GITLINK ? entry : undefined;
}

let tempCounter = 0;
function tempPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  const random = Math.random().toString(36).slice(2, 10);
  return `${dir}${SYNC_TEMP_MARK}${Date.now().toString(36)}-${(tempCounter++).toString(36)}-${random}`;
}

/**
 * Brings the folder from `from` to `to`: removes the paths `to` drops, then writes the paths
 * whose content differs. Each file is checked just before it is removed or replaced: it must
 * still hold what `from` says (or be absent where `from` has nothing), else
 * {@link FolderChangedError} stops the checkout with that file untouched. New content goes to
 * a temporary file first and is moved in place after the check. Submodule entries and paths
 * `skip` names are never touched.
 */
export async function checkoutFolder(
  history: History,
  folder: FilesApi,
  from: FlatTree,
  to: FlatTree,
  options: CheckoutFolderOptions = {},
): Promise<{ written: string[]; removed: string[] }> {
  const skip = options.skip ?? (() => false);
  const done = { written: [] as string[], removed: [] as string[] };
  const expect = async (path: string, entry: FlatEntry | undefined) => {
    const now = await currentFileId(folder, path);
    if (now !== entry?.id) throw new FolderChangedError(path);
  };
  for (const [path, entry] of from) {
    const old = written(entry);
    if (!old || written(to.get(path)) || skip(path)) continue;
    await expect(path, old);
    await folder.remove(`/${path}`);
    done.removed.push(path);
    await removeEmptyParents(folder, path);
  }
  for (const [path, entry] of to) {
    const next = written(entry);
    if (!next || skip(path)) continue;
    const old = written(from.get(path));
    if (sameEntry(old, next) || old?.id === next.id) continue;
    const content = await history.blobs.load(next.id);
    if (!content) throw new Error(`blob ${next.id} of ${path} is missing`);
    const temp = tempPathFor(path);
    await folder.write(`/${temp}`, content);
    try {
      await expect(path, old);
      if (!(await folder.move(`/${temp}`, `/${path}`))) {
        throw new Error(`cannot move ${temp} to ${path}`);
      }
    } catch (error) {
      await folder.remove(`/${temp}`).catch(() => false);
      throw error;
    }
    done.written.push(path);
  }
  return done;
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

/**
 * Whether the folder is case-insensitive (`A.txt` and `a.txt` name one file): a temporary file
 * is written and looked up in upper case, then removed.
 */
export async function probeCaseInsensitive(folder: FilesApi): Promise<boolean> {
  const name = `/${SYNC_TEMP_MARK}case-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await folder.write(name, [new Uint8Array(0)]);
    return await folder.exists(name.toUpperCase());
  } catch {
    return false;
  } finally {
    await folder.remove(name).catch(() => false);
  }
}
