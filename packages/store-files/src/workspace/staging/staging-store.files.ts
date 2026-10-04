import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode, type FilesApi, readFile } from "@statewalker/vcs-core";
import type { IndexBuilder, IndexEditor, Staging } from "@statewalker/vcs-working-tree";
import {
  INDEX_VERSION_2,
  type IndexVersion,
  MergeStage,
  type MergeStageValue,
  parseIndexFile,
  type StagingEdit,
  type StagingEntry,
  type StagingEntryOptions,
  serializeIndexFile,
} from "@statewalker/vcs-working-tree";

/**
 * File-based staging store implementation.
 *
 * Stores the index in Git-compatible DIRC format.
 * Supports index versions 2, 3, and 4.
 *
 * All entries are kept sorted by (path, stage) for binary search.
 */
export class FileStagingStore implements Staging {
  private _entries: StagingEntry[] = [];
  private updateTime = 0;
  private version: IndexVersion = INDEX_VERSION_2;

  constructor(
    private readonly files: FilesApi,
    private readonly indexPath: string,
  ) {}

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
      editor.remove(path);
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

  createEditor(): IndexEditor {
    return new FileStagingEditor(this);
  }

  async clear(): Promise<void> {
    this._entries = [];
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
    entries: StagingEntry[],
    prefix: string,
  ): Promise<ObjectId> {
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
      const subtreeId = await this.buildTreeRecursive(trees, dirEntries, subPrefix);
      treeEntries.push({
        name: dirName,
        mode: FileMode.TREE,
        id: subtreeId,
      });
    }

    return trees.store(treeEntries);
  }

  async readTree(trees: Trees, treeId: ObjectId): Promise<void> {
    this._entries = [];
    await this.addTreeRecursive(trees, treeId, "", MergeStage.MERGED);
    this.sortEntries();
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
    this._entries = newEntries;
  }

  /** @internal - Used by builder/editor */
  _getEntries(): StagingEntry[] {
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
class FileStagingBuilder implements IndexBuilder {
  private _entries: StagingEntry[] = [];
  private keeping: Array<{ start: number; count: number }> = [];

  constructor(private readonly store: FileStagingStore) {}

  add(options: StagingEntryOptions): void {
    const entry: StagingEntry = {
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

  async finish(): Promise<void> {
    // Merge kept entries from existing index
    const existingEntries = this.store._getEntries();
    for (const { start, count } of this.keeping) {
      for (let i = 0; i < count; i++) {
        if (start + i < existingEntries.length) {
          this._entries.push(existingEntries[start + i]);
        }
      }
    }

    // Sort entries by (path, stage)
    this._entries.sort((a, b) => {
      const pathCmp = comparePaths(a.path, b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.stage - b.stage;
    });

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
  }

  private validateStages(): void {
    // If stage 0 exists for a path, no other stages should exist
    const pathStages = new Map<string, Set<MergeStageValue>>();

    for (const entry of this._entries) {
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
class FileStagingEditor implements IndexEditor {
  private edits: StagingEdit[] = [];

  constructor(private readonly store: FileStagingStore) {}

  add(edit: StagingEdit): void {
    this.edits.push(edit);
  }

  remove(path: string, _stage?: MergeStageValue): void {
    // For now, remove all stages (ignore stage parameter)
    // TODO: Implement stage-specific removal if needed
    this.edits.push({ path, apply: () => undefined });
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

  async finish(): Promise<void> {
    // Sort edits by path for efficient merge
    this.edits.sort((a, b) => comparePaths(a.path, b.path));

    const existingEntries = this.store._getEntries();
    const newEntries: StagingEntry[] = [];

    let entryIndex = 0;
    let editIndex = 0;

    while (entryIndex < existingEntries.length || editIndex < this.edits.length) {
      const entry = existingEntries[entryIndex];
      const edit = this.edits[editIndex];

      if (!edit) {
        // No more edits, keep remaining entries
        newEntries.push(entry);
        entryIndex++;
      } else if (!entry) {
        // No more entries, apply remaining edits (insertions)
        const result = edit.apply(undefined);
        if (result) newEntries.push(result);
        editIndex++;
      } else {
        const cmp = comparePaths(entry.path, edit.path);

        if (cmp < 0) {
          // Entry before edit - keep entry
          newEntries.push(entry);
          entryIndex++;
        } else if (cmp > 0) {
          // Edit path comes before entry path
          // Check if entry is under a tree being deleted
          if (isDeleteTree(edit) && entry.path.startsWith(`${edit.path}/`)) {
            // Skip entry (deleted by tree)
            entryIndex++;
          } else {
            // Apply edit (insertion) and move to next edit
            const result = edit.apply(undefined);
            if (result) newEntries.push(result);
            editIndex++;
          }
        } else {
          // Edit applies to this entry
          if (isResolveConflict(edit)) {
            // Handle conflict resolution
            this.applyConflictResolution(existingEntries, entryIndex, edit, newEntries);
            // Skip all stages for this path
            while (
              entryIndex < existingEntries.length &&
              existingEntries[entryIndex].path === edit.path
            ) {
              entryIndex++;
            }
          } else {
            const result = edit.apply(entry);
            if (result) newEntries.push(result);
            entryIndex++;
          }
          editIndex++;
        }
      }
    }

    this.store._replaceEntries(newEntries);
  }

  private applyConflictResolution(
    entries: StagingEntry[],
    startIndex: number,
    edit: StagingEdit & { chooseStage?: MergeStageValue },
    output: StagingEntry[],
  ): void {
    // Find the entry at the chosen stage
    let chosen: StagingEntry | undefined;
    let i = startIndex;

    while (i < entries.length && entries[i].path === edit.path) {
      if (edit.chooseStage !== undefined && entries[i].stage === edit.chooseStage) {
        chosen = entries[i];
      }
      i++;
    }

    if (chosen) {
      // Create stage 0 entry from chosen stage
      output.push({
        ...chosen,
        stage: MergeStage.MERGED,
      });
    }
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
