/**
 * Git index file-based Staging implementation
 *
 * Reads/writes the standard Git index file format (DIRC).
 * Supports index versions 2, 3, and 4.
 *
 * All entries are kept sorted by (path, stage) for binary search.
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { createInMemoryFilesApi, FileMode, type FilesApi } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { CacheTree } from "./cache-tree.js";
import { verifyTreePaths } from "./conflict-utils.js";
import type { ResolveUndoRecord } from "./index-extensions.js";
import { IndexFile, readIndexChecksum } from "./index-file.js";
import { INDEX_VERSION_2, type IndexVersion, reuseEntryEncoding } from "./index-format.js";
import type {
  ConflictResolution,
  EntryIteratorOptions,
  IndexBuilder,
  IndexEdit,
  IndexEditor,
  IndexEntry,
  IndexEntryOptions,
  ReadTreeOptions,
  Staging,
  StagingIndexLock,
} from "./staging.js";
import {
  clearSkipWorktreeFlags,
  type IndexStatUpdate,
  type RacyCheck,
  refreshIndexFile,
  smudgeRacilyClean,
} from "./stat-refresh.js";
import { MergeStage, type MergeStageValue, type StagingEntry } from "./types.js";

/**
 * Git index file-based Staging implementation
 *
 * This implements the new Staging interface using the standard Git index format.
 *
 * `write()` follows git's lock-file protocol (see `writeIndexFile`) and keeps the
 * extensions git wrote that still apply (see `carryIndexExtensions`).
 */
export class GitStaging implements Staging {
  private _entries: IndexEntry[] = [];
  private updateTime = 0;
  private racyCheck?: RacyCheck;
  /** The entries as last read or written (others were set in this session: up to date) */
  private asRead = new Set<StagingEntry>();
  /** Whether the entries or extensions changed since they were last read or written */
  private unwritten = false;
  /** Skip-worktree flags cleared when the index was read, not yet in the index file */
  private skipWorktreeCleared = new Set<string>();
  private version: IndexVersion = INDEX_VERSION_2;
  private readonly indexFile: IndexFile;

  constructor(
    private readonly files: FilesApi,
    private readonly indexPath: string,
    options: GitStagingOptions = {},
  ) {
    this.indexFile = new IndexFile(files, indexPath, options);
  }

  // ============ Entry Operations ============

  async getEntryCount(): Promise<number> {
    return this._entries.length;
  }

  async hasEntry(path: string): Promise<boolean> {
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      if (this.findEntry(path, stage) >= 0) return true;
    }
    return false;
  }

  async getEntry(
    path: string,
    stage: MergeStageValue = MergeStage.MERGED,
  ): Promise<IndexEntry | undefined> {
    const index = this.findEntry(path, stage);
    return index >= 0 ? this._entries[index] : undefined;
  }

  async getEntries(path: string): Promise<IndexEntry[]> {
    const result: IndexEntry[] = [];
    for (const stage of [MergeStage.MERGED, MergeStage.BASE, MergeStage.OURS, MergeStage.THEIRS]) {
      const entry = await this.getEntry(path, stage);
      if (entry) result.push(entry);
    }
    return result;
  }

  async setEntry(entryOrOptions: IndexEntry | IndexEntryOptions): Promise<void> {
    this.unwritten = true;
    const entry = this.normalizeEntry(entryOrOptions);
    const index = this.findEntry(entry.path, entry.stage);

    if (index >= 0) {
      // Replace existing
      this._entries[index] = entry;
    } else {
      // Insert at correct position
      const insertAt = -(index + 1);
      this._entries.splice(insertAt, 0, entry);
    }
  }

  async removeEntry(path: string, stage?: MergeStageValue): Promise<boolean> {
    this.unwritten = true;
    if (stage !== undefined) {
      const index = this.findEntry(path, stage);
      if (index >= 0) {
        this._entries.splice(index, 1);
        return true;
      }
      return false;
    }

    // Remove all stages
    let removed = false;
    for (const s of [MergeStage.THEIRS, MergeStage.OURS, MergeStage.BASE, MergeStage.MERGED]) {
      const index = this.findEntry(path, s);
      if (index >= 0) {
        this._entries.splice(index, 1);
        removed = true;
      }
    }
    return removed;
  }

  entryList(): readonly IndexEntry[] {
    return this._entries.slice();
  }

  async *entries(options?: EntryIteratorOptions): AsyncIterable<IndexEntry> {
    for (const entry of this._entries) {
      // Filter by prefix
      if (options?.prefix) {
        const prefix = options.prefix.endsWith("/") ? options.prefix : `${options.prefix}/`;
        if (!entry.path.startsWith(prefix) && entry.path !== options.prefix) {
          continue;
        }
      }

      // Filter by stages
      if (options?.stages && options.stages.length > 0) {
        if (!options.stages.includes(entry.stage)) {
          continue;
        }
      }

      yield entry;
    }
  }

  // ============ Conflict Handling ============

  async hasConflicts(): Promise<boolean> {
    return this._entries.some((e) => e.stage !== MergeStage.MERGED);
  }

  async getConflictedPaths(): Promise<string[]> {
    const seen = new Set<string>();
    const paths: string[] = [];

    for (const entry of this._entries) {
      if (entry.stage !== MergeStage.MERGED && !seen.has(entry.path)) {
        seen.add(entry.path);
        paths.push(entry.path);
      }
    }

    return paths;
  }

  async resolveConflict(path: string, resolution: ConflictResolution): Promise<void> {
    const pathEntries = await this.getEntries(path);
    if (pathEntries.length === 0) return;

    let resolvedEntry: IndexEntry;

    if (typeof resolution === "object") {
      // Custom entry provided
      resolvedEntry = { ...resolution, stage: MergeStage.MERGED };
    } else {
      // Select from existing stages
      const stageMap: Record<string, MergeStageValue> = {
        ours: MergeStage.OURS,
        theirs: MergeStage.THEIRS,
        base: MergeStage.BASE,
      };
      const stage = stageMap[resolution];
      const sourceEntry = pathEntries.find((e) => e.stage === stage);

      if (!sourceEntry) {
        throw new Error(`No ${resolution} version for ${path}`);
      }
      resolvedEntry = { ...sourceEntry, stage: MergeStage.MERGED };
    }

    // Remove all stages for this path
    await this.removeEntry(path);

    // Add resolved entry as stage 0
    await this.setEntry(resolvedEntry);
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
    return this.buildTreeRecursive(trees, stage0, "", this.getCacheTree());
  }

  private async buildTreeRecursive(
    trees: Trees,
    entries: IndexEntry[],
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
    const subdirs = new Map<string, IndexEntry[]>();

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

    return storeTreeEntries(trees, treeEntries);
  }

  async readTree(trees: Trees, treeId: ObjectId, options?: ReadTreeOptions): Promise<void> {
    this.unwritten = true;
    const before = options?.keepMatching ? this._entries : undefined;
    if (!options?.keepExisting) {
      this._entries = [];
      // a whole tree replaces the index: git's read-tree and unpack-trees drop resolve-undo
      if (!options?.keepResolveUndo) this.indexFile.clearResolveUndo();
    }

    const prefix = options?.prefix ?? "";
    const stage = options?.stage ?? MergeStage.MERGED;

    await this.addTreeRecursive(trees, treeId, prefix, stage);
    this.sortEntries();
    if (before) {
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
    if (!treeEntries) return;

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

  // ============ Bulk Operations ============

  createBuilder(): IndexBuilder {
    return new GitStagingBuilder(this);
  }

  recordResolveUndo(records: readonly ResolveUndoRecord[]): void {
    this.unwritten = true;
    this.indexFile.recordResolveUndo(records);
  }

  clearResolveUndo(): void {
    this.unwritten = true;
    this.indexFile.clearResolveUndo();
  }

  setCacheTree(tree: CacheTree | undefined): void {
    this.unwritten = true;
    // the entries it describes: later edits before the write invalidate their paths
    this.indexFile.setCacheTree(tree, this._entries);
  }

  getCacheTree(): CacheTree | undefined {
    return this.indexFile.cacheTree(this._entries);
  }

  createEditor(): IndexEditor {
    return new GitStagingEditor(this);
  }

  // ============ Persistence ============

  async read(): Promise<void> {
    const read = await this.indexFile.read();
    this.unwritten = false;
    this.skipWorktreeCleared = new Set();
    if (!read) {
      // No index file - start empty
      this._entries = [];
      this.updateTime = 0;
      return;
    }
    this._entries = read.entries;
    this.asRead = new Set(this._entries);
    this.version = this.indexFile.version;
    this.updateTime = read.lastModified;
  }

  async write(): Promise<void> {
    this.indexFile.version = this.version;
    // git's smudging of racily clean entries, against the index as it was read or written
    this._entries = await smudgeRacilyClean(
      this._entries,
      this.updateTime,
      this.racyCheck,
      (entry) => this.asRead.has(entry),
    );
    await this.indexFile.write(this._entries);
    this.unwritten = false;
    this.skipWorktreeCleared = new Set();
    this.asRead = new Set(this._entries);
    this.updateTime = await this.indexMtime();
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
      },
      commit: async () => {
        await lock.commit();
        if (!written) return;
        // the index now holds what was written (make no edits between write and commit)
        this.unwritten = false;
        this.skipWorktreeCleared = new Set();
        this.asRead = new Set(written);
        this.updateTime = await this.indexMtime();
      },
      rollback: () => lock.rollback(),
    };
  }

  /** Sets the check `write()` smudges racily clean entries with. */
  setRacyCheck(check: RacyCheck | undefined): void {
    this.racyCheck = check;
  }

  /** The index file's own mtime (0 when unknown: every entry is then racy). */
  private async indexMtime(): Promise<number> {
    try {
      return (await this.files.stats(this.indexPath))?.lastModified ?? 0;
    } catch {
      return 0;
    }
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
  async refreshStats(updates: IndexStatUpdate[]): Promise<boolean> {
    const entries = await refreshIndexFile(
      this.indexFile,
      this.indexFile.fresh(),
      this._entries,
      updates,
      this.skipWorktreeCleared,
    );
    if (!entries) return false;
    this.skipWorktreeCleared = new Set();
    this._entries = entries;
    this.updateTime = await this.indexMtime();
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

  getUpdateTime(): number {
    return this.updateTime;
  }

  async clear(): Promise<void> {
    this.unwritten = true;
    this._entries = [];
  }

  // ============ Internal Methods ============

  private normalizeEntry(entryOrOptions: IndexEntry | IndexEntryOptions): IndexEntry {
    // If it has all required fields, it's already an IndexEntry
    if ("path" in entryOrOptions && "mode" in entryOrOptions && "objectId" in entryOrOptions) {
      const entry = entryOrOptions as IndexEntry;
      return {
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        stage: entry.stage ?? MergeStage.MERGED,
        size: entry.size ?? 0,
        mtime: entry.mtime ?? Date.now(),
        ctime: entry.ctime,
        mtimeNs: entry.mtimeNs,
        ctimeNs: entry.ctimeNs,
        dev: entry.dev,
        ino: entry.ino,
        uid: entry.uid,
        gid: entry.gid,
        assumeValid: entry.assumeValid,
        intentToAdd: entry.intentToAdd,
        skipWorktree: entry.skipWorktree,
      };
    }

    const options = entryOrOptions as IndexEntryOptions;
    return {
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
  }

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
  _replaceEntries(newEntries: IndexEntry[]): void {
    this.unwritten = true;
    this._entries = newEntries;
  }

  /** @internal - Used by builder/editor */
  _getEntries(): IndexEntry[] {
    return this._entries;
  }

  /** @internal - Get index version */
  _getVersion(): IndexVersion {
    return this.version;
  }

  /** @internal - Set index version */
  _setVersion(version: IndexVersion): void {
    this.unwritten = true;
    this.version = version;
  }
}

/**
 * Builder for bulk staging area modifications.
 */
class GitStagingBuilder implements IndexBuilder {
  private entries: IndexEntry[] = [];
  private keeping: Array<{ start: number; count: number }> = [];

  constructor(private readonly store: GitStaging) {}

  add(options: IndexEntryOptions): void {
    const entry: IndexEntry = {
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
    this.entries.push(entry);
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
    if (!treeEntries) return;

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

  async finish(): Promise<void> {
    // Merge kept entries from existing index
    const existingEntries = this.store._getEntries();
    for (const { start, count } of this.keeping) {
      for (let i = 0; i < count; i++) {
        if (start + i < existingEntries.length) {
          this.entries.push(existingEntries[start + i]);
        }
      }
    }

    // Sort entries by (path, stage)
    this.entries.sort((a: IndexEntry, b: IndexEntry) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });

    // Check for duplicates
    for (let i = 1; i < this.entries.length; i++) {
      const prev = this.entries[i - 1];
      const curr = this.entries[i];
      if (prev.path === curr.path && prev.stage === curr.stage) {
        throw new Error(`Duplicate entry: ${curr.path} stage ${curr.stage}`);
      }
    }

    // Validate stage constraints
    this.validateStages();

    // Replace store entries
    this.store._replaceEntries(this.entries);
  }

  private validateStages(): void {
    // If stage 0 exists for a path, no other stages should exist
    const pathStages = new Map<string, Set<MergeStageValue>>();

    for (const entry of this.entries) {
      if (!pathStages.has(entry.path)) {
        pathStages.set(entry.path, new Set());
      }
      pathStages.get(entry.path)?.add(entry.stage);
    }

    for (const [path, stages] of pathStages) {
      if (stages.has(MergeStage.MERGED) && stages.size > 1) {
        throw new Error(`Invalid stages for ${path}: stage 0 cannot coexist with other stages`);
      }
    }
  }
}

/**
 * Editor for targeted staging area modifications.
 */
class GitStagingEditor implements IndexEditor {
  private edits: IndexEdit[] = [];
  private removals: Array<{ path: string; stage?: MergeStageValue }> = [];
  private upserts: IndexEntryOptions[] = [];

  constructor(private readonly store: GitStaging) {}

  add(edit: IndexEdit): void {
    this.edits.push(edit);
  }

  remove(path: string, stage?: MergeStageValue): void {
    this.removals.push({ path, stage });
  }

  upsert(entry: IndexEntryOptions): void {
    this.upserts.push(entry);
  }

  async finish(): Promise<void> {
    // no edit, no change: the index stays as read (unwritten only if it was)
    if (this.edits.length === 0 && this.removals.length === 0 && this.upserts.length === 0) {
      return;
    }
    const existingEntries = this.store._getEntries();
    const newEntries: IndexEntry[] = [];
    const processedPaths = new Set<string>();

    // First, copy entries that aren't being edited/removed
    for (const entry of existingEntries) {
      // Check if this entry should be removed
      const shouldRemove = this.removals.some((r) => {
        if (r.path !== entry.path) return false;
        if (r.stage === undefined) return true;
        return r.stage === entry.stage;
      });

      if (shouldRemove) continue;

      // Check if this entry has an edit
      const edit = this.edits.find((e) => e.path === entry.path);
      if (edit) {
        const result = edit.apply(entry);
        if (result) newEntries.push(result);
        processedPaths.add(entry.path);
      } else {
        newEntries.push(entry);
      }
    }

    // Apply edits to paths that didn't exist (insertions)
    for (const edit of this.edits) {
      if (!processedPaths.has(edit.path)) {
        const result = edit.apply(undefined);
        if (result) newEntries.push(result);
      }
    }

    // Apply upserts
    for (const upsertOptions of this.upserts) {
      const entry: IndexEntry = {
        path: upsertOptions.path,
        mode: upsertOptions.mode,
        objectId: upsertOptions.objectId,
        stage: upsertOptions.stage ?? MergeStage.MERGED,
        size: upsertOptions.size ?? 0,
        mtime: upsertOptions.mtime ?? Date.now(),
        ctime: upsertOptions.ctime,
        dev: upsertOptions.dev,
        ino: upsertOptions.ino,
        mtimeNs: upsertOptions.mtimeNs,
        ctimeNs: upsertOptions.ctimeNs,
        uid: upsertOptions.uid,
        gid: upsertOptions.gid,
        assumeValid: upsertOptions.assumeValid,
        intentToAdd: upsertOptions.intentToAdd,
        skipWorktree: upsertOptions.skipWorktree,
      };

      // Remove existing entry with same path/stage
      const existingIdx = newEntries.findIndex(
        (e) => e.path === entry.path && e.stage === entry.stage,
      );
      if (existingIdx >= 0) {
        newEntries.splice(existingIdx, 1);
      }

      newEntries.push(entry);
    }

    // Sort entries by (path, stage)
    newEntries.sort((a, b) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });

    this.store._replaceEntries(newEntries);
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

// ========== Helper Functions ==========

/** What `ReadTreeOptions.keepMatching` keeps of an unchanged entry. */
export function keepMatchingMode(options?: ReadTreeOptions): "entry" | "flags" {
  return options?.keepMatching === "flags" ? "flags" : "entry";
}

/**
 * `entries` (a tree read into the index) as unpack-trees' one-way merge leaves them over the
 * index `before` (see `ReadTreeOptions.keepMatching`): an unchanged stage-0 entry is the old
 * entry itself, a changed one keeps the old skip-worktree bit.
 */
export function keepMatchingEntries<T extends StagingEntry>(
  before: readonly T[],
  entries: readonly T[],
  keep: "entry" | "flags" = "entry",
): T[] {
  const old = new Map<string, T>();
  for (const e of before) if (e.stage === MergeStage.MERGED) old.set(e.path, e);
  if (old.size === 0) return entries.slice();
  return entries.map((e) => {
    const o = e.stage === MergeStage.MERGED ? old.get(e.path) : undefined;
    if (!o) return e;
    if (o.mode === e.mode && o.objectId === e.objectId) {
      if (keep === "entry") return o;
      if (!o.skipWorktree && !o.assumeValid && !o.intentToAdd) return e;
      return {
        ...e,
        ...(o.skipWorktree ? { skipWorktree: true } : {}),
        ...(o.assumeValid ? { assumeValid: true } : {}),
        ...(o.intentToAdd ? { intentToAdd: true } : {}),
      };
    }
    return o.skipWorktree ? { ...e, skipWorktree: true } : e;
  });
}

/**
 * Store tree entries using Trees interface.
 */
function storeTreeEntries(trees: Trees, entries: Iterable<TreeEntry>): Promise<ObjectId> {
  return trees.store(entries);
}

/** Options for `GitStaging` / `createGitStaging`. */
export interface GitStagingOptions {
  /**
   * How long `write()` keeps retrying while `<index>.lock` exists, in
   * milliseconds (default 0: fail at once with `IndexLockedError`, as git does).
   */
  lockTimeoutMs?: number;
}

/**
 * Factory function to create a Git-based Staging
 */
export function createGitStaging(
  files: FilesApi,
  indexPath: string,
  options?: GitStagingOptions,
): Staging {
  return new GitStaging(files, indexPath, options);
}

/**
 * Create an in-memory GitStaging backed by MemFilesApi.
 *
 * Replacement for createSimpleStaging() that uses the real Git index
 * implementation with an in-memory filesystem. Useful for tests and
 * scenarios where no disk persistence is needed.
 */
export function createMemoryGitStaging(): Staging {
  const files = createInMemoryFilesApi();
  return new GitStaging(files, "index");
}
