/**
 * A folder (a `FilesApi`) and a git tree, both ways: snapshot the folder's files as blobs, and
 * bring the folder from one tree to another, checking each file just before it is replaced,
 * so an edit made meanwhile is not overwritten.
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import { hashWorktreeFile } from "@statewalker/vcs-working-tree";
import type { FilesApi } from "@statewalker/webrun-files";
import { type FlatEntry, type FlatTree, MODE_GITLINK } from "./flat-tree.js";
import { isSafePath, SYNC_TEMP_MARK } from "./path-rules.js";

/** Decides which folder paths (`dir/file.txt`, no leading slash) are left out of history */
export type IgnorePath = (path: string) => boolean;

/** The default: the folder's own `.git` directory, if it has one, is never committed. */
export const defaultIgnore: IgnorePath = (path) => path === ".git" || path.startsWith(".git/");

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
  /** When the snapshot read it (the local clock, ms) */
  seenAt: number;
}

/** The folder's files by path */
export type FolderSnapshot = Map<string, FolderFile>;

/**
 * How long after its modification time a file's size and time are not trusted to show a later
 * change (default 3 s: covers 2-second FAT times and 1-second HFS+/ext3 times). git calls
 * such entries "racily clean" and hashes them again.
 */
export const DEFAULT_RACY_WINDOW_MS = 3000;

function relative(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Options of {@link snapshotFolder}. */
export interface SnapshotOptions {
  /** Paths left out */
  skip?: IgnorePath;
  /** The previous snapshot: unchanged files (size, time, not racy) are not read again */
  cache?: FolderSnapshot;
  /** See {@link DEFAULT_RACY_WINDOW_MS} */
  racyWindowMs?: number;
  /** Temporary checkout files found, by path, with their modification times */
  tempFiles?: Map<string, number>;
}

/**
 * Every file of the folder `skip` keeps, stored as a blob. A file the cache knows with the
 * same size and modification time is not read again, unless that time was within the racy
 * window of when the cache read it (a later write in the same clock tick would look the same).
 * Temporary checkout files and paths no tree may hold (`.git`, `..`) are always left out.
 */
export async function snapshotFolder(
  history: History,
  folder: FilesApi,
  options: SnapshotOptions = {},
): Promise<FolderSnapshot> {
  const skip = options.skip ?? defaultIgnore;
  const window = options.racyWindowMs ?? DEFAULT_RACY_WINDOW_MS;
  const files: FolderSnapshot = new Map();
  for await (const info of folder.list("/", { recursive: true })) {
    if (info.kind !== "file") continue;
    const path = relative(info.path);
    if (isSyncTempFile(path)) {
      options.tempFiles?.set(path, info.lastModified);
      continue;
    }
    if (skip(path) || !isSafePath(path)) continue;
    const known = options.cache?.get(path);
    if (
      known &&
      known.size === info.size &&
      known.lastModified === info.lastModified &&
      known.lastModified + window <= known.seenAt
    ) {
      files.set(path, known);
      continue;
    }
    const seenAt = Date.now();
    const id = await history.blobs.store(folder.read(info.path));
    files.set(path, { id, size: info.size, lastModified: info.lastModified, seenAt });
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

let tempCounter = 0;
function tempPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  const random = Math.random().toString(36).slice(2, 10);
  return `${dir}${SYNC_TEMP_MARK}${Date.now().toString(36)}-${(tempCounter++).toString(36)}-${random}`;
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
 * A directory standing where a file must go: removed when everything in it is expendable
 * (ignored files, submodule contents, temporary files, as git removes ignored files a checkout
 * needs the place of); otherwise the folder holds new files there ({@link FolderChangedError}).
 */
async function clearDirectory(folder: FilesApi, path: string, expendable: IgnorePath) {
  for await (const info of folder.list(`/${path}`, { recursive: true })) {
    if (info.kind !== "file") continue;
    const p = relative(info.path);
    if (!expendable(p) && !isSyncTempFile(p)) throw new FolderChangedError(p);
  }
  await folder.remove(`/${path}`);
}

/** Options of {@link applyFolderPath}. */
export interface ApplyPathOptions {
  /** Whether the file's current content (its blob id, undefined: absent) may be replaced */
  accept: (current: ObjectId | undefined) => boolean;
  /** Files that may be removed to make room (ignored ones) */
  expendable?: IgnorePath;
}

/**
 * Brings one folder path to `entry` (undefined: removed). The file is checked just before:
 * content `accept` refuses stops with {@link FolderChangedError}, the file untouched. New
 * content is staged in a temporary file next to it; an existing file is then rewritten in
 * place from it (so the filesystem keeps its permissions, an executable bit for one), a new one
 * is moved in place. Returns what it did.
 */
export async function applyFolderPath(
  history: History,
  folder: FilesApi,
  path: string,
  entry: FlatEntry | undefined,
  options: ApplyPathOptions,
): Promise<"written" | "removed" | "unchanged"> {
  const target = entry && entry.mode !== MODE_GITLINK ? entry : undefined;
  if (!target) {
    const now = await currentFileId(folder, path);
    if (now === undefined) return "unchanged";
    if (!options.accept(now)) throw new FolderChangedError(path);
    await folder.remove(`/${path}`);
    await removeEmptyParents(folder, path);
    return "removed";
  }
  const content = await history.blobs.load(target.id);
  if (!content) throw new Error(`blob ${target.id} of ${path} is missing`);
  const temp = tempPathFor(path);
  await folder.write(`/${temp}`, content);
  try {
    const stats = await folder.stats(`/${path}`);
    if (stats?.kind === "directory") {
      await clearDirectory(folder, path, options.expendable ?? (() => false));
    }
    const now = await currentFileId(folder, path);
    if (now === target.id) return "unchanged";
    if (!options.accept(now)) throw new FolderChangedError(path);
    if (now === undefined) {
      if (!(await folder.move(`/${temp}`, `/${path}`))) {
        throw new Error(`cannot move ${temp} to ${path}`);
      }
    } else {
      await folder.write(`/${path}`, folder.read(`/${temp}`));
    }
    return "written";
  } finally {
    await folder.remove(`/${temp}`).catch(() => false);
  }
}

/** Options of {@link checkoutFolder}. */
export interface CheckoutFolderOptions {
  /** Paths never written (ignored ones, files of the target's submodules) */
  skipWrite?: IgnorePath;
  /** Paths never removed (ignored ones, files of the current submodules) */
  skipRemove?: IgnorePath;
  /** Files that may be removed to make room for a file (ignored ones) */
  expendable?: IgnorePath;
}

function inFolder(entry: FlatEntry | undefined): FlatEntry | undefined {
  return entry && entry.mode !== MODE_GITLINK ? entry : undefined;
}

/**
 * Brings the folder from `from` to `to`: removes the paths `to` drops, then writes the paths
 * whose content differs, each checked just before (see {@link applyFolderPath}): a file that
 * no longer holds what `from` says stops the checkout with {@link FolderChangedError}.
 */
export async function checkoutFolder(
  history: History,
  folder: FilesApi,
  from: FlatTree,
  to: FlatTree,
  options: CheckoutFolderOptions = {},
): Promise<{ written: string[]; removed: string[] }> {
  const skipWrite = options.skipWrite ?? (() => false);
  const skipRemove = options.skipRemove ?? (() => false);
  const done = { written: [] as string[], removed: [] as string[] };
  const accept = (path: string) => (now: ObjectId | undefined) =>
    now === inFolder(from.get(path))?.id;
  for (const [path, entry] of from) {
    if (!inFolder(entry) || inFolder(to.get(path)) || skipRemove(path)) continue;
    const r = await applyFolderPath(history, folder, path, undefined, { accept: accept(path) });
    if (r === "removed") done.removed.push(path);
  }
  for (const [path, entry] of to) {
    const next = inFolder(entry);
    if (!next || skipWrite(path) || inFolder(from.get(path))?.id === next.id) continue;
    const r = await applyFolderPath(history, folder, path, next, {
      accept: accept(path),
      expendable: options.expendable,
    });
    if (r === "written") done.written.push(path);
  }
  return done;
}

/** Removes temporary checkout files older than `olderThanMs` (left by a crash). */
export async function sweepTempFiles(
  folder: FilesApi,
  tempFiles: Map<string, number>,
  olderThanMs = 10 * 60_000,
): Promise<string[]> {
  const removed: string[] = [];
  const now = Date.now();
  for (const [path, lastModified] of tempFiles) {
    if (now - lastModified < olderThanMs) continue;
    if (await folder.remove(`/${path}`)) removed.push(path);
  }
  return removed;
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
