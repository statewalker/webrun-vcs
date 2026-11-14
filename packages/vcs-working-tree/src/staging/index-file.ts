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
import { atomicFilesOver, type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import {
  assertWritableIndexExtensions,
  carryIndexExtensions,
  indexEntriesDigest,
} from "./index-extensions.js";
import {
  encodeIndexFile,
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
  const content = encodeIndexFile(entries, options.version ?? INDEX_VERSION_2, options.extensions);
  const lockPath = `${indexPath}.lock`;
  const atomic = atomicFilesOver(files, "");
  const deadline = Date.now() + (options.lockTimeoutMs ?? 0);
  while (!(await atomic.createExclusive(lockPath, new Uint8Array(0)))) {
    if (Date.now() >= deadline) throw new IndexLockedError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  let checksum = "";
  function* tracked(): Generator<Uint8Array> {
    for (const chunk of content) {
      checksum = bytesToHex(chunk); // the last chunk is the checksum
      yield chunk;
    }
  }
  try {
    if (options.expectedChecksum !== undefined) {
      const current = await readIndexChecksum(files, indexPath);
      if (current !== options.expectedChecksum) throw new IndexChangedError(indexPath);
    }
    await files.write(lockPath, tracked());
    await atomic.replace(lockPath, indexPath);
  } catch (error) {
    await atomic.remove(lockPath).catch(() => {});
    throw error;
  }
  return checksum;
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
  /** Digest of the entries read, when an extension depends on them. */
  private entriesDigest: string | undefined;
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
      this.entriesDigest = undefined;
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
    this.entriesDigest =
      this.extensions.length > 0 ? indexEntriesDigest(parsed.entries) : undefined;
    return { entries: parsed.entries, lastModified: stats.lastModified ?? Date.now() };
  }

  /**
   * Drop the resolve-undo records (`REUC`) on the next write, as git does when
   * it reads a whole tree into the index (`read-tree`, `reset`).
   */
  clearResolveUndo(): void {
    this.extensions = this.extensions.filter((e) => e.signature !== "REUC");
  }

  /**
   * Write `entries` (sorted by path, stage) with the extensions that still apply.
   *
   * @throws IndexChangedError when the index on disk is no longer the one this
   *   instance last read or wrote; nothing is written
   */
  async write(entries: readonly StagingEntry[]): Promise<void> {
    if (this.refused) throw this.refused;
    const changed =
      this.entriesDigest === undefined || indexEntriesDigest(entries) !== this.entriesDigest;
    const extensions = carryIndexExtensions(this.extensions, entries, changed);
    this.checksum = await writeIndexFile(this.files, this.path, entries, {
      version: this.version,
      extensions,
      lockTimeoutMs: this.options.lockTimeoutMs,
      expectedChecksum: this.checksum,
    });
    this.extensions = extensions;
    this.entriesDigest = extensions.length > 0 ? indexEntriesDigest(entries) : undefined;
  }
}
