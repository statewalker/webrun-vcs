/**
 * Staging - The index/staging area for preparing commits
 *
 * This interface provides operations for the staging area (Git index).
 * Use factory functions to create instances:
 * - createGitStaging() for Git index file format
 * - createMemoryGitStaging() for in-memory/testing
 */

import type { ObjectId, Trees } from "@statewalker/vcs-core";
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
  /** Keep existing entries not in tree */
  keepExisting?: boolean;
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
   * Check if staging is outdated
   */
  isOutdated(): Promise<boolean>;

  /**
   * Get last update time (ms since epoch)
   */
  getUpdateTime(): number;

  /**
   * Clear all entries
   */
  clear(): Promise<void>;
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
