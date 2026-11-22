/**
 * Staging - The index/staging area for preparing commits
 *
 * This interface provides operations for the staging area (Git index).
 * Use factory functions to create instances:
 * - createGitStaging() for Git index file format
 * - createMemoryGitStaging() for in-memory/testing
 */

import type { ObjectId, Trees } from "@statewalker/vcs-core";
import type { UntrackedCache } from "../status/untracked-cache.js";
import type { CacheTree } from "./cache-tree.js";
import type { ResolveUndoRecord } from "./index-extensions.js";
import type { IndexHost } from "./index-file.js";
import type { IndexStatUpdate, RacyCheck } from "./stat-refresh.js";
import type { MergeStageValue, StagingEntry, StagingEntryOptions } from "./types.js";

/** What else a {@link Staging.refreshStats} write carries. */
export interface RefreshStatsOptions {
  /**
   * The untracked cache to write with the refreshed stats (`null`: remove it), as git status
   * writes the index when its untracked cache changed (`UNTRACKED_CHANGED`) even with no
   * stat to store; undefined keeps the one the index has
   */
  untrackedCache?: UntrackedCache | null;
}

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
   * The resolve-undo records the index holds (its `REUC` extension, with the records
   * recorded since it was read), sorted by path: what `git checkout -m <path>` brings back
   * as conflict stages (`unmerge_index`). Absent: a staging area that keeps none.
   */
  getResolveUndo?(): ResolveUndoRecord[];

  /**
   * Drops the resolve-undo records of `paths` on the next write (git's `unmerge_index`
   * forgets a record once it has restored the path's stages). Absent: a staging area that
   * keeps none.
   */
  dropResolveUndo?(paths: ReadonlySet<string>): void;

  /**
   * Writes `tree` as the index's cache-tree (`TREE` extension) with the next `write`, as git
   * does after unpack-trees switches the index to a known tree. It must describe the entries
   * written then; undefined writes none. Absent: a staging area without an index file.
   */
  setCacheTree?(tree: CacheTree | undefined): void;

  /**
   * The index's cache-tree (`TREE` extension) for its current entries, as read or last
   * written; undefined when there is none or the entries changed since. Absent: a staging
   * area without an index file.
   */
  getCacheTree?(): CacheTree | undefined;

  /**
   * The index's untracked cache (`UNTR` extension), as read or last written, the directories
   * of paths added or removed since invalidated; a fresh copy, undefined when there is none.
   * Absent: a staging area without an index file (no untracked cache).
   */
  getUntrackedCache?(): UntrackedCache | undefined;

  /**
   * Writes `cache` as the index's untracked cache with the next `write` or `refreshStats`
   * (`null`: none, git's `remove_untracked_cache`).
   */
  setUntrackedCache?(cache: UntrackedCache | null): void;

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
   * What the staging holds now, to put back exactly with {@link restoreState}: the entry
   * objects themselves (so the ones kept as read stay checked for racy-git smudging), the
   * pending cache-tree and untracked cache, and whether there are unwritten edits. For a
   * temporary change of the entries that no write follows (a commit's false index shown
   * in its template, an edit rolled back). Absent: callers rebuild the entries.
   *
   * @example
   * ```typescript
   * const saved = staging.saveState?.();
   * // ... change the entries, never writing them ...
   * if (saved) staging.restoreState?.(saved);
   * ```
   */
  saveState?(): StagingState;

  /**
   * Puts back what {@link saveState} saved. Only valid while the index was neither read
   * nor written since (a write in between would be undone in memory only).
   */
  restoreState?(state: StagingState): void;

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
   * Whether the configuration has a write of the index change it although no entry changed
   * (git's `cache_changed` bits set when it reads the index): `core.splitIndex` splitting or
   * unsplitting it, and with `untrackedCache` `core.untrackedCache` adding or removing the
   * untracked cache. A command writing only a changed index (git's `SKIP_IF_UNCHANGED`, as
   * `add`) writes then too. Absent: never.
   */
  wantsRewrite?(options?: { untrackedCache?: boolean }): Promise<boolean>;

  /**
   * Get last update time (ms since epoch)
   */
  getUpdateTime(): number;

  /**
   * Whether this instance's last read found no index file and nothing has been written
   * since (git's `is_index_unborn` before the entry count: `!istate->timestamp.sec`).
   * Undefined when unknown (never read) or for stores without an index file (memory, KV,
   * SQL); `isIndexUnborn` then falls back to {@link getUpdateTime}.
   */
  isUnborn?(): boolean | undefined;

  /**
   * Stores fresh stats for entries still as compared (compare-and-set), as git's index
   * refresh: for an index file, written only when the file is unchanged since read, and
   * without writing other in-memory edits. Returns whether anything was stored. Absent:
   * callers apply the same compare-and-set through an editor.
   */
  refreshStats?(updates: IndexStatUpdate[], options?: RefreshStatsOptions): Promise<boolean>;

  /**
   * Clears the skip-worktree flag of the entries at `paths` (any stage) as part of reading the
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
   * Sets what runs after each write of the index file: `write()`, a lock's `write()` (before
   * the lock is committed) and a `refreshStats` that stored something, as git runs its
   * post-index-change hook at the end of `do_write_locked_index`. Undefined removes it.
   * Absent: a staging with no index file.
   */
  setWriteHook?(hook: (() => Promise<void>) | undefined): void;

  /** The hook {@link setWriteHook} installed, if any. */
  getWriteHook?(): (() => Promise<void>) | undefined;

  /**
   * Gives an index file what git reads from the repository around it: the configuration a
   * write follows (`core.splitIndex`, `splitIndex.*`, `index.sparse` with the cone patterns,
   * `core.sharedRepository`) and the trees a sparse index expands from and collapses into.
   * Without one a split index stays split and nothing else changes, and a sparse index
   * cannot be read. Absent: a staging with no index file.
   */
  setIndexHost?(host: IndexHost | undefined): void;

  /** The host {@link setIndexHost} installed, if any. */
  getIndexHost?(): IndexHost | undefined;

  /**
   * How the index file was last read or written: split (`link`), sparse (`sdir`). The entries
   * are always held merged and expanded. Absent: a staging with no index file.
   */
  indexLayout?(): { split: boolean; sparse: boolean };

  /**
   * Holds back `write()` until the returned function is called, which then writes once if
   * any write was asked meanwhile: a command that writes the index several times where git
   * writes it once (a reset writes the entries, then their new stat data) leaves the index
   * file, and a split index's shared index, as git's one write does. Absent: a staging with
   * no index file.
   */
  holdWrites?(): () => Promise<void>;

  /**
   * Clear all entries
   */
  clear(): Promise<void>;
}

/** What `Staging.saveState` saved (opaque: only the same staging restores it). */
export interface StagingState {
  readonly staging: unknown;
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
  /**
   * Reads the lock back into the staging as another writer left it (a hook given the lock
   * as `GIT_INDEX_FILE`): git's `discard_index` + `read_index_from(<lock>)`. A later
   * `commit()` renames it over the index (with `write()` first, what the staging holds then).
   */
  reread?(): Promise<void>;
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
  finish(options?: IndexBuilderFinishOptions): Promise<void>;
}

/** How {@link IndexBuilder.finish} treats the entries it was given. */
export interface IndexBuilderFinishOptions {
  /**
   * Count every entry the builder took (given back as it is, or a copy) as set in this
   * session, as after git's refresh (`CE_UPTODATE`): the next write does not check it for
   * racy-git smudging, so it reads no file. For the merge family, which rewrites the index
   * around the paths it writes without first refreshing the whole index (git's
   * `try_merge_strategy` refreshes it, reading every racily clean file). Without it, a copy
   * of an entry kept as read stays as read (git copies an entry with its flags).
   *
   * @example
   * ```typescript
   * const builder = staging.createBuilder();
   * for (const entry of entries) builder.add(entry);
   * await builder.finish({ upToDate: true });
   * ```
   */
  upToDate?: boolean;
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
