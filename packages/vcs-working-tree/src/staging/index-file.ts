/**
 * Reading and writing the index file the way git does.
 *
 * Writes follow git's lock-file protocol: create `<index>.lock` exclusively,
 * stream the new index into it, then rename it over `<index>`. A lock that is
 * already there means another writer (or a crashed one) holds the index, and the
 * write fails as git's does, leaving the index alone. A write that fails halfway
 * removes its lock, so the old index stays in place and nothing is left behind.
 */
import { readFile } from "@statewalker/vcs-core";
import { atomicFilesOver, type FilesApi } from "@statewalker/vcs-utils/files";
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
 * @throws IndexLockedError when the lock exists (after `lockTimeoutMs`)
 */
export async function writeIndexFile(
  files: FilesApi,
  indexPath: string,
  entries: readonly StagingEntry[],
  options: IndexWriteOptions = {},
): Promise<void> {
  // validates every path and object id now, before the lock exists
  const content = encodeIndexFile(entries, options.version ?? INDEX_VERSION_2, options.extensions);
  const lockPath = `${indexPath}.lock`;
  const atomic = atomicFilesOver(files, "");
  const deadline = Date.now() + (options.lockTimeoutMs ?? 0);
  while (!(await atomic.createExclusive(lockPath, new Uint8Array(0)))) {
    if (Date.now() >= deadline) throw new IndexLockedError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  try {
    await files.write(lockPath, content);
    await atomic.replace(lockPath, indexPath);
  } catch (error) {
    await atomic.remove(lockPath).catch(() => {});
    throw error;
  }
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
      return undefined;
    }
    const parsed = await parseIndexFile(await readFile(this.files, this.path));
    try {
      assertWritableIndexExtensions(parsed.extensionData);
      this.refused = undefined;
    } catch (error) {
      // do not let a later write replace an index we could not read
      this.refused = error as Error;
      throw error;
    }
    this.version = parsed.version;
    this.extensions = parsed.extensionData;
    this.entriesDigest =
      this.extensions.length > 0 ? indexEntriesDigest(parsed.entries) : undefined;
    return { entries: parsed.entries, lastModified: stats.lastModified ?? Date.now() };
  }

  /** Write `entries` (sorted by path, stage) with the extensions that still apply. */
  async write(entries: readonly StagingEntry[]): Promise<void> {
    if (this.refused) throw this.refused;
    const changed =
      this.entriesDigest === undefined || indexEntriesDigest(entries) !== this.entriesDigest;
    const extensions = carryIndexExtensions(this.extensions, entries, changed);
    await writeIndexFile(this.files, this.path, entries, {
      version: this.version,
      extensions,
      lockTimeoutMs: this.options.lockTimeoutMs,
    });
    this.extensions = extensions;
    this.entriesDigest = extensions.length > 0 ? indexEntriesDigest(entries) : undefined;
  }
}
