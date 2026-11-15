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

/**
 * The names a checkout gives its temporary files: the prefix, then the time (12 hex digits),
 * a counter (4) and random digits (8)
 */
export const TEMP_NAME = /^\.vcs-sync-tmp-[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{8}$/;

/** Whether `path` is a temporary file a checkout wrote (by its exact name) */
export function isCheckoutTempFile(path: string): boolean {
  return TEMP_NAME.test(path.slice(path.lastIndexOf("/") + 1));
}

/** Whether `path` has the reserved temporary-file prefix (never committed) */
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
  /** Read every file again, whatever the cache says */
  rehashAll?: boolean;
  /**
   * The nested repositories to leave out (see {@link findNestedRepositories}); found by this
   * snapshot when not given
   */
  nested?: string[];
}

/** A folder path the snapshot left out of history, and why */
export interface SkippedPath {
  path: string;
  /**
   * `nested-repository`: a directory holding a repository of its own (its files belong to
   * it); `reserved-name`: a name no tree may hold (`.git` below the root, the temporary-file
   * prefix); `unsafe-path`: any other name git refuses in a tree
   */
  reason: "nested-repository" | "reserved-name" | "unsafe-path";
}

/** Whether `path` is below one of the directories `roots` */
export function under(roots: Iterable<string>): (path: string) => boolean {
  const list = [...roots];
  if (list.length === 0) return () => false;
  return (path) => list.some((r) => path.startsWith(`${r}/`));
}

/** Whether the file starts with `gitdir:` (a git worktree's or submodule's `.git` file). */
async function isGitFile(folder: FilesApi, at: string): Promise<boolean> {
  const parts: number[] = [];
  for await (const chunk of folder.read(at, { start: 0, length: 7 })) {
    for (const byte of chunk) {
      if (parts.length < 7) parts.push(byte);
    }
    if (parts.length >= 7) break;
  }
  return String.fromCharCode(...parts) === "gitdir:";
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** A `.git` directory or `gitdir:` file below the folder's root */
async function isGitEntry(
  folder: FilesApi,
  info: { path: string; kind: "file" | "directory" },
): Promise<boolean> {
  const path = relative(info.path);
  const slash = path.lastIndexOf("/");
  if (slash <= 0 || path.slice(slash + 1).toLowerCase() !== ".git") return false;
  return info.kind === "directory" || (await isGitFile(folder, info.path));
}

function outermost(dirs: Iterable<string>): string[] {
  const all = [...dirs];
  return all.filter((d) => !all.some((o) => d.startsWith(`${o}/`))).sort();
}

/**
 * The nested repositories of the folder, outermost only: directories holding a `.git`
 * directory or a `.git` file starting with `gitdir:`.
 */
export async function findNestedRepositories(folder: FilesApi): Promise<string[]> {
  const nested = new Set<string>();
  for await (const info of folder.list("/", { recursive: true })) {
    if (await isGitEntry(folder, info)) nested.add(parentOf(relative(info.path)));
  }
  return outermost(nested);
}

/** What {@link snapshotFolder} found besides the files it took. */
export interface SnapshotReport {
  /** Directories holding a repository of their own: a `.git` directory, or a `gitdir:` file */
  nested: string[];
  /** Paths left out, each once (a nested repository by its directory) */
  skipped: SkippedPath[];
}

/**
 * Every file of the folder `skip` keeps, stored as a blob. A file the cache knows with the
 * same size and modification time is not read again, unless that time was within the racy
 * window of when the cache read it (a later write in the same clock tick would look the same).
 * Left out, and listed in `report`: files of nested repositories (a directory holding a
 * `.git` directory or a `gitdir:` file), and names no tree may hold (`.git`, the
 * temporary-file prefix, `..`). A checkout's own temporary files are left out silently.
 */
export async function snapshotFolder(
  history: History,
  folder: FilesApi,
  options: SnapshotOptions = {},
  report: SnapshotReport = { nested: [], skipped: [] },
): Promise<FolderSnapshot> {
  const skip = options.skip ?? defaultIgnore;
  const window = options.racyWindowMs ?? DEFAULT_RACY_WINDOW_MS;
  const files: FolderSnapshot = new Map();
  const infos: { path: string; size: number; lastModified: number; at: string }[] = [];
  const nested = new Set<string>();
  for await (const info of folder.list("/", { recursive: true })) {
    const path = relative(info.path);
    if (!options.nested && (await isGitEntry(folder, info))) nested.add(parentOf(path));
    if (info.kind === "file") infos.push({ ...info, path, at: info.path });
  }
  const roots = options.nested ? [...options.nested].sort() : outermost(nested);
  const inNested = under(roots);
  report.nested.push(...roots);
  for (const root of roots) {
    if (!skip(root)) report.skipped.push({ path: root, reason: "nested-repository" });
  }
  for (const info of infos) {
    const { path } = info;
    if (isCheckoutTempFile(path)) {
      options.tempFiles?.set(path, info.lastModified);
      continue;
    }
    if (skip(path) || inNested(path)) continue;
    if (!isSafePath(path)) {
      const reserved = isSyncTempFile(path) || /(^|\/)\.git$/i.test(path);
      report.skipped.push({ path, reason: reserved ? "reserved-name" : "unsafe-path" });
      continue;
    }
    const known = options.rehashAll ? undefined : options.cache?.get(path);
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
    const id = await history.blobs.store(folder.read(info.at));
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
function hex(value: number, width: number): string {
  return Math.floor(value).toString(16).padStart(width, "0").slice(-width);
}
function tempPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? `${path.slice(0, slash)}/` : "";
  tempCounter = (tempCounter + 1) % 0x10000;
  const random = hex(Math.random() * 0x100000000, 8);
  return `${dir}${SYNC_TEMP_MARK}${hex(Date.now(), 12)}-${hex(tempCounter, 4)}-${random}`;
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
    const p = relative(info.path);
    // a checkout's own leftover temporary files may go
    if (info.kind === "file" && isCheckoutTempFile(p)) continue;
    // a nested repository (a `.git` inside) is never expendable, whatever `ignore` says
    if (!isSafePath(p)) throw new FolderChangedError(p);
    if (info.kind !== "file") continue;
    if (!expendable(p)) throw new FolderChangedError(p);
  }
  await folder.remove(`/${path}`);
}

/** Whether the directory at `path` holds only what {@link clearDirectory} may remove. */
export async function isExpendableDirectory(
  folder: FilesApi,
  path: string,
  expendable: IgnorePath,
): Promise<boolean> {
  for await (const info of folder.list(`/${path}`, { recursive: true })) {
    const p = relative(info.path);
    if (info.kind === "file" && isCheckoutTempFile(p)) continue;
    if (!isSafePath(p)) return false;
    if (info.kind === "file" && !expendable(p)) return false;
  }
  return true;
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
  /** Each path brought to `to`, as it is done (kept when the checkout is cut short) */
  progress?: string[];
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
    options.progress?.push(path);
  }
  for (const [path, entry] of to) {
    const next = inFolder(entry);
    if (!next || skipWrite(path) || inFolder(from.get(path))?.id === next.id) continue;
    const r = await applyFolderPath(history, folder, path, next, {
      accept: accept(path),
      expendable: options.expendable,
    });
    if (r === "written") done.written.push(path);
    options.progress?.push(path);
  }
  return done;
}

/**
 * Removes temporary checkout files older than `olderThanMs` (left by a crash). Only names
 * of the exact form a checkout writes are removed; any other file with the reserved prefix is
 * left alone (and never committed).
 */
export async function sweepTempFiles(
  folder: FilesApi,
  tempFiles: Map<string, number>,
  olderThanMs = 10 * 60_000,
): Promise<string[]> {
  const removed: string[] = [];
  const now = Date.now();
  for (const [path, lastModified] of tempFiles) {
    if (now - lastModified < olderThanMs) continue;
    if (!isCheckoutTempFile(path)) continue;
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
