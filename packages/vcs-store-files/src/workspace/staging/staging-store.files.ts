import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode, type FilesApi } from "@statewalker/vcs-core";
import { compareGitPaths, decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { tryReadFile } from "@statewalker/vcs-utils/files";
import type {
  CacheTree,
  IndexBuilder,
  IndexBuilderFinishOptions,
  IndexEditor,
  IndexFilePending,
  ResolveUndoRecord,
  Staging,
  StagingIndexLock,
  StagingState,
  UntrackedCache,
} from "@statewalker/vcs-working-tree";
import {
  clearSkipWorktreeFlags,
  EntryIdentitySet,
  type GitStagingOptions,
  INDEX_VERSION_2,
  IndexFile,
  type IndexHost,
  type IndexStatUpdate,
  type IndexVersion,
  keepMatchingEntries,
  keepMatchingMode,
  MergeStage,
  type MergeStageValue,
  type RacyCheck,
  RemoveStagingStages,
  readIndexChecksum,
  refreshIndexFile,
  reuseEntryEncoding,
  type StagingEdit,
  type StagingEntry,
  type StagingEntryOptions,
  smudgeRacilyClean,
  verifyTreePaths,
} from "@statewalker/vcs-working-tree";
import { createGitFilesBackend } from "../../create-git-files-backend.js";
import { HostPaths, isAbsoluteGitPath, parseCommonDir } from "../git-dir/index.js";

/**
 * File-based staging store implementation.
 *
 * Stores the index in Git-compatible DIRC format.
 * Supports index versions 2, 3, and 4.
 *
 * All entries are kept sorted by (path, stage) for binary search.
 *
 * `write()` follows git's lock-file protocol (`<index>.lock`, then a rename) and
 * keeps the extensions git wrote that still apply, as `GitStaging` does.
 */
export class FileStagingStore implements Staging {
  private _entries: StagingEntry[] = [];
  private updateTime = 0;
  private racyCheck?: RacyCheck;
  /** The entries as last read or written (others were set in this session: up to date) */
  private asRead = new EntryIdentitySet();
  /** Whether the entries or extensions changed since they were last read or written */
  private unwritten = false;
  /** Skip-worktree flags cleared when the index was read, not yet in the index file */
  private skipWorktreeCleared = new Set<string>();
  /** The index's version (git's `istate->version`): undefined while no index file was read */
  private version: IndexVersion | undefined;
  private readonly indexFile: IndexFile;

  constructor(
    private readonly files: FilesApi,
    private readonly indexPath: string,
    options: GitStagingOptions = {},
  ) {
    this.indexFile = new IndexFile(files, indexPath, {
      ...options,
      defaultTrees:
        options.defaultTrees ?? lazyRepositoryTrees(files, options.gitDir ?? dirOf(indexPath)),
    });
  }

  // ============ Reading Operations ============

  async getEntry(path: string, stage?: MergeStageValue): Promise<StagingEntry | undefined> {
    const actualStage = stage ?? MergeStage.MERGED;
    const index = this.findEntry(path, actualStage);
    return index >= 0 ? this._entries[index] : undefined;
  }

  async getEntryByStage(path: string, stage: MergeStageValue): Promise<StagingEntry | undefined> {
    return this.getEntry(path, stage);
  }

  async getEntries(path: string): Promise<StagingEntry[]> {
    const result: StagingEntry[] = [];
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      const entry = await this.getEntryByStage(path, stage);
      if (entry) result.push(entry);
    }
    return result;
  }

  async setEntry(entry: StagingEntryOptions): Promise<void> {
    const editor = this.createEditor();
    editor.upsert(entry);
    await editor.finish();
  }

  async removeEntry(path: string, stage?: MergeStageValue): Promise<boolean> {
    const editor = this.createEditor();
    if (stage === undefined) {
      // Remove all stages for this path
      const hadEntry = await this.hasEntry(path);
      editor.remove(path);
      await editor.finish();
      return hadEntry;
    } else {
      // Remove specific stage
      const hadEntry = (await this.getEntry(path, stage)) !== undefined;
      editor.remove(path, stage);
      await editor.finish();
      return hadEntry;
    }
  }

  async hasEntry(path: string): Promise<boolean> {
    // Check any stage
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      if (this.findEntry(path, stage) >= 0) return true;
    }
    return false;
  }

  async getEntryCount(): Promise<number> {
    return this._entries.length;
  }

  entryList(): readonly StagingEntry[] {
    return this._entries.slice();
  }

  async *entries(
    options?: import("@statewalker/vcs-working-tree").EntryIteratorOptions,
  ): AsyncIterable<StagingEntry> {
    const prefix = options?.prefix;
    const stages = options?.stages;

    for (const entry of this._entries) {
      // Filter by prefix if specified
      if (prefix) {
        const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
        if (!entry.path.startsWith(normalizedPrefix) && entry.path !== prefix) {
          continue;
        }
      }

      // Filter by stages if specified
      if (stages && !stages.includes(entry.stage)) {
        continue;
      }

      yield entry;
    }
  }

  async *listEntries(): AsyncIterable<StagingEntry> {
    for (const entry of this._entries) {
      yield entry;
    }
  }

  async *listEntriesUnder(prefix: string): AsyncIterable<StagingEntry> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    for (const entry of this._entries) {
      if (entry.path.startsWith(normalizedPrefix) || entry.path === prefix) {
        yield entry;
      }
    }
  }

  async hasConflicts(): Promise<boolean> {
    return this._entries.some((e) => e.stage !== MergeStage.MERGED);
  }

  async getConflictedPaths(): Promise<string[]> {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const entry of this._entries) {
      if (entry.stage !== MergeStage.MERGED && !seen.has(entry.path)) {
        seen.add(entry.path);
        paths.push(entry.path);
      }
    }
    return paths;
  }

  async *getConflictPaths(): AsyncIterable<string> {
    const seen = new Set<string>();
    for (const entry of this._entries) {
      if (entry.stage !== MergeStage.MERGED && !seen.has(entry.path)) {
        seen.add(entry.path);
        yield entry.path;
      }
    }
  }

  async resolveConflict(
    path: string,
    resolution: import("@statewalker/vcs-working-tree").ConflictResolution,
  ): Promise<void> {
    const editor = this.createEditor();

    if (typeof resolution === "string") {
      // Resolution is a stage name
      let stage: MergeStageValue;
      switch (resolution) {
        case "base":
          stage = MergeStage.BASE;
          break;
        case "ours":
          stage = MergeStage.OURS;
          break;
        case "theirs":
          stage = MergeStage.THEIRS;
          break;
        default:
          throw new Error(`Invalid resolution: ${resolution}`);
      }

      // Find entry at the specified stage
      const entry = await this.getEntry(path, stage);
      if (!entry) {
        throw new Error(`No entry at stage ${stage} for path: ${path}`);
      }

      // Create stage 0 entry from chosen stage
      editor.upsert({
        ...entry,
        stage: MergeStage.MERGED,
      });
    } else {
      // Resolution is a complete entry
      editor.upsert({
        ...resolution,
        stage: MergeStage.MERGED,
      });
    }

    await editor.finish();
  }

  // ============ Writing Operations ============

  createBuilder(): IndexBuilder {
    return new FileStagingBuilder(this);
  }

  recordResolveUndo(records: readonly ResolveUndoRecord[]): void {
    this.unwritten = true;
    this.indexFile.recordResolveUndo(records);
  }

  clearResolveUndo(): void {
    this.unwritten = true;
    this.indexFile.clearResolveUndo();
  }

  getResolveUndo(): ResolveUndoRecord[] {
    return this.indexFile.getResolveUndo();
  }

  dropResolveUndo(paths: ReadonlySet<string>): void {
    this.unwritten = true;
    this.indexFile.dropResolveUndo(paths);
  }

  setCacheTree(tree: CacheTree | undefined): void {
    this.unwritten = true;
    // the entries it describes: later edits before the write invalidate their paths
    this.indexFile.setCacheTree(tree, this._entries);
  }

  getCacheTree(): CacheTree | undefined {
    return this.indexFile.cacheTree(this._entries);
  }

  getUntrackedCache(): UntrackedCache | undefined {
    return this.indexFile.untrackedCache(this._entries);
  }

  setUntrackedCache(cache: UntrackedCache | null): void {
    this.unwritten = true;
    this.indexFile.setUntrackedCache(cache, this._entries);
  }

  createEditor(): IndexEditor {
    return new FileStagingEditor(this);
  }

  async clear(): Promise<void> {
    this.unwritten = true;
    this._entries = [];
  }

  // ============ Tree Operations ============

  async writeTree(trees: Trees): Promise<ObjectId> {
    // Check for conflicts
    if (await this.hasConflicts()) {
      throw new Error("Cannot write tree with unresolved conflicts");
    }

    // Build tree from stage 0 entries only
    // an intent-to-add entry is no part of the tree (git's update_one skips it)
    const stage0 = this._entries.filter((e) => e.stage === MergeStage.MERGED && !e.intentToAdd);
    // never a tree with two entries of one name (git's verify_cache)
    verifyTreePaths(stage0);
    // the directories the cache-tree has valid keep their trees, as git's write-tree
    // (`cache_tree_update`): a tree primed by a reset keeps its stored modes (100664)
    return this.buildTreeRange(trees, stage0, 0, stage0.length, 0, this.getCacheTree());
  }

  /**
   * The tree of `entries[start, end)`, the entries below a directory whose path with its
   * slash is `prefixLength` characters long (sorted, so each subdirectory's entries are next
   * to each other). A valid cache-tree node counting a subdirectory's entries is skipped
   * over in one step, as git's `update_one` uses `entry_count`, so a write is proportional
   * to the directories changed, not to the index. Entries out of order are grouped by
   * {@link buildTreeRecursive}.
   */
  private async buildTreeRange(
    trees: Trees,
    entries: StagingEntry[],
    start: number,
    end: number,
    prefixLength: number,
    cached: CacheTree | undefined,
  ): Promise<ObjectId> {
    // a valid node stands for these entries only when it counts them and its tree is stored
    // (git's update_one: `it->entry_count >= 0 && has_object(it->oid)`); else computed
    if (
      cached &&
      cached.entryCount >= 0 &&
      cached.id &&
      cached.entryCount === end - start &&
      (await trees.has(cached.id))
    ) {
      return cached.id;
    }
    const treeEntries: TreeEntry[] = [];
    const subdirs: Array<{ name: string; from: number; to: number }> = [];
    let names: Set<string> | undefined;
    let i = start;
    while (i < end) {
      const entry = entries[i] as StagingEntry;
      const path = entry.path;
      const slash = path.indexOf("/", prefixLength);
      if (slash < 0) {
        treeEntries.push({ name: path.slice(prefixLength), mode: entry.mode, id: entry.objectId });
        i++;
        continue;
      }
      const name = path.slice(prefixLength, slash);
      names ??= new Set();
      if (names.has(name)) {
        // not in order: grouped by name instead
        const prefix = path.slice(0, prefixLength > 0 ? prefixLength - 1 : 0);
        return this.buildTreeRecursive(trees, entries.slice(start, end), prefix, cached);
      }
      names.add(name);
      const dir = path.slice(0, slash + 1);
      const count = cached?.subtrees.find((s) => s.name === name)?.tree.entryCount ?? -1;
      let j: number;
      if (
        count > 0 &&
        i + count <= end &&
        (entries[i + count - 1] as StagingEntry).path.startsWith(dir) &&
        (i + count === end || !(entries[i + count] as StagingEntry).path.startsWith(dir))
      ) {
        j = i + count;
      } else {
        j = i + 1;
        while (j < end && (entries[j] as StagingEntry).path.startsWith(dir)) j++;
      }
      subdirs.push({ name, from: i, to: j });
      i = j;
    }
    for (const { name, from, to } of subdirs) {
      const subtreeId = await this.buildTreeRange(
        trees,
        entries,
        from,
        to,
        prefixLength + name.length + 1,
        cached?.subtrees.find((s) => s.name === name)?.tree,
      );
      treeEntries.push({ name, mode: FileMode.TREE, id: subtreeId });
    }
    return trees.store(treeEntries);
  }

  private async buildTreeRecursive(
    trees: Trees,
    entries: StagingEntry[],
    prefix: string,
    cached?: CacheTree,
  ): Promise<ObjectId> {
    // a valid node stands for these entries only when it counts them and its tree is stored
    // (git's update_one: `it->entry_count >= 0 && has_object(it->oid)`); else computed
    if (
      cached &&
      cached.entryCount >= 0 &&
      cached.id &&
      cached.entryCount === entries.length &&
      (await trees.has(cached.id))
    ) {
      return cached.id;
    }
    const treeEntries: TreeEntry[] = [];
    const subdirs = new Map<string, StagingEntry[]>();

    for (const entry of entries) {
      // Get path relative to current prefix
      const relativePath = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
      const slashIndex = relativePath.indexOf("/");

      if (slashIndex < 0) {
        // Direct child - add to tree
        treeEntries.push({
          name: relativePath,
          mode: entry.mode,
          id: entry.objectId,
        });
      } else {
        // In subdirectory - collect for recursive processing
        const dirName = relativePath.slice(0, slashIndex);
        if (!subdirs.has(dirName)) {
          subdirs.set(dirName, []);
        }
        subdirs.get(dirName)?.push(entry);
      }
    }

    // Recursively build subdirectories
    for (const [dirName, dirEntries] of subdirs) {
      const subPrefix = prefix ? `${prefix}/${dirName}` : dirName;
      const subtreeId = await this.buildTreeRecursive(
        trees,
        dirEntries,
        subPrefix,
        cached?.subtrees.find((s) => s.name === dirName)?.tree,
      );
      treeEntries.push({
        name: dirName,
        mode: FileMode.TREE,
        id: subtreeId,
      });
    }

    return trees.store(treeEntries);
  }

  async readTree(
    trees: Trees,
    treeId: ObjectId,
    options?: { keepResolveUndo?: boolean; keepMatching?: boolean | "flags" },
  ): Promise<void> {
    this.unwritten = true;
    const before = this._entries;
    this._entries = [];
    // a whole tree replaces the index: git's read-tree and unpack-trees drop resolve-undo
    if (!options?.keepResolveUndo) this.indexFile.clearResolveUndo();
    await this.addTreeRecursive(trees, treeId, "", MergeStage.MERGED);
    this.sortEntries();
    if (options?.keepMatching) {
      this._entries = keepMatchingEntries(before, this._entries, keepMatchingMode(options));
    }
  }

  private async addTreeRecursive(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue,
  ): Promise<void> {
    const treeEntries = await trees.load(treeId);
    if (!treeEntries) {
      return;
    }
    for await (const entry of treeEntries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.addTreeRecursive(trees, entry.id, path, stage);
      } else {
        this._entries.push({
          path,
          mode: entry.mode,
          objectId: entry.id,
          stage,
          size: 0,
          mtime: 0,
        });
      }
    }
  }

  // ============ Persistence ============

  async read(): Promise<void> {
    const read = await this.indexFile.read();
    this.unwritten = false;
    this.skipWorktreeCleared = new Set();
    if (!read) {
      // No index file - start empty, in the version the first write is configured for
      this._entries = [];
      this.updateTime = 0;
      this.version = undefined;
      return;
    }
    this._entries = read.entries;
    this.asRead.reset(this._entries);
    this.version = this.indexFile.version;
    this.updateTime = read.lastModified;
  }

  /** Writes held back by `holdWrites`: one write once they are let go. */
  private held: { pending: boolean } | undefined;

  holdWrites(): () => Promise<void> {
    if (this.held) return async () => {};
    const held = { pending: false };
    this.held = held;
    return async () => {
      if (this.held !== held) return;
      this.held = undefined;
      if (held.pending) await this.write();
    };
  }

  async write(): Promise<void> {
    if (this.held) {
      this.held.pending = true;
      return;
    }
    this.indexFile.version = this.version;
    // git's smudging of racily clean entries, against the index as it was read or written
    this._entries = await smudgeRacilyClean(
      this._entries,
      this.updateTime,
      this.racyCheck,
      (entry) => this.asRead.has(entry),
    );
    await this.indexFile.write(this._entries);
    this.version = this.indexFile.version;
    this.unwritten = false;
    this.skipWorktreeCleared = new Set();
    this.asRead.reset(this._entries);
    this.updateTime = await this.indexMtime();
    await this.writeHook?.();
  }

  /**
   * Takes `<index>.lock` until the returned lock is committed or rolled back (git's
   * `repo_hold_locked_index` for a commit): `write()` puts the entries as they are then into
   * the lock (racily clean ones smudged), `commit()` renames it over the index.
   */
  async lockIndex(): Promise<StagingIndexLock> {
    const lock = await this.indexFile.lock();
    let written: StagingEntry[] | undefined;
    return {
      write: async () => {
        this.indexFile.version = this.version;
        this._entries = await smudgeRacilyClean(
          this._entries,
          this.updateTime,
          this.racyCheck,
          (entry) => this.asRead.has(entry),
        );
        written = this._entries;
        await lock.write(written);
        // git runs post-index-change once the lock is written, before it is committed
        await this.writeHook?.();
      },
      commit: async () => {
        await lock.commit();
        if (!written) return;
        this.version = this.indexFile.version;
        // the index now holds what was written (make no edits between write and commit)
        this.unwritten = false;
        this.skipWorktreeCleared = new Set();
        this.asRead.reset(written);
        this.updateTime = await this.indexMtime();
      },
      rollback: () => lock.rollback(),
      reread: async () => {
        const read = await lock.reread();
        this._entries = read.entries;
        this.asRead.reset(this._entries);
        this.version = this.indexFile.version;
        this.updateTime = read.lastModified;
        written = this._entries;
      },
    };
  }

  saveState(): StagingState {
    const saved: SavedFileStagingState = {
      staging: this,
      entries: this._entries.slice(),
      asRead: this.asRead.copy(),
      unwritten: this.unwritten,
      skipWorktreeCleared: new Set(this.skipWorktreeCleared),
      updateTime: this.updateTime,
      version: this.version,
      pending: this.indexFile.pendingState(),
    };
    return saved;
  }

  restoreState(state: StagingState): void {
    const saved = state as SavedFileStagingState;
    if (saved.staging !== this || !saved.entries) {
      throw new Error("restoreState: the state was saved by another staging");
    }
    this._entries = saved.entries.slice();
    this.asRead = saved.asRead.copy();
    this.unwritten = saved.unwritten;
    this.skipWorktreeCleared = new Set(saved.skipWorktreeCleared);
    this.updateTime = saved.updateTime;
    this.version = saved.version;
    this.indexFile.restorePending(saved.pending);
  }

  /** Sets the check `write()` smudges racily clean entries with. */
  setRacyCheck(check: RacyCheck | undefined): void {
    this.racyCheck = check;
  }

  /** Told after each write of the index file (see `Staging.setWriteHook`). */
  private writeHook?: () => Promise<void>;

  setWriteHook(hook: (() => Promise<void>) | undefined): void {
    this.writeHook = hook;
  }

  getWriteHook(): (() => Promise<void>) | undefined {
    return this.writeHook;
  }

  setIndexHost(host: IndexHost | undefined): void {
    this.indexFile.setHost(host);
  }

  getIndexHost(): IndexHost | undefined {
    return this.indexFile.getHost();
  }

  indexLayout(): { split: boolean; sparse: boolean } {
    return { split: this.indexFile.isSplit, sparse: this.indexFile.isSparse };
  }

  /** The index file's own mtime (0 when unknown: every entry is then racy). */
  private async indexMtime(): Promise<number> {
    try {
      return (await this.files.stats(this.indexPath))?.lastModified ?? 0;
    } catch {
      return 0;
    }
  }

  wantsRewrite(options?: { untrackedCache?: boolean }): Promise<boolean> {
    return this.indexFile.wantsRewrite(options);
  }

  hasUnwrittenChanges(): boolean {
    return this.unwritten;
  }

  async isOutdated(): Promise<boolean> {
    // the index on disk is another one than this instance read or wrote (by checksum)
    const current = this.indexFile.currentChecksum;
    if (current === undefined) return false;
    return (await readIndexChecksum(this.files, this.indexPath)) !== current;
  }

  /**
   * Stores fresh stats (compare-and-set per entry) in the index file, as git's index
   * refresh: only while the file is the one this instance read or wrote, under
   * `index.lock`, and without writing other in-memory edits.
   */
  async refreshStats(
    updates: IndexStatUpdate[],
    options?: { untrackedCache?: UntrackedCache | null },
  ): Promise<boolean> {
    const entries = await refreshIndexFile(
      this.indexFile,
      this.indexFile.fresh(),
      this._entries,
      updates,
      this.skipWorktreeCleared,
      options?.untrackedCache,
    );
    if (!entries) return false;
    this.skipWorktreeCleared = new Set();
    this._entries = entries;
    this.updateTime = await this.indexMtime();
    await this.writeHook?.();
    return true;
  }

  clearSkipWorktree(paths: ReadonlySet<string>): void {
    const cleared = clearSkipWorktreeFlags(this._entries, paths, (before, after) => {
      // still as read: git flips the flag on the entry it read
      if (this.asRead.delete(before)) this.asRead.add(after);
      this.skipWorktreeCleared.add(after.path);
    });
    if (cleared) this._entries = cleared;
  }

  isUnborn(): boolean | undefined {
    // the index file this instance last read or wrote: null when the read found none
    const checksum = this.indexFile.currentChecksum;
    return checksum === undefined ? undefined : checksum === null;
  }

  getUpdateTime(): number {
    return this.updateTime;
  }

  // ============ Internal Methods ============

  /**
   * Binary search for entry by (path, stage).
   * Returns index if found, or -(insertionPoint + 1) if not found.
   */
  private findEntry(path: string, stage: MergeStageValue): number {
    let low = 0;
    let high = this._entries.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const entry = this._entries[mid];
      const cmp = this.compareEntry(entry, path, stage);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid - 1;
      } else {
        return mid;
      }
    }

    return -(low + 1);
  }

  private compareEntry(entry: StagingEntry, path: string, stage: MergeStageValue): number {
    const pathCmp = comparePaths(entry.path, path);
    if (pathCmp !== 0) return pathCmp;
    return entry.stage - stage;
  }

  private sortEntries(): void {
    this._entries.sort((a, b) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });
  }

  /** @internal - Used by builder/editor */
  _replaceEntries(newEntries: StagingEntry[]): void {
    this.unwritten = true;
    this._entries = newEntries;
  }

  /** @internal - Whether `entry` (this very object) is one kept as read or written */
  _isAsRead(entry: unknown): boolean {
    return this.asRead.has(entry as StagingEntry);
  }

  /**
   * @internal - Used by the builder: its copies of entries kept as read are still as read
   * (git copies an entry with its flags: one never refreshed stays checked for racy-git
   * smudging when the index is written)
   */
  _keepAsRead(entries: readonly StagingEntry[]): void {
    for (const entry of entries) this.asRead.add(entry);
  }

  /**
   * @internal - Used by the builder (`finish({ upToDate })`): these entries count as set in
   * this session, not checked for racy-git smudging
   */
  _forgetAsRead(entries: readonly StagingEntry[]): void {
    for (const entry of entries) this.asRead.delete(entry);
  }

  /** @internal - Used by builder/editor */
  _getEntries(): StagingEntry[] {
    return this._entries;
  }

  /** @internal - Get index version */
  _getVersion(): IndexVersion {
    return this.version ?? INDEX_VERSION_2;
  }

  /** @internal - Set index version */
  _setVersion(version: IndexVersion): void {
    this.unwritten = true;
    this.version = version;
  }
}

/** What `FileStagingStore.saveState` keeps. */
interface SavedFileStagingState extends StagingState {
  readonly entries: readonly StagingEntry[];
  readonly asRead: EntryIdentitySet;
  readonly unwritten: boolean;
  readonly skipWorktreeCleared: ReadonlySet<string>;
  readonly updateTime: number;
  readonly version: IndexVersion | undefined;
  readonly pending: IndexFilePending;
}

/**
 * Builder for bulk staging area modifications.
 */
class FileStagingBuilder implements IndexBuilder {
  private _entries: StagingEntry[] = [];
  private keeping: Array<{ start: number; count: number }> = [];
  /** Copies made of store entries kept as read (still as read once finished) */
  private asReadCopies: StagingEntry[] = [];
  /** Where the next entry given back is looked for in the store's entries */
  private cursor = 0;

  constructor(private readonly store: FileStagingStore) {}

  add(options: StagingEntryOptions): void {
    // one of the store's entries (they are never changed in place) is taken as it is: no
    // copy to make and encode again; looked for just after the last one taken
    const existing = this.store._getEntries();
    for (let k = this.cursor; k < Math.min(existing.length, this.cursor + 16); k++) {
      if (existing[k] !== options) continue;
      this.cursor = k + 1;
      this._entries.push(existing[k]);
      return;
    }
    const entry: StagingEntry = {
      path: options.path,
      mode: options.mode,
      objectId: options.objectId,
      stage: options.stage ?? MergeStage.MERGED,
      size: options.size ?? 0,
      mtime: options.mtime ?? Date.now(),
      ctime: options.ctime,
      mtimeNs: options.mtimeNs,
      ctimeNs: options.ctimeNs,
      dev: options.dev,
      ino: options.ino,
      uid: options.uid,
      gid: options.gid,
      assumeValid: options.assumeValid,
      intentToAdd: options.intentToAdd,
      skipWorktree: options.skipWorktree,
    };
    reuseEntryEncoding(options, entry);
    if (this.store._isAsRead(options)) this.asReadCopies.push(entry);
    this._entries.push(entry);
  }

  keep(startIndex: number, count: number): void {
    this.keeping.push({ start: startIndex, count });
  }

  async addTree(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue = MergeStage.MERGED,
  ): Promise<void> {
    await this.addTreeRecursive(trees, treeId, prefix, stage);
  }

  private async addTreeRecursive(
    trees: Trees,
    treeId: ObjectId,
    prefix: string,
    stage: MergeStageValue,
  ): Promise<void> {
    const treeEntries = await trees.load(treeId);
    if (!treeEntries) {
      return;
    }
    for await (const entry of treeEntries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        await this.addTreeRecursive(trees, entry.id, path, stage);
      } else {
        this.add({
          path,
          mode: entry.mode,
          objectId: entry.id,
          stage,
        });
      }
    }
  }

  async finish(options: IndexBuilderFinishOptions = {}): Promise<void> {
    // Merge kept entries from existing index
    const existingEntries = this.store._getEntries();
    for (const { start, count } of this.keeping) {
      for (let i = 0; i < count; i++) {
        if (start + i < existingEntries.length) {
          this._entries.push(existingEntries[start + i]);
        }
      }
    }

    // Sort entries by (path, stage), unless given in that order (one pass to tell)
    const order = (a: StagingEntry, b: StagingEntry) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    };
    let sorted = true;
    for (let i = 1; i < this._entries.length && sorted; i++) {
      sorted = order(this._entries[i - 1], this._entries[i]) <= 0;
    }
    if (!sorted) this._entries.sort(order);

    // Check for duplicates
    for (let i = 1; i < this._entries.length; i++) {
      const prev = this._entries[i - 1];
      const curr = this._entries[i];
      if (prev.path === curr.path && prev.stage === curr.stage) {
        throw new Error(`Duplicate entry: ${curr.path} stage ${curr.stage}`);
      }
    }

    // Validate stage constraints
    this.validateStages();

    // Replace store entries
    this.store._replaceEntries(this._entries);
    if (options.upToDate) this.store._forgetAsRead(this._entries);
    else this.store._keepAsRead(this.asReadCopies);
  }

  private validateStages(): void {
    // If stage 0 exists for a path, no other stages should exist (the entries are sorted by
    // path, then stage: a path's entries are next to each other)
    const entries = this._entries;
    for (let k = 0; k < entries.length; ) {
      const path = entries[k].path;
      let end = k + 1;
      while (end < entries.length && entries[end].path === path) end++;
      if (end - k > 1) {
        const stages = new Set<MergeStageValue>();
        for (let j = k; j < end; j++) stages.add(entries[j].stage);
        if (stages.has(MergeStage.MERGED) && stages.size > 1) {
          throw new Error(`Invalid stages for ${path}: stage 0 cannot coexist with other stages`);
        }
      }
      k = end;
    }
  }
}

/**
 * Editor for targeted staging area modifications.
 */
class FileStagingEditor implements IndexEditor {
  private edits: StagingEdit[] = [];

  constructor(private readonly store: FileStagingStore) {}

  add(edit: StagingEdit): void {
    this.edits.push(edit);
  }

  remove(path: string, stage?: MergeStageValue): void {
    this.edits.push(new RemoveStagingStages(path, stage));
  }

  upsert(entry: StagingEntryOptions): void {
    this.edits.push({
      path: entry.path,
      apply: () => ({
        ...entry,
        stage: entry.stage ?? MergeStage.MERGED,
        size: entry.size ?? 0,
        mtime: entry.mtime ?? Date.now(),
      }),
    });
  }

  /**
   * Applies the edits path by path, in the order they were added: a removal takes the
   * path's stages (all, or the one named), a conflict resolution promotes the chosen stage,
   * a tree deletion takes every entry under its path, and any other edit replaces the
   * path's stage-0 entry (the conflict stages kept).
   */
  async finish(): Promise<void> {
    // no edit, no change: the index stays as read (unwritten only if it was)
    if (this.edits.length === 0) return;
    const merged = this.mergeEdits();
    if (merged) {
      this.store._replaceEntries(merged);
      return;
    }
    const byPath = new Map<string, StagingEntry[]>();
    for (const entry of this.store._getEntries()) {
      const list = byPath.get(entry.path);
      if (list) list.push(entry);
      else byPath.set(entry.path, [entry]);
    }
    for (const edit of this.edits) {
      if (isDeleteTree(edit)) {
        for (const path of [...byPath.keys()]) {
          if (path === edit.path || path.startsWith(`${edit.path}/`)) byPath.delete(path);
        }
        continue;
      }
      const entries = byPath.get(edit.path) ?? [];
      let next: StagingEntry[];
      if (edit instanceof RemoveStagingStages) {
        next = entries.filter((e) => edit.keeps(e));
      } else if (isResolveConflict(edit)) {
        const chosen = entries.find((e) => e.stage === edit.chooseStage);
        next = chosen ? [{ ...chosen, stage: MergeStage.MERGED }] : [];
      } else {
        const current = entries.find((e) => e.stage === MergeStage.MERGED);
        const result = edit.apply(current);
        next = entries.filter((e) => e.stage !== MergeStage.MERGED);
        if (result) next.push(result);
      }
      if (next.length > 0) byPath.set(edit.path, next);
      else byPath.delete(edit.path);
    }
    const newEntries = [...byPath.values()].flat();
    newEntries.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
    this.store._replaceEntries(newEntries);
  }

  /** The stages of one path after its edits, in order (a path's part of {@link finish}). */
  private applyEdits(edits: StagingEdit[], entries: StagingEntry[]): StagingEntry[] {
    let next = entries;
    for (const edit of edits) {
      if (edit instanceof RemoveStagingStages) {
        next = next.filter((e) => edit.keeps(e));
      } else if (isResolveConflict(edit)) {
        const chosen = next.find((e) => e.stage === edit.chooseStage);
        next = chosen ? [{ ...chosen, stage: MergeStage.MERGED }] : [];
      } else {
        const current = next.find((e) => e.stage === MergeStage.MERGED);
        const result = edit.apply(current);
        next = next.filter((e) => e.stage !== MergeStage.MERGED);
        if (result) next.push(result);
      }
    }
    return next.length > 1 ? [...next].sort((a, b) => a.stage - b.stage) : next;
  }

  /**
   * {@link finish} without regrouping and sorting the whole index: the edited paths' runs
   * replaced in place and new paths merged in (a few edits to a large index, `add -u`).
   * Undefined when a tree deletion is among the edits or the entries are not in order (the
   * paths, or the stages of one path): {@link finish} then takes the long way.
   */
  private mergeEdits(): StagingEntry[] | undefined {
    const byPath = new Map<string, StagingEdit[]>();
    for (const edit of this.edits) {
      if (isDeleteTree(edit)) return undefined;
      const list = byPath.get(edit.path);
      if (list) list.push(edit);
      else byPath.set(edit.path, [edit]);
    }
    const entries = this.store._getEntries();
    const out: StagingEntry[] = [];
    let previous: string | undefined;
    for (let k = 0; k < entries.length; ) {
      const path = entries[k].path;
      if (previous !== undefined && comparePaths(previous, path) >= 0) return undefined;
      previous = path;
      let end = k + 1;
      while (end < entries.length && entries[end].path === path) {
        // a path's stages out of order (a malformed index): the long way sorts them
        if (entries[end].stage < entries[end - 1].stage) return undefined;
        end++;
      }
      const edits = byPath.get(path);
      if (edits) {
        byPath.delete(path);
        for (const entry of this.applyEdits(edits, entries.slice(k, end))) out.push(entry);
      } else {
        for (let j = k; j < end; j++) out.push(entries[j]);
      }
      k = end;
    }
    if (byPath.size === 0) return out;
    // paths the index did not have: merged into the order
    const added: StagingEntry[] = [];
    for (const [, edits] of byPath) added.push(...this.applyEdits(edits, []));
    if (added.length === 0) return out;
    added.sort((a, b) => comparePaths(a.path, b.path) || a.stage - b.stage);
    const result: StagingEntry[] = new Array(out.length + added.length);
    let i = 0;
    let j = 0;
    let n = 0;
    while (i < out.length || j < added.length) {
      if (j >= added.length || (i < out.length && comparePaths(out[i].path, added[j].path) <= 0)) {
        result[n++] = out[i++];
      } else result[n++] = added[j++];
    }
    return result;
  }
}

/**
 * Compare paths using Git's canonical ordering.
 * Paths are compared byte-by-byte.
 */
function comparePaths(a: string, b: string): number {
  // the order of the paths' bytes (an escaped byte of a non-UTF-8 name included)
  return compareGitPaths(a, b);
}

/**
 * Type guard for DeleteStagingTree edit.
 */
function isDeleteTree(edit: StagingEdit): edit is StagingEdit & { path: string } {
  return edit.constructor.name === "DeleteStagingTree";
}

/**
 * Type guard for ResolveStagingConflict edit.
 */
function isResolveConflict(
  edit: StagingEdit,
): edit is StagingEdit & { chooseStage: MergeStageValue } {
  return "chooseStage" in edit;
}

/** The directory of a path ("" for a bare name). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The trees of the repository at `gitDir`, opened on first use: what a sparse index read
 * before a command gave the staging its host expands from. A linked worktree's git
 * directory names its repository in `commondir` (`get_common_dir_noenv`: relative to the
 * git directory unless absolute), whose objects hold the trees.
 */
function lazyRepositoryTrees(files: FilesApi, gitDir: string): Pick<Trees, "load" | "store"> {
  let opened: Promise<Trees> | undefined;
  const trees = () => {
    opened ??= commonDirOf(files, gitDir)
      .then((commonDir) => createGitFilesBackend({ files, gitDir: commonDir }))
      .then(({ history }) => history.trees as unknown as Trees);
    return opened;
  };
  return {
    load: async (id) => (await trees()).load(id),
    store: async (entries) => (await trees()).store(entries),
  };
}

/** git's `get_common_dir_noenv` of `gitDir`, as a FilesApi path. */
async function commonDirOf(files: FilesApi, gitDir: string): Promise<string> {
  const under = (name: string) => (gitDir ? `${gitDir}/${name}` : name);
  const path = under("commondir");
  if ((await files.stats(path).catch(() => undefined))?.kind !== "file") return gitDir;
  const bytes = await tryReadFile(files, path).catch(() => undefined);
  const text = bytes ? parseCommonDir(decodeGitPath(bytes)) : undefined;
  if (!text) return gitDir;
  const paths = new HostPaths();
  return paths.normalize(isAbsoluteGitPath(text) ? text : under(text));
}
