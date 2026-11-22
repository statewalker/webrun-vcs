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
import { readFile, type Trees } from "@statewalker/vcs-core";
import { bytesToHex, sha1 } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { atomicFilesOver, type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import {
  encodeUntrackedCache,
  invalidateUntrackedPath,
  parseUntrackedCache,
  type UntrackedCache,
} from "../status/untracked-cache.js";
import {
  type CacheTree,
  cacheTreeFullyValid,
  copyCacheTree,
  encodeCacheTree,
  invalidateCacheTreePath,
  parseCacheTree,
  storeCacheTree,
} from "./cache-tree.js";
import {
  assertWritableIndexExtensions,
  carryIndexExtensions,
  encodeResolveUndo,
  parseResolveUndo,
  type ResolveUndoRecord,
  UnsupportedIndexExtensionError,
} from "./index-extensions.js";
import {
  encodeIndexFileBytes,
  encodeIndexInOrder,
  INDEX_VERSION_2,
  type IndexEncoding,
  type IndexExtension,
  type IndexVersion,
  parseIndexFile,
  validateIndexEntryPaths,
} from "./index-format.js";
import {
  collapseSparseIndex,
  expandSparseIndex,
  isSparseDirectoryEntry,
  recollapseSparseIndex,
  SPARSE_DIRECTORIES_EXTENSION,
  sparseIndexMatches,
} from "./sparse-index.js";
import {
  adoptSharedIndex,
  classifySplitEntries,
  freshenFile,
  isNullIndexId,
  mergeSplitIndex,
  parseLinkExtension,
  prepareSplitWrite,
  readSharedIndex,
  rememberSplitWrite,
  type SharedIndex,
  type SplitClassification,
  sharedIndexPath,
  tooManyNotSharedEntries,
} from "./split-index.js";
import type { StagingEntry } from "./types.js";

/**
 * What a write of the index follows from the repository's configuration, as git reads it
 * when it writes (`write_locked_index`, `convert_to_sparse`). Every field may be left out.
 */
export interface IndexSettings {
  /**
   * `core.splitIndex`: true splits the index (a shared index is written), false writes it
   * whole again; undefined (unset) keeps it as it was read.
   */
  splitIndex?: boolean;
  /**
   * `splitIndex.maxPercentChange` (default 20): a new shared index is written when more than
   * this percentage of the entries are not in the shared one; 0 always, 100 never.
   */
  maxPercentChange?: number;
  /**
   * `splitIndex.sharedIndexExpire` as a time (seconds since the epoch): when a new shared
   * index is written, the other shared indexes not used since are removed; 0 never removes
   * any. Default: two weeks before now.
   */
  sharedIndexExpireBefore?: number;
  /**
   * `core.sharedRepository` as git's `git_config_perm` returns it (0 for `umask`, `0660`
   * for `group`, `0664` for `all`, the negated mode for an octal one): the shared index's
   * permission bits are adjusted as `adjust_shared_perm` does.
   */
  sharedRepository?: number;
  /**
   * Set when a sparse index may be written (git's `is_sparse_index_allowed`: `index.sparse`,
   * `core.sparseCheckout`, `core.sparseCheckoutCone` and cone-shaped patterns): the patterns'
   * `path_in_sparse_checkout`.
   */
  sparse?: { includes(path: string): boolean };
  /**
   * Whether the write follows an unpack-trees-like rebuild of the index (checkout, reset,
   * merge): a split index then deletes the shared entry of a path whose object changed and
   * writes the new entry whole, where an edit in place (add, refresh) writes a replacement.
   */
  unpackTrees?: boolean;
  /**
   * Paths whose entries the write removes and adds again (`git apply` edits the index so): in
   * a split index such a path's shared entry is deleted and the new entry written whole.
   */
  readded?: ReadonlySet<string>;
  /**
   * `index.skipHash` (default `feature.manyFiles`): the index file is written with a null
   * trailer instead of its SHA-1 (do_write_index's `skip_hash`). A new shared index of a split
   * index is still hashed: its name and the link's id are that hash (git would write
   * `sharedindex.0000…` and a link naming no shared index, losing the entries).
   */
  skipHash?: boolean;
}

/**
 * What an index file reads from the repository around it (see `Staging.setIndexHost`).
 *
 * ```typescript
 * staging.setIndexHost?.({ settings: () => ({ splitIndex: true }), trees: history.trees });
 * ```
 */
export interface IndexHost {
  /**
   * The configuration of the next write, asked once per write (and when a read or
   * `wantsRewrite` needs it): it must not change what it answers, so state meant for one write
   * (`readded`) is cleared from `written`, not here.
   */
  settings?(): IndexSettings | Promise<IndexSettings>;
  /** Called once a write used the settings (the index file or its lock written). */
  written?(): void;
  /** The trees a sparse index expands from (`load`) and collapses into (`store`) */
  trees?: Pick<Trees, "load" | "store">;
}

/** A split index's state: its shared index (undefined: none yet, or a link naming none). */
interface SplitState {
  shared?: SharedIndex;
  /** Split by `core.splitIndex=true` since it was read (git's `SPLIT_INDEX_ORDERED`) */
  ordered?: boolean;
}

/** An index file's bytes as decoded: the entries in memory, full and merged. */
interface DecodedIndex {
  entries: StagingEntry[];
  version: IndexVersion;
  extensions: IndexExtension[];
  encoding: IndexEncoding | undefined;
  split: SplitState | undefined;
  /** The sparse directories of a sparse index (paths with their trailing slash) */
  sparseDirs: string[] | undefined;
}

/** What a write puts on disk, and what it does around the index file's rename. */
interface IndexWritePlan {
  bytes: Uint8Array;
  checksum: Uint8Array;
  encoding: IndexEncoding | undefined;
  /** The extensions the instance holds once written (the full index's) */
  extensions: IndexExtension[];
  split: SplitState | undefined;
  /** The sparse directories written (a sparse index) */
  sparseDirs?: string[];
  /** Run before the index file is in place (a new shared index written) */
  before?: () => Promise<void>;
  /** Run once the index file is in place */
  after?: () => Promise<void>;
}

/** git's `init_split_index` death for a sparse index asked to be split (`core.splitIndex`). */
export const SPLIT_WITH_SPARSE = "cannot use split index with a sparse index";

/** Two weeks, in seconds: git's default `splitIndex.sharedIndexExpire`. */
const TWO_WEEKS = 14 * 24 * 60 * 60;

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

/** Prefix of the identity of an index whose trailer is null (see {@link indexFileIdentity}). */
const NULL_TRAILER_IDENTITY = "skiphash:";

/**
 * What tells one index file's bytes from another's: the trailing checksum as hex, or, for a
 * null trailer (`index.skipHash`, which every write under that setting has), `skiphash:` and
 * the SHA-1 of the whole file, since the trailer then says nothing about the content.
 */
export async function indexFileIdentity(data: Uint8Array): Promise<string> {
  const tail = data.subarray(Math.max(0, data.length - INDEX_CHECKSUM_SIZE));
  if (tail.length === INDEX_CHECKSUM_SIZE && tail.every((b) => b === 0)) {
    return NULL_TRAILER_IDENTITY + bytesToHex(await sha1(data));
  }
  return bytesToHex(tail);
}

/**
 * The identity of the index at `indexPath` ({@link indexFileIdentity}: its trailing checksum
 * as hex), or `null` when there is no index file. Reads only the last 20 bytes, unless they
 * are null (`index.skipHash`): the whole file is then read and hashed.
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
  if (at === INDEX_CHECKSUM_SIZE && tail.every((b) => b === 0)) {
    return indexFileIdentity(await readFile(files, indexPath));
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
  /** Entries as encoded before (an index read or written): their bytes are copied */
  source?: IndexEncoding;
  /** Called with the entries as encoded in the index written */
  onEncoding?: (encoding: IndexEncoding) => void;
  /** A null trailer instead of the SHA-1 (`index.skipHash`) */
  skipHash?: boolean;
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
 * @returns The identity of the index written: its trailing checksum as hex (see
 *   `indexFileIdentity` for a null trailer)
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
  const { bytes: content, encoding } = await encodeIndexFileBytes(
    entries,
    options.version ?? INDEX_VERSION_2,
    options.extensions,
    {
      ...(options.source ? { source: options.source } : {}),
      ...(options.skipHash ? { skipHash: true } : {}),
    },
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
  if (encoding) options.onEncoding?.(encoding);
  return indexFileIdentity(content);
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
  /** The entries as encoded in the index last read or written: a write copies their bytes */
  private encoding: IndexEncoding | undefined;
  private extensions: IndexExtension[] = [];
  /**
   * The entries read or written, when an extension depends on them (entries are never
   * changed in place: the references are the snapshot).
   */
  private entriesKept: readonly StagingEntry[] | undefined;
  /** A cache-tree computed for the entries of the next write (see `setCacheTree`). */
  private pendingCacheTree: CacheTree | undefined;
  /** `setCacheTree(undefined)`: the next write carries no cache-tree at all. */
  private dropCacheTree = false;
  /** The entries `pendingCacheTree` describes, when given: the write invalidates what changed since. */
  private pendingEntries: readonly StagingEntry[] | undefined;
  /**
   * The untracked cache for the next write (`setUntrackedCache`): a cache, `null` to write
   * none, undefined to carry the one read (its touched directories invalidated).
   */
  private pendingUntracked: UntrackedCache | null | undefined;
  /** The entries `pendingUntracked` describes: the write invalidates the paths added since. */
  private pendingUntrackedEntries: readonly StagingEntry[] | undefined;
  /** Why the last read refused the index; writes refuse it too until a read succeeds. */
  private refused: Error | undefined;
  /**
   * The index this instance last read or wrote, by trailing checksum; `null`
   * when there was no index file; `undefined` before the first read, when a
   * write replaces whatever is there.
   */
  private checksum: string | null | undefined;

  /** The split index's state; undefined for an index written whole */
  private split: SplitState | undefined;
  /** The entries of a split index as last read or written (what a write replaces) */
  private lastEntries: readonly StagingEntry[] = [];
  /** The sparse directories of the sparse index last read or written */
  private sparseDirs: string[] | undefined;
  /** What this file reads from the repository (`setHost`) */
  private host: IndexHost | undefined;

  constructor(
    private readonly files: FilesApi,
    readonly path: string,
    private readonly options: {
      lockTimeoutMs?: number;
      gitDir?: string;
      host?: IndexHost;
      /** The trees used when the host gives none (a sparse index read before any host is set) */
      defaultTrees?: Pick<Trees, "load" | "store">;
      /** A sparse index's sparse directory entries kept as they are (read only: never written) */
      keepSparseDirectories?: boolean;
      /**
       * Check the index's trailing SHA-1 on read, as git's fsck alone does
       * (`verify_index_checksum`); other reads take the trailer as it is
       */
      verifyChecksum?: boolean;
    } = {},
  ) {
    this.host = options.host;
  }

  /** The checksum of the index this instance last read or wrote (`null`: none; `undefined`: never read). */
  get currentChecksum(): string | null | undefined {
    return this.checksum;
  }

  /** Sets what the file reads from the repository: configuration and trees (see `IndexHost`). */
  setHost(host: IndexHost | undefined): void {
    this.host = host;
  }

  /** The host `setHost` set. */
  getHost(): IndexHost | undefined {
    return this.host;
  }

  /**
   * Whether the configuration asks for the index file to be written again although no entry
   * changed: `core.splitIndex` splits an index read whole, or unsplits one read split (git
   * marks the index changed then: `SPLIT_INDEX_ORDERED`, `remove_split_index`).
   */
  async wantsRewrite(): Promise<boolean> {
    if (this.refused || this.checksum === undefined || this.checksum === null) return false;
    const settings = (await this.host?.settings?.()) ?? {};
    if (settings.splitIndex === true && this.split === undefined && this.sparseDirs !== undefined) {
      throw new Error(SPLIT_WITH_SPARSE);
    }
    if (settings.splitIndex === true) return this.split === undefined;
    if (settings.splitIndex === false) return this.split !== undefined;
    return false;
  }

  /** Whether the index was read (or last written) as a sparse index. */
  get isSparse(): boolean {
    return this.sparseDirs !== undefined;
  }

  /** Whether the index was read (or last written) as a split index. */
  get isSplit(): boolean {
    return this.split !== undefined;
  }

  /** A fresh instance over the same file (same options and host), for a read-modify-write of its own. */
  fresh(): IndexFile {
    return new IndexFile(this.files, this.path, { ...this.options, host: this.host });
  }

  /** Takes over what `other` (over the same file) last read or wrote. */
  adopt(other: IndexFile): void {
    this.checksum = other.checksum;
    this.version = other.version;
    this.extensions = other.extensions;
    this.entriesKept = other.entriesKept;
    this.refused = other.refused;
    this.encoding = other.encoding;
    this.split = other.split;
    this.lastEntries = other.lastEntries;
    this.sparseDirs = other.sparseDirs;
  }

  /** The repository's git directory: where shared indexes live (the index's directory by default). */
  private get gitDir(): string {
    if (this.options.gitDir !== undefined) return this.options.gitDir;
    const slash = this.path.lastIndexOf("/");
    return slash < 0 ? "" : this.path.slice(0, slash);
  }

  /**
   * The entries and extensions of an index file's bytes, as git's `read_index_from` leaves
   * them: a split index merged with its shared index (`merge_base_index`), a sparse index
   * expanded (`ensure_full_index`, which needs the host's trees).
   *
   * @throws UnsupportedIndexExtensionError for another required extension, or a sparse index
   *   without trees to expand it from
   */
  private async decode(data: Uint8Array): Promise<DecodedIndex> {
    const parsed = await parseIndexFile(data, {
      keepEncoding: true,
      verifyChecksum: this.options.verifyChecksum === true,
    });
    let linkData: Uint8Array | undefined;
    let sparse = false;
    const others: IndexExtension[] = [];
    for (const ext of parsed.extensionData) {
      if (ext.signature === "link") linkData = ext.data;
      else if (ext.signature === SPARSE_DIRECTORIES_EXTENSION) sparse = true;
      else others.push(ext);
    }
    assertWritableIndexExtensions(others);
    let entries = parsed.entries;
    let encoding = parsed.encoding;
    let split: SplitState | undefined;
    if (linkData) {
      const link = parseLinkExtension(linkData);
      if (isNullIndexId(link.baseId)) {
        split = {};
      } else {
        const indexDir =
          this.path.lastIndexOf("/") < 0 ? "" : this.path.slice(0, this.path.lastIndexOf("/"));
        const shared = await readSharedIndex(
          this.files,
          this.gitDir,
          link.baseId,
          indexDir,
          this.options.verifyChecksum === true,
        );
        entries = mergeSplitIndex(parsed.entries, link, shared);
        encoding = shared.encoding;
        split = { shared };
      }
    }
    let extensions = others;
    let sparseDirs: string[] | undefined;
    if (sparse && this.options.keepSparseDirectories) {
      sparseDirs = entries.filter(isSparseDirectoryEntry).map((e) => e.path);
      for (const e of entries) if (!isSparseDirectoryEntry(e)) validateIndexEntryPaths([e]);
      return { entries, version: parsed.version, extensions, encoding, split, sparseDirs };
    }
    if (sparse) {
      // post_read_index_from's tweak_split_index: core.splitIndex=true on an index still
      // sparse dies in init_split_index
      if (!split && (await this.host?.settings?.())?.splitIndex === true) {
        throw new Error(SPLIT_WITH_SPARSE);
      }
      const trees = this.host?.trees ?? this.options.defaultTrees;
      if (!trees) throw new UnsupportedIndexExtensionError(SPARSE_DIRECTORIES_EXTENSION);
      const treeExt = others.find((e) => e.signature === "TREE");
      let cacheTree: CacheTree | undefined;
      try {
        cacheTree = treeExt ? parseCacheTree(treeExt.data) : undefined;
      } catch {
        cacheTree = undefined;
      }
      sparseDirs = entries.filter(isSparseDirectoryEntry).map((e) => e.path);
      const full = await expandSparseIndex(entries, cacheTree, trees);
      entries = full.entries;
      extensions = others
        .filter((e) => e.signature !== "TREE")
        .filter((e) => e.signature !== "FSMN");
      if (full.cacheTree) {
        extensions = [{ signature: "TREE", data: encodeCacheTree(full.cacheTree) }, ...extensions];
      }
    }
    if (linkData || sparse) validateIndexEntryPaths(entries);
    return { entries, version: parsed.version, extensions, encoding, split, sparseDirs };
  }

  /**
   * How `entries` go on disk with `extensions` (the full index's, `TREE` first): split
   * against a shared index (`write_locked_index`), collapsed into a sparse index
   * (`convert_to_sparse`), or whole.
   */
  private async plan(
    entries: readonly StagingEntry[],
    extensions: IndexExtension[],
  ): Promise<IndexWritePlan> {
    const settings: IndexSettings = (await this.host?.settings?.()) ?? {};
    let split = this.split;
    if (settings.splitIndex === false) split = undefined;
    else if (settings.splitIndex === true && !split) {
      // an index read sparse cannot be split (init_split_index dies)
      if (this.sparseDirs !== undefined) throw new Error(SPLIT_WITH_SPARSE);
      split = { ordered: true };
    }
    if (split) return this.planSplit(entries, extensions, split, settings);
    const sparse = await this.planSparse(entries, extensions, settings);
    if (sparse) return sparse;
    const { bytes, checksum, encoding } = await encodeIndexFileBytes(
      entries,
      this.version,
      extensions,
      {
        ...(this.encoding ? { source: this.encoding } : {}),
        ...(settings.skipHash ? { skipHash: true } : {}),
      },
    );
    return { bytes, checksum, encoding, extensions, split: undefined };
  }

  /** `write_locked_index` of a split index: a new shared index when due, then the split file. */
  private async planSplit(
    entries: readonly StagingEntry[],
    extensions: IndexExtension[],
    split: SplitState,
    settings: IndexSettings,
  ): Promise<IndexWritePlan> {
    let shared = split.shared;
    let classification: SplitClassification = shared
      ? classifySplitEntries(
          entries,
          shared,
          settings.unpackTrees === true,
          this.lastEntries,
          settings.readded,
        )
      : { matched: [], update: [], added: entries.slice() };
    const maxPercent = settings.maxPercentChange ?? 20;
    const newShared =
      split.ordered === true ||
      tooManyNotSharedEntries(entries.length, classification.added.length, maxPercent);
    let before: (() => Promise<void>) | undefined;
    if (newShared) {
      const written = await encodeIndexFileBytes(
        entries,
        this.version,
        [],
        this.encoding ? { source: this.encoding } : {},
      );
      const id = bytesToHex(written.checksum);
      const sortedEntries = written.encoding?.entries ?? entries.slice();
      const fresh: SharedIndex = {
        id,
        entries: sortedEntries,
        version: written.encoding?.version ?? this.version,
        ...(written.encoding ? { encoding: written.encoding } : {}),
      };
      shared = fresh;
      classification = {
        matched: sortedEntries.slice(),
        update: new Array(sortedEntries.length).fill(false),
        added: [],
      };
      before = () => this.writeSharedIndex(written.bytes, id, settings);
    }
    const sharedId = shared ? shared.id : "0".repeat(40);
    const { items, link } = prepareSplitWrite(classification, sharedId);
    const main = await encodeIndexInOrder(
      items,
      this.version,
      [{ signature: "link", data: link }, ...extensions],
      settings.skipHash ? { skipHash: true } : {},
    );
    const finalShared = shared;
    const finalClassification = classification;
    return {
      bytes: main.bytes,
      checksum: main.checksum,
      encoding: finalShared?.encoding,
      extensions,
      split: finalShared ? { shared: finalShared } : {},
      ...(before ? { before } : {}),
      after: async () => {
        if (finalShared) {
          if (newShared) adoptSharedIndex(finalShared);
          else await freshenFile(this.files, sharedIndexPath(this.gitDir, finalShared.id));
          rememberSplitWrite(finalClassification, finalShared.id);
        }
      },
    };
  }

  /**
   * `write_shared_index`: the shared index written as `sharedindex_XXXXXX`, its mode adjusted
   * (`core.sharedRepository`), renamed to `sharedindex.<id>`, then the shared indexes
   * unused since `splitIndex.sharedIndexExpire` removed (`clean_shared_index_files`).
   */
  private async writeSharedIndex(
    bytes: Uint8Array,
    id: string,
    settings: IndexSettings,
  ): Promise<void> {
    const dir = this.gitDir;
    const atomic = atomicFilesOver(this.files, "");
    let temp = "";
    for (let attempt = 0; ; attempt++) {
      temp = joinPath(dir, `sharedindex_${randomSuffix()}`);
      if (await atomic.createExclusive(temp, bytes)) break;
      if (attempt > 100) throw new Error(`unable to create temporary file '${temp}'`);
    }
    try {
      await adjustSharedPerm(this.files, temp, settings.sharedRepository ?? 0);
      await atomic.replace(temp, sharedIndexPath(dir, id));
    } catch (error) {
      await atomic.remove(temp).catch(() => {});
      throw error;
    }
    const expire = settings.sharedIndexExpireBefore ?? Math.floor(Date.now() / 1000) - TWO_WEEKS;
    if (expire === 0) return;
    for await (const info of this.files.list(dir)) {
      const name = info.name ?? info.path.slice(info.path.lastIndexOf("/") + 1);
      if (!name.startsWith("sharedindex.") || name === `sharedindex.${id}`) continue;
      const path = joinPath(dir, name);
      const stats = await this.files.stats(path).catch(() => undefined);
      if (!stats) continue;
      if (Math.floor((stats.lastModified ?? 0) / 1000) > expire) continue;
      await this.files.remove(path).catch(() => {});
    }
  }

  /** `convert_to_sparse` before a write: the sparse index's bytes, or undefined to write it whole. */
  private async planSparse(
    entries: readonly StagingEntry[],
    extensions: IndexExtension[],
    settings: IndexSettings,
  ): Promise<IndexWritePlan | undefined> {
    const patterns = settings.sparse;
    const trees = this.host?.trees ?? this.options.defaultTrees;
    if (!patterns || !trees || entries.length === 0) return undefined;
    if (entries.some((e) => e.stage !== 0)) return undefined;
    const treeExt = extensions.find((e) => e.signature === "TREE");
    let tree: CacheTree | undefined;
    try {
      tree = treeExt ? parseCacheTree(treeExt.data) : undefined;
    } catch {
      tree = undefined;
    }
    const rest = extensions.filter((e) => e.signature !== "TREE" && e.signature !== "FSMN");
    const inCheckout = (path: string) => patterns.includes(path);
    // git's cache_tree_update(WRITE_TREE_MISSING_OK): every directory's tree stored, the
    // ones holding an intent-to-add entry invalid; undefined when it cannot be had
    const computed = async (list: readonly StagingEntry[]) => {
      try {
        return await storeCacheTree((items) => trees.store(items), list);
      } catch {
        return undefined;
      }
    };
    if (this.sparseDirs && this.sparseDirs.length > 0) {
      // read sparse: kept collapsed where it still can be, as git's sparse-aware commands
      const kept = await recollapseSparseIndex(
        entries,
        tree,
        this.sparseDirs,
        inCheckout,
        async (below) => {
          const t = await computed(below);
          return t && t.entryCount >= 0 ? t.id : undefined;
        },
      );
      if (kept && (await sparseIndexMatches(kept.entries, entries, trees))) {
        return this.sparsePlan(kept.entries, kept.cacheTree, tree, rest, settings.skipHash);
      }
    }
    let fromIndex = true;
    if (!tree || !cacheTreeFullyValid(tree)) {
      tree = await computed(entries);
      fromIndex = false;
      if (!tree) return undefined;
    }
    let collapsed = collapseSparseIndex(entries, tree, inCheckout);
    if (!(await sparseIndexMatches(collapsed.entries, entries, trees))) {
      // a cache-tree that no longer describes the entries: computed again, never written
      if (!fromIndex) return undefined;
      tree = await computed(entries);
      if (!tree) return undefined;
      collapsed = collapseSparseIndex(entries, tree, inCheckout);
      if (!(await sparseIndexMatches(collapsed.entries, entries, trees))) return undefined;
    }
    return this.sparsePlan(collapsed.entries, collapsed.cacheTree, tree, rest, settings.skipHash);
  }

  /** The bytes of a sparse index: its entries, its cache-tree, the other extensions, `sdir`. */
  private async sparsePlan(
    sparseEntries: StagingEntry[],
    sparseTree: CacheTree | undefined,
    fullTree: CacheTree | undefined,
    rest: IndexExtension[],
    skipHash?: boolean,
  ): Promise<IndexWritePlan> {
    const onDisk: IndexExtension[] = [
      ...(sparseTree ? [{ signature: "TREE", data: encodeCacheTree(sparseTree) }] : []),
      ...rest,
      { signature: SPARSE_DIRECTORIES_EXTENSION, data: new Uint8Array(0) },
    ];
    const { bytes, checksum, encoding } = await encodeIndexFileBytes(
      sparseEntries,
      this.version,
      onDisk,
      {
        ...(this.encoding ? { source: this.encoding } : {}),
        sparseDirectories: true,
        ...(skipHash ? { skipHash: true } : {}),
      },
    );
    // in memory the index stays full, with the full index's cache-tree
    const kept: IndexExtension[] = [
      ...(fullTree ? [{ signature: "TREE", data: encodeCacheTree(fullTree) }] : []),
      ...rest,
    ];
    return {
      bytes,
      checksum,
      encoding,
      extensions: kept,
      split: undefined,
      sparseDirs: sparseEntries.filter(isSparseDirectoryEntry).map((e) => e.path),
    };
  }

  /**
   * The entries and modification time, or nothing when there is no index file.
   *
   * @throws UnsupportedIndexExtensionError for an index with a required extension
   *   (a split or sparse index), whose entries cannot be read without it
   */
  async read(): Promise<{ entries: StagingEntry[]; lastModified: number } | undefined> {
    // a cache-tree set for a write of the entries before goes with them
    this.pendingCacheTree = undefined;
    this.pendingEntries = undefined;
    this.dropCacheTree = false;
    this.pendingUntracked = undefined;
    this.pendingUntrackedEntries = undefined;
    const stats = await this.files.stats(this.path);
    if (!stats) {
      this.encoding = undefined;
      this.extensions = [];
      this.entriesKept = undefined;
      this.refused = undefined;
      this.split = undefined;
      this.lastEntries = [];
      this.sparseDirs = undefined;
      this.checksum = null;
      return undefined;
    }
    const data = await readFile(this.files, this.path);
    // the entries keep these bytes as their encoding for the next write; nothing changes
    // file content in place (an in-memory FilesApi may hand back its stored array itself)
    let decoded: DecodedIndex;
    try {
      decoded = await this.decode(data);
      this.refused = undefined;
    } catch (error) {
      // do not let a later write replace an index we could not read
      this.encoding = undefined;
      this.refused = error as Error;
      throw error;
    }
    this.encoding = decoded.encoding;
    this.split = decoded.split;
    this.lastEntries = decoded.split ? decoded.entries.slice() : [];
    this.sparseDirs = decoded.sparseDirs;
    this.checksum = await indexFileIdentity(data);
    this.version = decoded.version;
    this.extensions = decoded.extensions;
    this.entriesKept = this.extensions.length > 0 ? decoded.entries.slice() : undefined;
    // the index file's own mtime; unknown is 0 (every entry racy), never "now"
    return { entries: decoded.entries, lastModified: stats.lastModified ?? 0 };
  }

  /** The extensions read with the index or last written with it (`link` and `sdir` aside). */
  currentExtensions(): readonly IndexExtension[] {
    return this.extensions;
  }

  /**
   * Drop the resolve-undo records (`REUC`) on the next write, as git does when
   * it reads a whole tree into the index (`read-tree`, `reset`).
   */
  clearResolveUndo(): void {
    this.extensions = this.extensions.filter((e) => e.signature !== "REUC");
  }

  /** The resolve-undo records held (`REUC`), sorted by path; none when unreadable. */
  getResolveUndo(): ResolveUndoRecord[] {
    const existing = this.extensions.find((e) => e.signature === "REUC");
    if (!existing) return [];
    try {
      return parseResolveUndo(existing.data);
    } catch {
      return [];
    }
  }

  /** Drops the resolve-undo records of `paths` (the extension too when none is left). */
  dropResolveUndo(paths: ReadonlySet<string>): void {
    const list = this.getResolveUndo();
    const kept = list.filter((r) => !paths.has(r.path));
    if (kept.length === list.length) return;
    const others = this.extensions.filter((e) => e.signature !== "REUC");
    if (kept.length === 0) {
      this.extensions = others;
      return;
    }
    const at = others.findIndex((e) => e.signature === "TREE") + 1;
    const reuc = { signature: "REUC", data: encodeResolveUndo(kept) };
    this.extensions = [...others.slice(0, at), reuc, ...others.slice(at)];
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
   * `unpack_trees` or `write_index_as_tree`), replacing what was read. It describes
   * `entries` (the index when it is set); the write invalidates each path whose entries
   * changed since, as git's index edits invalidate it. Without `entries` it must describe
   * the entries that write is given; a valid root whose count disagrees with them is dropped.
   * Undefined drops the cache-tree: the next write carries none (git's `cache_tree_free`
   * with no `cache_tree_update` after it, as `read-tree` leaves an index with conflicts).
   */
  setCacheTree(tree: CacheTree | undefined, entries?: readonly StagingEntry[]): void {
    this.pendingCacheTree = tree;
    this.dropCacheTree = tree === undefined;
    // a copy: the caller's list may be edited in place
    this.pendingEntries = tree && entries ? entries.slice() : undefined;
  }

  /**
   * The cache-tree the next write writes: the one set with `setCacheTree`, else the index's
   * as last read or written (its `TREE` extension), each path whose entries differ in
   * `entries` invalid; undefined when there is none or it cannot be parsed. A fresh copy
   * each time.
   */
  cacheTree(entries: readonly StagingEntry[]): CacheTree | undefined {
    if (this.dropCacheTree) return undefined;
    if (this.pendingCacheTree) {
      // one set for the next write: what it will write (paths changed since invalid)
      const tree = copyCacheTree(this.pendingCacheTree);
      if (this.pendingEntries) invalidateChangedPaths(tree, this.pendingEntries, entries);
      return tree;
    }
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
   * The untracked cache (`UNTR`) the next write of `entries` carries: the one set with
   * `setUntrackedCache`, else the index's as last read or written, each directory holding a
   * path added or removed since invalidated (git's `untracked_cache_invalidate_path` from
   * `add_index_entry` and `remove_file_from_index`). Undefined when there is none or it does
   * not parse. A fresh copy each time.
   */
  untrackedCache(entries: readonly StagingEntry[]): UntrackedCache | undefined {
    if (this.pendingUntracked === null) return undefined;
    if (this.pendingUntracked) {
      const cache = parseUntrackedCache(encodeUntrackedCache(this.pendingUntracked));
      if (cache && this.pendingUntrackedEntries) {
        invalidateAddedOrRemoved(cache, this.pendingUntrackedEntries, entries);
      }
      return cache;
    }
    const ext = this.extensions.find((e) => e.signature === "UNTR");
    if (!ext) return undefined;
    const cache = parseUntrackedCache(ext.data);
    if (cache && this.entriesKept) invalidateAddedOrRemoved(cache, this.entriesKept, entries);
    return cache;
  }

  /**
   * Write `cache` as the `UNTR` extension with the next `write` (git's `UNTRACKED_CHANGED`),
   * or none with `null` (`remove_untracked_cache`). It describes `entries` when given: paths
   * added or removed before the write invalidate their directories.
   */
  setUntrackedCache(cache: UntrackedCache | null, entries?: readonly StagingEntry[]): void {
    this.pendingUntracked = cache;
    this.pendingUntrackedEntries = cache && entries ? entries.slice() : undefined;
  }

  /** What the next write would take besides the entries (see `restorePending`). */
  pendingState(): IndexFilePending {
    return {
      cacheTree: this.pendingCacheTree,
      dropCacheTree: this.dropCacheTree,
      entries: this.pendingEntries,
      untracked: this.pendingUntracked,
      untrackedEntries: this.pendingUntrackedEntries,
    };
  }

  /** Puts back what `pendingState` returned (no read or write in between). */
  restorePending(state: IndexFilePending): void {
    this.pendingCacheTree = state.cacheTree;
    this.dropCacheTree = state.dropCacheTree;
    this.pendingEntries = state.entries;
    this.pendingUntracked = state.untracked;
    this.pendingUntrackedEntries = state.untrackedEntries;
  }

  /**
   * Write `entries` (sorted by path, stage) with the extensions that still apply.
   *
   * @throws IndexChangedError when the index on disk is no longer the one this
   *   instance last read or wrote; nothing is written
   */
  async write(entries: readonly StagingEntry[]): Promise<void> {
    if (this.refused) throw this.refused;
    const prepared = this.prepareWrite(entries);
    const plan = await this.plan(entries, prepared.extensions);
    // the lock is created holding the new index: one exclusive create, then one rename
    const lockPath = `${this.path}.lock`;
    const atomic = atomicFilesOver(this.files, "");
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 0);
    while (!(await atomic.createExclusive(lockPath, plan.bytes))) {
      if (Date.now() >= deadline) throw new IndexLockedError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    try {
      if (this.checksum !== undefined) {
        const current = await readIndexChecksum(this.files, this.path);
        if (current !== this.checksum) throw new IndexChangedError(this.path);
      }
      await plan.before?.();
      await atomic.replace(lockPath, this.path);
    } catch (error) {
      await atomic.remove(lockPath).catch(() => {});
      throw error;
    }
    await plan.after?.();
    this.host?.written?.();
    this.checksum = await indexFileIdentity(plan.bytes);
    this.encoding = plan.encoding;
    this.split = plan.split;
    this.lastEntries = plan.split ? entries.slice() : [];
    this.sparseDirs = plan.sparseDirs;
    this.wrote(entries, plan.extensions);
  }

  /**
   * Takes `<index>.lock` now, as git's `repo_hold_locked_index`, and holds it until the lock
   * is committed (renamed over the index) or rolled back (removed). While it is held every
   * other writer is refused; `write` puts entries into the lock, any number of times.
   *
   * @example
   * ```typescript
   * const lock = await indexFile.lock();
   * await lock.write(entries);
   * await lock.commit(); // or lock.rollback()
   * ```
   *
   * @throws IndexLockedError when the lock exists (after `lockTimeoutMs`)
   * @throws IndexChangedError when the index on disk is not the one last read or written
   */
  async lock(): Promise<IndexFileLock> {
    if (this.refused) throw this.refused;
    const lockPath = `${this.path}.lock`;
    const atomic = atomicFilesOver(this.files, "");
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 0);
    while (!(await atomic.createExclusive(lockPath, new Uint8Array(0)))) {
      if (Date.now() >= deadline) throw new IndexLockedError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    let state: "held" | "done" = "held";
    // what was written into the lock: applied to this instance once it is committed
    let pending:
      | {
          entries: readonly StagingEntry[];
          extensions: IndexExtension[];
          checksum: string;
          encoding: IndexEncoding | undefined;
          split: SplitState | undefined;
          sparseDirs?: string[];
          after?: () => Promise<void>;
        }
      | undefined;
    const release = async () => {
      state = "done";
      await atomic.remove(lockPath).catch(() => {});
    };
    try {
      if (this.checksum !== undefined) {
        const current = await readIndexChecksum(this.files, this.path);
        if (current !== this.checksum) throw new IndexChangedError(this.path);
      }
    } catch (error) {
      await release();
      throw error;
    }
    return {
      path: lockPath,
      write: async (entries) => {
        if (state !== "held") throw new Error(`'${lockPath}' is no longer held`);
        const prepared = this.prepareWrite(entries);
        const plan = await this.plan(entries, prepared.extensions);
        // git writes the shared index while it writes the index into its lock
        await plan.before?.();
        await atomic.write(lockPath, plan.bytes);
        this.host?.written?.();
        pending = {
          entries: entries.slice(),
          extensions: plan.extensions,
          checksum: await indexFileIdentity(plan.bytes),
          encoding: plan.encoding,
          split: plan.split,
          sparseDirs: plan.sparseDirs,
          after: plan.after,
        };
      },
      commit: async () => {
        if (state !== "held") throw new Error(`'${lockPath}' is no longer held`);
        if (!pending) {
          // nothing written: the index stays as it is
          await release();
          return;
        }
        try {
          await atomic.replace(lockPath, this.path);
        } catch (error) {
          await release();
          throw error;
        }
        state = "done";
        await pending.after?.();
        this.checksum = pending.checksum;
        this.encoding = pending.encoding;
        this.split = pending.split;
        this.lastEntries = pending.split ? pending.entries.slice() : [];
        this.sparseDirs = pending.sparseDirs;
        this.wrote(pending.entries, pending.extensions);
      },
      rollback: async () => {
        if (state === "held") await release();
      },
      reread: async () => {
        if (state !== "held") throw new Error(`'${lockPath}' is no longer held`);
        const data = await readFile(this.files, lockPath);
        const parsed = await this.decode(data);
        const stats = await this.files.stats(lockPath);
        // what was read stands for what the lock holds: the next write carries its
        // extensions, and a commit renames it over the index as it is
        this.pendingCacheTree = undefined;
        this.pendingEntries = undefined;
        this.dropCacheTree = false;
        this.pendingUntracked = undefined;
        this.pendingUntrackedEntries = undefined;
        this.version = parsed.version;
        this.encoding = parsed.encoding;
        this.extensions = parsed.extensions;
        this.split = parsed.split;
        this.lastEntries = parsed.split ? parsed.entries.slice() : [];
        this.sparseDirs = parsed.sparseDirs;
        this.entriesKept = this.extensions.length > 0 ? parsed.entries.slice() : undefined;
        pending = {
          entries: parsed.entries.slice(),
          extensions: parsed.extensions,
          checksum: await indexFileIdentity(data),
          encoding: parsed.encoding,
          split: parsed.split,
          sparseDirs: parsed.sparseDirs,
        };
        return { entries: parsed.entries, lastModified: stats?.lastModified ?? 0 };
      },
    };
  }

  /** The extensions a write of `entries` carries (the pending cache-tree consumed). */
  private prepareWrite(entries: readonly StagingEntry[]): { extensions: IndexExtension[] } {
    // what indexEntriesDigest compares: path, stage, mode, object id, intent-to-add
    const changed = this.entriesKept === undefined || !sameIndexEntries(this.entriesKept, entries);
    let extensions = withUntrackedCache(
      carryIndexExtensions(this.extensions, entries, changed),
      this.untrackedPayload(entries, changed),
    );
    this.pendingUntracked = undefined;
    this.pendingUntrackedEntries = undefined;
    if (this.dropCacheTree) {
      this.dropCacheTree = false;
      this.pendingCacheTree = undefined;
      this.pendingEntries = undefined;
      return { extensions: extensions.filter((e) => e.signature !== "TREE") };
    }
    // without a cache-tree computed for these entries, the one read or last written goes on
    // with each changed path invalid (git keeps the nodes no edit touched valid)
    let tree = this.pendingCacheTree;
    if (tree && this.pendingEntries) invalidateChangedPaths(tree, this.pendingEntries, entries);
    else if (!tree && changed) tree = this.cacheTree(entries);
    this.pendingCacheTree = undefined;
    this.pendingEntries = undefined;
    if (tree && describesEntries(tree, entries)) {
      // git writes the cache-tree first
      extensions = [
        { signature: "TREE", data: encodeCacheTree(tree) },
        ...extensions.filter((e) => e.signature !== "TREE"),
      ];
    }
    return { extensions };
  }

  /**
   * The `UNTR` payload a write of `entries` carries: the one set, else the one read with the
   * directories of added or removed paths invalidated (unchanged bytes when nothing was
   * added or removed); null for none.
   */
  private untrackedPayload(entries: readonly StagingEntry[], changed: boolean): Uint8Array | null {
    if (this.pendingUntracked === null) return null;
    if (this.pendingUntracked) {
      const cache = this.pendingUntracked;
      if (this.pendingUntrackedEntries) {
        invalidateAddedOrRemoved(cache, this.pendingUntrackedEntries, entries);
      }
      return encodeUntrackedCache(cache);
    }
    const ext = this.extensions.find((e) => e.signature === "UNTR");
    if (!ext) return null;
    if (!changed || !this.entriesKept) return ext.data;
    if (!addsOrRemoves(this.entriesKept, entries)) return ext.data;
    const cache = parseUntrackedCache(ext.data);
    // one git could not read either is dropped
    if (!cache) return null;
    invalidateAddedOrRemoved(cache, this.entriesKept, entries);
    return encodeUntrackedCache(cache);
  }

  /** After a write: what the index now holds. */
  private wrote(entries: readonly StagingEntry[], extensions: IndexExtension[]): void {
    this.extensions = extensions;
    this.entriesKept = extensions.length > 0 ? entries.slice() : undefined;
  }
}

/** The pending cache-tree and untracked cache of an `IndexFile` (see `pendingState`). */
export interface IndexFilePending {
  readonly cacheTree: CacheTree | undefined;
  readonly dropCacheTree: boolean;
  readonly entries: readonly StagingEntry[] | undefined;
  readonly untracked: UntrackedCache | null | undefined;
  readonly untrackedEntries: readonly StagingEntry[] | undefined;
}

/** `<index>.lock` held by `IndexFile.lock()`. */
export interface IndexFileLock {
  /** The lock file's path. */
  readonly path: string;
  /** Writes `entries` (sorted by path, stage) into the lock, with the extensions that apply. */
  write(entries: readonly StagingEntry[]): Promise<void>;
  /** Renames the lock over the index (only removes it when nothing was written). */
  commit(): Promise<void>;
  /** Removes the lock, the index left as it was; nothing once committed or rolled back. */
  rollback(): Promise<void>;
  /**
   * Reads the lock as another writer (a hook given it as `GIT_INDEX_FILE`) left it: its
   * entries and modification time, which a commit then renames over the index (git's
   * `discard_index` + `read_index_from(<lock>)`).
   */
  reread(): Promise<{ entries: StagingEntry[]; lastModified: number }>;
}

/** Whether a cache-tree can stand for `entries`: a valid root counts their tree entries. */
function describesEntries(tree: CacheTree, entries: readonly StagingEntry[]): boolean {
  if (tree.entryCount < 0) return true;
  let count = 0;
  for (const e of entries) {
    if (e.stage !== 0) return false;
    if (!e.intentToAdd) count++;
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

/**
 * `extensions` with `untracked` as their `UNTR` (none for null), where git writes it: after
 * `TREE` and `REUC`, before the others.
 */
function withUntrackedCache(
  extensions: IndexExtension[],
  untracked: Uint8Array | null,
): IndexExtension[] {
  const others = extensions.filter((e) => e.signature !== "UNTR");
  if (!untracked) return others;
  let at = 0;
  while (
    at < others.length &&
    ["TREE", "REUC"].includes((others[at] as IndexExtension).signature)
  ) {
    at++;
  }
  return [...others.slice(0, at), { signature: "UNTR", data: untracked }, ...others.slice(at)];
}

/** The (path, stage) keys of `a` and `b` (sorted lists) that only one of them has. */
function* addedOrRemoved(
  before: readonly StagingEntry[],
  after: readonly StagingEntry[],
): Generator<string> {
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const x = before[i];
    const y = after[j];
    if (x !== undefined && x === y) {
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
      yield (x as StagingEntry).path;
      i++;
    } else if (order > 0) {
      yield (y as StagingEntry).path;
      j++;
    } else {
      i++;
      j++;
    }
  }
}

/** Whether `after` adds or removes a (path, stage) of `before`. */
function addsOrRemoves(before: readonly StagingEntry[], after: readonly StagingEntry[]): boolean {
  return !addedOrRemoved(before, after).next().done;
}

/**
 * Invalidate in `cache` the directory of every path added to or removed from the index
 * between `before` and `after`, as git's index edits do (`add_index_entry` inserting a new
 * name or stage, `remove_file_from_index`); an entry replaced in place leaves it alone.
 */
function invalidateAddedOrRemoved(
  cache: UntrackedCache,
  before: readonly StagingEntry[],
  after: readonly StagingEntry[],
): void {
  let last: string | undefined;
  for (const path of addedOrRemoved(before, after)) {
    if (path === last) continue;
    last = path;
    invalidateUntrackedPath(cache, path);
  }
}

/** Six random characters for a temporary file's name (git's `mkstemp` template). */
function randomSuffix(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

/**
 * git's `adjust_shared_perm` of a file under `core.sharedRepository` (`shared`, as
 * `git_config_perm` returns it; 0 leaves the mode alone): the file's permission bits widened
 * (or, for an octal value, replaced) as `calc_shared_perm` computes them. Nothing where the
 * FilesApi keeps no modes.
 */
export async function adjustSharedPerm(
  files: FilesApi,
  path: string,
  shared: number,
): Promise<void> {
  if (!shared) return;
  const posix = files as FilesApi & {
    lstat?(path: string): Promise<{ mode?: number } | undefined>;
    chmod?(path: string, mode: number): Promise<void>;
  };
  if (!posix.lstat || !posix.chmod) return;
  const mode = (await posix.lstat(path))?.mode;
  if (mode === undefined) return;
  const next = calcSharedPerm(mode & 0o7777, shared);
  if (((mode ^ next) & 0o7777) !== 0) await posix.chmod(path, next & 0o7777);
}

/** git's `calc_shared_perm` of a file's mode. */
export function calcSharedPerm(mode: number, shared: number): number {
  let tweak = shared < 0 ? -shared : shared;
  if (!(mode & 0o200)) tweak &= ~0o222;
  if (mode & 0o100) tweak |= (tweak & 0o444) >> 2;
  return shared < 0 ? (mode & ~0o777) | tweak : mode | tweak;
}

/**
 * git's `git_config_perm` of a `core.sharedRepository` value: 0 for `umask` (or false),
 * `0660` for `group` (or true), `0664` for `all`/`world`/`everybody`, the negated masked mode
 * for an octal one (`0640` gives `-0640`).
 *
 * @throws Error for an octal mode that leaves the owner without read and write
 */
export function parseSharedRepository(value: string | undefined): number {
  if (value === undefined) return 0;
  if (value === "umask") return 0;
  if (value === "group") return 0o660;
  if (value === "all" || value === "world" || value === "everybody") return 0o664;
  if (/^[0-7]+$/.test(value)) {
    const i = Number.parseInt(value, 8);
    if (i === 0) return 0;
    if (i === 1) return 0o660;
    if (i === 2) return 0o664;
    if ((i & 0o600) !== 0o600) {
      throw new Error(
        `problem with core.sharedRepository filemode value (0${(i & 0o777).toString(8).padStart(3, "0")}).\n` +
          "The owner of files must always have read and write permissions.",
      );
    }
    return -(i & 0o666);
  }
  const lower = value.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) return 0o660;
  return 0;
}

/**
 * The entries and extensions of the index file at `indexPath` as git reads them: a split
 * index merged with its shared index (looked up in `gitDir`, default the index's directory),
 * a sparse index expanded from `trees`, or, without trees, with its sparse directory entries
 * as they are (mode 040000, a tree's id). Undefined when there is no index file.
 *
 * ```typescript
 * const index = await readIndexFileEntries(files, ".git/index", { gitDir: ".git" });
 * ```
 *
 * @throws UnsupportedIndexExtensionError for another required extension
 */
export async function readIndexFileEntries(
  files: FilesApi,
  indexPath: string,
  options: {
    gitDir?: string;
    trees?: Pick<Trees, "load" | "store">;
    /** Check the trailing SHA-1, as git's fsck does (`verify_index_checksum`) */
    verifyChecksum?: boolean;
  } = {},
): Promise<{ entries: StagingEntry[]; extensions: readonly IndexExtension[] } | undefined> {
  const file = new IndexFile(files, indexPath, {
    ...(options.gitDir !== undefined ? { gitDir: options.gitDir } : {}),
    ...(options.verifyChecksum ? { verifyChecksum: true } : {}),
    ...(options.trees ? { defaultTrees: options.trees } : { keepSparseDirectories: true }),
  });
  const read = await file.read();
  if (!read) return undefined;
  return { entries: read.entries, extensions: file.currentExtensions() };
}
