/**
 * Git index file-based Staging implementation
 *
 * Reads/writes the standard Git index file format (DIRC).
 * Supports index versions 2, 3, and 4.
 *
 * All entries are kept sorted by (path, stage) for binary search.
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { createInMemoryFilesApi, FileMode, type FilesApi, readFile } from "@statewalker/vcs-core";
import {
  INDEX_VERSION_2,
  type IndexVersion,
  parseIndexFile,
  serializeIndexFile,
} from "./index-format.js";
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
} from "./staging.js";
import { MergeStage, type MergeStageValue, type StagingEntry } from "./types.js";

/**
 * Git index file-based Staging implementation
 *
 * This implements the new Staging interface using the standard Git index format.
 */
export class GitStaging implements Staging {
  private _entries: IndexEntry[] = [];
  private updateTime = 0;
  private version: IndexVersion = INDEX_VERSION_2;

  constructor(
    private readonly files: FilesApi,
    private readonly indexPath: string,
  ) {}

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
    const stage0 = this._entries.filter((e) => e.stage === MergeStage.MERGED);
    return this.buildTreeRecursive(trees, stage0, "");
  }

  private async buildTreeRecursive(
    trees: Trees,
    entries: IndexEntry[],
    prefix: string,
  ): Promise<ObjectId> {
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
      const subtreeId = await this.buildTreeRecursive(trees, dirEntries, subPrefix);
      treeEntries.push({
        name: dirName,
        mode: FileMode.TREE,
        id: subtreeId,
      });
    }

    return storeTreeEntries(trees, treeEntries);
  }

  async readTree(trees: Trees, treeId: ObjectId, options?: ReadTreeOptions): Promise<void> {
    if (!options?.keepExisting) {
      this._entries = [];
    }

    const prefix = options?.prefix ?? "";
    const stage = options?.stage ?? MergeStage.MERGED;

    await this.addTreeRecursive(trees, treeId, prefix, stage);
    this.sortEntries();
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

  createEditor(): IndexEditor {
    return new GitStagingEditor(this);
  }

  // ============ Persistence ============

  async read(): Promise<void> {
    const stats = await this.files.stats(this.indexPath);
    if (!stats) {
      // No index file - start empty
      this._entries = [];
      this.updateTime = 0;
      return;
    }

    const data = await readFile(this.files, this.indexPath);
    const parsed = await parseIndexFile(data);

    this._entries = parsed.entries;
    this.version = parsed.version;
    this.updateTime = stats.lastModified ?? Date.now();
  }

  async write(): Promise<void> {
    const data = await serializeIndexFile(this._entries, this.version);
    await this.files.write(this.indexPath, [data]);
    this.updateTime = Date.now();
  }

  async isOutdated(): Promise<boolean> {
    const stats = await this.files.stats(this.indexPath);
    if (!stats?.lastModified) return false;
    return stats.lastModified > this.updateTime;
  }

  getUpdateTime(): number {
    return this.updateTime;
  }

  async clear(): Promise<void> {
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
        dev: entry.dev,
        ino: entry.ino,
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
      dev: options.dev,
      ino: options.ino,
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
      dev: options.dev,
      ino: options.ino,
      assumeValid: options.assumeValid,
      intentToAdd: options.intentToAdd,
      skipWorktree: options.skipWorktree,
    };

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
  const aLen = a.length;
  const bLen = b.length;
  const minLen = Math.min(aLen, bLen);

  for (let i = 0; i < minLen; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }

  return aLen - bLen;
}

// ========== Helper Functions ==========

/**
 * Store tree entries using Trees interface.
 */
function storeTreeEntries(trees: Trees, entries: Iterable<TreeEntry>): Promise<ObjectId> {
  return trees.store(entries);
}

/**
 * Factory function to create a Git-based Staging
 */
export function createGitStaging(files: FilesApi, indexPath: string): Staging {
  return new GitStaging(files, indexPath);
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
