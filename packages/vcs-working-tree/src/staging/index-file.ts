/**
 * Reading and writing the index file the way git does.
 *
 * Writes follow git's lock-file protocol: create `<index>.lock` only if it does
 * not exist yet, stream the new index into it, then rename it over `<index>`. A
 * lock that is already there means another writer (or a crashed one) holds the
 * index, and the write fails as git's does, leaving the index alone. A write that
 * fails halfway removes its lock, so the old index stays in place and nothing is
 * left behind.
 *
 * The lock is created with `atomicFilesOver(...).createExclusive`. When the
 * FilesApi has `createExclusive` (an `O_EXCL` create), that is used, and the lock
 * excludes other processes and tabs. Without it, `createExclusive` checks for the
 * file and then writes it: that excludes every writer sharing one FilesApi
 * instance (their creates run one at a time) and any lock file already on disk,
 * such as native git's, but not another process that creates the lock in the
 * same instant.
 *
 * Once it holds the lock, a write by `IndexFile` also checks that the index is
 * still the one it read (by its trailing checksum), so a change made by native
 * git between our read and our write is refused instead of overwritten.
 */
import { readFile } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { atomicFilesOver, type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import {
  type CacheTree,
  encodeCacheTree,
  invalidateCacheTreePath,
  parseCacheTree,
} from "./cache-tree.js";
import {
  assertWritableIndexExtensions,
  carryIndexExtensions,
  encodeResolveUndo,
  parseResolveUndo,
  type ResolveUndoRecord,
} from "./index-extensions.js";
import {
  encodeIndexFileBytes,
  INDEX_VERSION_2,
  type IndexExtension,
  type IndexVersion,
  parseIndexFile,
} from "./index-format.js";
import type { StagingEntry } from "./types.js";

/** `<index>.lock` exists: another process holds the index, or one crashed while holding it. */
export class IndexLockedError extends Error {
  override name = "IndexLockedError";
  readonly code = "EEXIST";
  constructor(readonly lockPath: string) {
    super(
      `Unable to create '${lockPath}': File exists.\n\n` +
        "Another git process seems to be running in this repository. If no other git " +
        "process is running, a process crashed earlier: remove the file manually to continue.",
    );
  }
}

/**
 * The index on disk is not the one that was read: another writer (native git,
 * say) changed it in between. Nothing was written; read the index again and
 * redo the change.
 */
export class IndexChangedError extends Error {
  override name = "IndexChangedError";
  constructor(readonly indexPath: string) {
    super(`'${indexPath}': index changed on disk since it was read; re-read and retry`);
  }
}

/** Size of the trailing SHA-1 checksum of an index file. */
const INDEX_CHECKSUM_SIZE = 20;

/**
 * The trailing checksum of the index at `indexPath` as hex, or `null` when
 * there is no index file. Reads only the last 20 bytes.
 */
export async function readIndexChecksum(
  files: FilesApi,
  indexPath: string,
): Promise<string | null> {
  const stats = await files.stats(indexPath);
  if (stats?.kind !== "file") return null;
  const size = stats.size ?? 0;
  if (size < INDEX_CHECKSUM_SIZE) return "";
  const tail = new Uint8Array(INDEX_CHECKSUM_SIZE);
  let at = 0;
  for await (const chunk of files.read(indexPath, {
    start: size - INDEX_CHECKSUM_SIZE,
    length: INDEX_CHECKSUM_SIZE,
  })) {
    const n = Math.min(chunk.length, INDEX_CHECKSUM_SIZE - at);
    tail.set(chunk.subarray(0, n), at);
    at += n;
    if (at === INDEX_CHECKSUM_SIZE) break;
  }
  return bytesToHex(tail.subarray(0, at));
}

/**
 * Remove `<gitDir>/index.lock`, left behind by a writer that crashed while it
 * held the index. Use it only when no other writer can be running: on OPFS or
 * in memory there is no process to ask, and a lock removed under a live
 * writer lets two writes race. (For an index elsewhere, remove `<index>.lock`.)
 *
 * @example
 * ```typescript
 * await breakIndexLock(files, ".git");
 * ```
 *
 * @returns `true` when a lock was there and has been removed
 */
export async function breakIndexLock(files: FilesApi, gitDir: string): Promise<boolean> {
  return atomicFilesOver(files, "").remove(joinPath(gitDir, "index.lock"));
}

export interface IndexWriteOptions {
  /** Index format version (default 2). */
  version?: IndexVersion;
  /** Extensions to write after the entries, as given. */
  extensions?: readonly IndexExtension[];
  /**
   * How long to keep retrying while `<index>.lock` exists, in milliseconds
   * (default 0: fail at once, as git does).
   */
  lockTimeoutMs?: number;
  /**
   * The index the write expects to replace, checked once the lock is held:
   * its trailing checksum (see `readIndexChecksum`), or `null` for "no index
   * file". On a mismatch the write throws `IndexChangedError`. Leave it out to
   * replace whatever is there.
   */
  expectedChecksum?: string | null;
}

const RETRY_DELAY_MS = 20;

/**
 * Write an index file through `<indexPath>.lock`.
 *
 * Entries are validated before the lock is taken, so invalid input never
 * touches the file system.
 *
 * @example
 * ```typescript
 * await writeIndexFile(files, ".git/index", entries);
 * ```
 *
 * @returns The trailing checksum of the index written, as hex
 * @throws IndexLockedError when the lock exists (after `lockTimeoutMs`)
 * @throws IndexChangedError when `expectedChecksum` is given and the index differs
 */
export async function writeIndexFile(
  files: FilesApi,
  indexPath: string,
  entries: readonly StagingEntry[],
  options: IndexWriteOptions = {},
): Promise<string> {
  // validates every path and object id now, before the lock exists
  const { bytes: content, checksum } = await encodeIndexFileBytes(
    entries,
    options.version ?? INDEX_VERSION_2,
    options.extensions,
  );
  // the lock is created holding the new index: one exclusive create, then one rename
  const lockPath = `${indexPath}.lock`;
  const atomic = atomicFilesOver(files, "");
  const deadline = Date.now() + (options.lockTimeoutMs ?? 0);
  while (!(await atomic.createExclusive(lockPath, content))) {
    if (Date.now() >= deadline) throw new IndexLockedError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  try {
    if (options.expectedChecksum !== undefined) {
      const current = await readIndexChecksum(files, indexPath);
      if (current !== options.expectedChecksum) throw new IndexChangedError(indexPath);
    }
    await atomic.replace(lockPath, indexPath);
  } catch (error) {
    await atomic.remove(lockPath).catch(() => {});
    throw error;
  }
  return bytesToHex(checksum);
}

/**
 * One index file, with what was read from it that a rewrite must carry over:
 * its version and its extensions. Shared by the file-backed `Staging`
 * implementations.
 *
 * @internal
 */
export class IndexFile {
  version: IndexVersion = INDEX_VERSION_2;
  private extensions: IndexExtension[] = [];
  /**
   * The entries read or written, when an extension depends on them (entries are never
   * changed in place: the references are the snapshot).
   */
  private entriesKept: readonly StagingEntry[] | undefined;
  /** A cache-tree computed for the entries of the next write (see `setCacheTree`). */
  private pendingCacheTree: CacheTree | undefined;
  /** Why the last read refused the index; writes refuse it too until a read succeeds. */
  private refused: Error | undefined;
  /**
   * The index this instance last read or wrote, by trailing checksum; `null`
   * when there was no index file; `undefined` before the first read, when a
   * write replaces whatever is there.
   */
  private checksum: string | null | undefined;

  constructor(
    private readonly files: FilesApi,
    readonly path: string,
    private readonly options: { lockTimeoutMs?: number } = {},
  ) {}

  /** The checksum of the index this instance last read or wrote (`null`: none; `undefined`: never read). */
  get currentChecksum(): string | null | undefined {
    return this.checksum;
  }

  /** A fresh instance over the same file (same options), for a read-modify-write of its own. */
  fresh(): IndexFile {
    return new IndexFile(this.files, this.path, this.options);
  }

  /** Takes over what `other` (over the same file) last read or wrote. */
  adopt(other: IndexFile): void {
    this.checksum = other.checksum;
    this.version = other.version;
    this.extensions = other.extensions;
    this.entriesKept = other.entriesKept;
    this.refused = other.refused;
  }

  /**
   * The entries and modification time, or nothing when there is no index file.
   *
   * @throws UnsupportedIndexExtensionError for an index with a required extension
   *   (a split or sparse index), whose entries cannot be read without it
   */
  async read(): Promise<{ entries: StagingEntry[]; lastModified: number } | undefined> {
    const stats = await this.files.stats(this.path);
    if (!stats) {
      this.extensions = [];
      this.entriesKept = undefined;
      this.refused = undefined;
      this.checksum = null;
      return undefined;
    }
    const data = await readFile(this.files, this.path);
    const parsed = await parseIndexFile(data);
    try {
      assertWritableIndexExtensions(parsed.extensionData);
      this.refused = undefined;
    } catch (error) {
      // do not let a later write replace an index we could not read
      this.refused = error as Error;
      throw error;
    }
    this.checksum = bytesToHex(data.subarray(Math.max(0, data.length - INDEX_CHECKSUM_SIZE)));
    this.version = parsed.version;
    this.extensions = parsed.extensionData;
    this.entriesKept = this.extensions.length > 0 ? parsed.entries.slice() : undefined;
    // the index file's own mtime; unknown is 0 (every entry racy), never "now"
    return { entries: parsed.entries, lastModified: stats.lastModified ?? 0 };
  }

  /**
   * Drop the resolve-undo records (`REUC`) on the next write, as git does when
   * it reads a whole tree into the index (`read-tree`, `reset`).
   */
  clearResolveUndo(): void {
    this.extensions = this.extensions.filter((e) => e.signature !== "REUC");
  }

  /**
   * Record what a resolution removed (git's `record_resolve_undo`): each record's stages
   * are set in the path's resolve-undo record (the others it had kept), written with the
   * index as the `REUC` extension, sorted by path.
   */
  recordResolveUndo(records: readonly ResolveUndoRecord[]): void {
    if (records.length === 0) return;
    const existing = this.extensions.find((e) => e.signature === "REUC");
    let list: ResolveUndoRecord[] = [];
    if (existing) {
      try {
        list = parseResolveUndo(existing.data);
      } catch {
        list = [];
      }
    }
    const byPath = new Map(list.map((r) => [r.path, r]));
    for (const record of records) {
      const before = byPath.get(record.path);
      const modes = [...(before?.modes ?? [0, 0, 0])] as ResolveUndoRecord["modes"];
      const objectIds = [
        ...(before?.objectIds ?? [undefined, undefined, undefined]),
      ] as ResolveUndoRecord["objectIds"];
      for (let k = 0; k < 3; k++) {
        if (record.modes[k] !== 0) {
          modes[k] = record.modes[k];
          objectIds[k] = record.objectIds[k];
        }
      }
      byPath.set(record.path, { path: record.path, modes, objectIds });
    }
    const sorted = [...byPath.values()].sort((a, b) => compareGitPaths(a.path, b.path));
    const reuc = { signature: "REUC", data: encodeResolveUndo(sorted) };
    const others = this.extensions.filter((e) => e.signature !== "REUC");
    // git writes it after the cache-tree
    const at = others.findIndex((e) => e.signature === "TREE") + 1;
    this.extensions = [...others.slice(0, at), reuc, ...others.slice(at)];
  }

  /**
   * Write `tree` as the `TREE` extension with the next `write` (git's cache-tree after
   * `unpack_trees` or `write_index_as_tree`), replacing what was read. It must describe the
   * entries that write is given; a valid root whose count disagrees with them is dropped.
   */
  setCacheTree(tree: CacheTree | undefined): void {
    this.pendingCacheTree = tree;
  }

  /**
   * The cache-tree of the index as last read or written (its `TREE` extension), when
   * `entries` are the ones it was read or written with; undefined otherwise or when it
   * cannot be parsed. A fresh copy each time.
   */
  cacheTree(entries: readonly StagingEntry[]): CacheTree | undefined {
    const ext = this.extensions.find((e) => e.signature === "TREE");
    if (!ext || this.entriesKept === undefined) return undefined;
    let tree: CacheTree;
    try {
      tree = parseCacheTree(ext.data);
    } catch {
      return undefined;
    }
    // the entries changed since: each path changed invalid, as git's index edits invalidate
    // it (cache_tree_invalidate_path from add_index_entry and remove_index_entry_at)
    invalidateChangedPaths(tree, this.entriesKept, entries);
    return tree;
  }

  /**
   * Write `entries` (sorted by path, stage) with the extensions that still apply.
   *
   * @throws IndexChangedError when the index on disk is no longer the one this
   *   instance last read or wrote; nothing is written
   */
  async write(entries: readonly StagingEntry[]): Promise<void> {
    if (this.refused) throw this.refused;
    // what indexEntriesDigest compares: path, stage, mode, object id, intent-to-add
    const changed = this.entriesKept === undefined || !sameIndexEntries(this.entriesKept, entries);
    let extensions = carryIndexExtensions(this.extensions, entries, changed);
    // without a cache-tree computed for these entries, the one read or last written goes on
    // with each changed path invalid (git keeps the nodes no edit touched valid)
    const tree = this.pendingCacheTree ?? (changed ? this.cacheTree(entries) : undefined);
    this.pendingCacheTree = undefined;
    if (tree && describesEntries(tree, entries)) {
      // git writes the cache-tree first
      extensions = [
        { signature: "TREE", data: encodeCacheTree(tree) },
        ...extensions.filter((e) => e.signature !== "TREE"),
      ];
    }
    this.checksum = await writeIndexFile(this.files, this.path, entries, {
      version: this.version,
      extensions,
      lockTimeoutMs: this.options.lockTimeoutMs,
      expectedChecksum: this.checksum,
    });
    this.extensions = extensions;
    this.entriesKept = extensions.length > 0 ? entries.slice() : undefined;
  }
}

/** Whether a cache-tree can stand for `entries`: a valid root counts their tree entries. */
function describesEntries(tree: CacheTree, entries: readonly StagingEntry[]): boolean {
  if (tree.entryCount < 0) return true;
  let count = 0;
  for (const e of entries) {
    if (e.stage !== 0) return false;
    if (!(e.intentToAdd && !e.skipWorktree)) count++;
  }
  return count === tree.entryCount;
}

/** Whether two entry lists agree on what an entry-derived extension depends on. */
function sameIndexEntries(a: readonly StagingEntry[], b: readonly StagingEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (
      x.path !== y.path ||
      x.stage !== y.stage ||
      x.mode !== y.mode ||
      x.objectId !== y.objectId ||
      (x.intentToAdd ? 1 : 0) !== (y.intentToAdd ? 1 : 0)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Invalidate in `tree` (the cache-tree of the entries `before`) every path whose entries
 * differ in `after` (path, stage, mode, object id, intent-to-add): one added, removed or
 * changed, as git's index edits invalidate it. Both lists are sorted by path and stage.
 */
export function invalidateChangedPaths(
  tree: CacheTree,
  before: readonly StagingEntry[],
  after: readonly StagingEntry[],
): void {
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const x = before[i];
    const y = after[j];
    if (x === y) {
      i++;
      j++;
      continue;
    }
    const order =
      x === undefined
        ? 1
        : y === undefined
          ? -1
          : compareGitPaths(x.path, y.path) || x.stage - y.stage;
    if (order < 0) {
      invalidateCacheTreePath(tree, x.path);
      i++;
    } else if (order > 0) {
      invalidateCacheTreePath(tree, (y as StagingEntry).path);
      j++;
    } else {
      const a = x as StagingEntry;
      const b = y as StagingEntry;
      if (
        a.mode !== b.mode ||
        a.objectId !== b.objectId ||
        (a.intentToAdd ? 1 : 0) !== (b.intentToAdd ? 1 : 0)
      ) {
        invalidateCacheTreePath(tree, b.path);
      }
      i++;
      j++;
    }
  }
}
