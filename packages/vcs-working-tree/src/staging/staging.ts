/**
 * Staging - The index/staging area for preparing commits
 *
 * This interface provides operations for the staging area (Git index).
 * Use factory functions to create instances:
 * - createGitStaging() for Git index file format
 * - createMemoryGitStaging() for in-memory/testing
 */

import type { ObjectId, Trees } from "@statewalker/vcs-core";
import type { CacheTree } from "./cache-tree.js";
import type { ResolveUndoRecord } from "./index-extensions.js";
import type { IndexStatUpdate, RacyCheck } from "./stat-refresh.js";
import type { MergeStageValue, StagingEntry, StagingEntryOptions } from "./types.js";

// Re-export types for consumers
export {
  MergeStage,
  type MergeStageValue,
  type StagingEntry,
  type StagingEntryOptions,
} from "./types.js";

/**
 * IndexEntry - alias for StagingEntry for the new Staging interface.
 */
export type IndexEntry = StagingEntry;

/**
 * IndexEntryOptions - alias for StagingEntryOptions for the new Staging interface.
 */
export type IndexEntryOptions = StagingEntryOptions;

/**
 * Options for iterating staging entries.
 */
export interface EntryIteratorOptions {
  /** Filter by path prefix */
  prefix?: string;
  /** Include only specific stages */
  stages?: MergeStageValue[];
}

/**
 * Options for reading a tree into staging.
 */
export interface ReadTreeOptions {
  /** Path prefix for entries */
  prefix?: string;
  /** Merge stage for entries (default: 0) */
  stage?: MergeStageValue;
  /** Keep the resolve-undo records (git's `reset --mixed`; default: dropped) */
  keepResolveUndo?: boolean;
  /** Keep existing entries not in tree */
  keepExisting?: boolean;
  /**
   * Read the tree over the index as unpack-trees' one-way merge does (`reset --hard`,
   * `checkout -f`; git's `oneway_merge` and `merged_entry`): a stage-0 entry the tree holds
   * unchanged (same mode and object id) stays as it was, its flags (skip-worktree,
   * assume-unchanged, intent-to-add) and stat data kept; one the tree changes takes the
   * tree's entry with the old skip-worktree bit ("Migrate old flags over"). `"flags"` keeps
   * the flags of an unchanged entry but not its stat data (for a caller that writes every
   * file again). Default: every entry is the tree's, without flags or stat data.
   */
  keepMatching?: boolean | "flags";
}

/**
 * Conflict resolution options.
 */
export type ConflictResolution = "ours" | "theirs" | "base" | IndexEntry;

/**
 * Staging interface - the index/staging area
 *
 * This is the primary interface for working with the staging area.
 * Use factory functions to create instances:
 * - createGitStaging() for Git index file format
 * - createMemoryGitStaging() for in-memory/testing
 */
export interface Staging {
  // ========== Entry Operations ==========

  /**
   * Get total number of entries (all stages)
   */
  getEntryCount(): Promise<number>;

  /**
   * Check if a path exists in staging
   */
  hasEntry(path: string): Promise<boolean>;

  /**
   * Get entry at path (stage 0 by default)
   */
  getEntry(path: string, stage?: MergeStageValue): Promise<IndexEntry | undefined>;

  /**
   * Get all entries for a path (all stages)
   */
  getEntries(path: string): Promise<IndexEntry[]>;

  /**
   * Set/update an entry
   */
  setEntry(entry: IndexEntry | IndexEntryOptions): Promise<void>;

  /**
   * Remove entry at path
   *
   * @returns True if any entry was removed
   */
  removeEntry(path: string, stage?: MergeStageValue): Promise<boolean>;

  /**
   * Iterate over entries in Git canonical order
   */
  entries(options?: EntryIteratorOptions): AsyncIterable<IndexEntry>;

  /**
   * Every entry in Git canonical order, at once: what `entries()` yields, for a caller that
   * reads the whole index (no await per entry). Optional.
   */
  entryList?(): readonly IndexEntry[];

  // ========== Conflict Handling ==========

  /**
   * Check if staging has any conflicts
   */
  hasConflicts(): Promise<boolean>;

  /**
   * Get list of conflicted paths
   */
  getConflictedPaths(): Promise<string[]>;

  /**
   * Resolve conflict by selecting a version
   */
  resolveConflict(path: string, resolution: ConflictResolution): Promise<void>;

  // ========== Tree Operations ==========

  /**
   * Write staging as a tree object
   *
   * @throws If staging has unresolved conflicts
   */
  writeTree(trees: Trees): Promise<ObjectId>;

  /**
   * Read a tree into staging
   */
  readTree(trees: Trees, treeId: ObjectId, options?: ReadTreeOptions): Promise<void>;

  // ========== Bulk Operations ==========

  /**
   * Create a builder for bulk modifications
   */
  createBuilder(): IndexBuilder;

  /**
   * Create an editor for targeted modifications
   */
  createEditor(): IndexEditor;

  /**
   * Records the conflict stages a resolution removes (git's resolve-undo, written with the
   * index as its `REUC` extension, what `git checkout -m <path>` restores). Absent: a
   * staging area that keeps none.
   */
  recordResolveUndo?(records: readonly ResolveUndoRecord[]): void;

  /**
   * Drops the resolve-undo records on the next write, as git does whenever unpack-trees
   * writes the index (merge, cherry-pick, rebase, checkout, `reset --hard`). Absent: a
   * staging area that keeps none.
   */
  clearResolveUndo?(): void;

  /**
   * Writes `tree` as the index's cache-tree (`TREE` extension) with the next `write`, as git
   * does after unpack-trees switches the index to a known tree. It must describe the entries
   * written then. Absent: a staging area without an index file.
   */
  setCacheTree?(tree: CacheTree | undefined): void;

  /**
   * The index's cache-tree (`TREE` extension) for its current entries, as read or last
   * written; undefined when there is none or the entries changed since. Absent: a staging
   * area without an index file.
   */
  getCacheTree?(): CacheTree | undefined;

  // ========== Persistence ==========

  /**
   * Read staging from storage
   */
  read(): Promise<void>;

  /**
   * Write staging to storage
   */
  write(): Promise<void>;

  /**
   * Takes the index lock now and holds it until the returned lock is committed or rolled
   * back, as git's `repo_hold_locked_index` for a commit: edits are made in memory, written
   * into the lock with `write()`, and the lock renamed over the index with `commit()` once
   * the commit is made (`rollback()` removes it, the index left as it was). Meanwhile every
   * other writer, native git included, is refused (`index.lock` exists). Absent: a staging
   * with no index file (memory, a database), which callers `write()` at the end instead.
   *
   * @throws IndexLockedError when the lock exists
   * @throws IndexChangedError when the index on disk is not the one last read or written
   */
  lockIndex?(): Promise<StagingIndexLock>;

  /**
   * Check if staging is outdated
   */
  isOutdated(): Promise<boolean>;

  /**
   * Whether this instance holds edits (entries, resolve-undo, cache-tree, version) made
   * since the index was last read or written. A command may re-read an outdated index
   * (as git reads the index at its start) only when there are none. Absent: unknown,
   * treated as having edits.
   */
  hasUnwrittenChanges?(): boolean;

  /**
   * Get last update time (ms since epoch)
   */
  getUpdateTime(): number;

  /**
   * Stores fresh stats for entries still as compared (compare-and-set), as git's index
   * refresh: for an index file, written only when the file is unchanged since read, and
   * without writing other in-memory edits. Returns whether anything was stored. Absent:
   * callers apply the same compare-and-set through an editor.
   */
  refreshStats?(updates: IndexStatUpdate[]): Promise<boolean>;

  /**
   * Clears the skip-worktree flag of the stage-0 entries at `paths` as part of reading the
   * index (git's `clear_skip_worktree_from_present_files` in `repo_read_index`): not an edit
   * (`hasUnwrittenChanges` stays as it is), the entries kept as read for racy-git smudging,
   * and the flags written by the next `write()` or `refreshStats()`. Optional: callers
   * clear the flags through an editor otherwise.
   */
  clearSkipWorktree?(paths: ReadonlySet<string>): void;

  /**
   * Sets the check `write()` applies to racily clean entries (git's smudging: an entry whose
   * mtime second is not older than the index file and that changed behind a matching stat is
   * written with size 0). Commands install one that reads the worktree.
   */
  setRacyCheck?(check: RacyCheck | undefined): void;

  /**
   * Clear all entries
   */
  clear(): Promise<void>;
}

/**
 * The index lock a `Staging` holds for a commit (see `Staging.lockIndex`).
 *
 * @example
 * ```typescript
 * const lock = await staging.lockIndex();
 * try {
 *   await editTheIndex(staging);
 *   await lock.write(); // the new index, still in index.lock
 *   await makeTheCommit();
 *   await lock.commit(); // renamed over the index
 * } catch (error) {
 *   await lock.rollback(); // the index as it was
 *   await staging.read();
 *   throw error;
 * }
 * ```
 */
export interface StagingIndexLock {
  /** Writes the staging's entries as they are now into the lock (again, if called again). */
  write(): Promise<void>;
  /** Renames the lock over the index (what `write()` wrote; the index as read if nothing). */
  commit(): Promise<void>;
  /** Removes the lock: the index stays as it was. Does nothing once committed. */
  rollback(): Promise<void>;
}

/**
 * Builder for bulk staging modifications.
 *
 * Use different name to avoid conflict with legacy StagingBuilder.
 */
export interface IndexBuilder {
  /**
   * Add a new entry
   */
  add(entry: IndexEntryOptions): void;

  /**
   * Keep range of entries from existing staging
   */
  keep(startIndex: number, count: number): void;

  /**
   * Add all entries from a tree recursively
   */
  addTree(trees: Trees, treeId: ObjectId, prefix: string, stage?: MergeStageValue): Promise<void>;

  /**
   * Finalize the builder
   */
  finish(): Promise<void>;
}

/**
 * Edit operation for staging modifications.
 *
 * Use different name to avoid conflict with legacy StagingEdit.
 */
export interface IndexEdit {
  /** Path this edit applies to */
  readonly path: string;

  /**
   * Apply this edit to an entry
   */
  apply(entry: IndexEntry | undefined): IndexEntry | undefined;
}

/**
 * Editor for targeted staging modifications.
 *
 * Use different name to avoid conflict with legacy StagingEditor.
 */
export interface IndexEditor {
  /**
   * Add an edit operation
   */
  add(edit: IndexEdit): void;

  /**
   * Remove an entry from staging
   */
  remove(path: string, stage?: MergeStageValue): void;

  /**
   * Update or add an entry
   */
  upsert(entry: IndexEntryOptions): void;

  /**
   * Finalize all edits
   */
  finish(): Promise<void>;
}

/**
 * Extended Staging interface with additional query capabilities.
 */
export interface StagingExtended extends Staging {
  /**
   * Find entries by pattern
   */
  findByPattern?(pattern: string): AsyncIterable<IndexEntry>;

  /**
   * Get entries modified after a timestamp
   */
  findModifiedAfter?(timestamp: number): AsyncIterable<IndexEntry>;
}
