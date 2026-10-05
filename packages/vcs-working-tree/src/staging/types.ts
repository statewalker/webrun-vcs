/**
 * Staging types - Shared types for staging/index operations
 */

import type { FileModeValue, ObjectId } from "@statewalker/vcs-core";

/**
 * Merge stage for index entries.
 *
 * During normal state, all entries are at STAGE_0 (merged).
 * During merge conflicts, entries exist at stages 1-3:
 * - Stage 1: Common ancestor (base)
 * - Stage 2: Current branch (ours)
 * - Stage 3: Branch being merged (theirs)
 *
 * Following JGit DirCacheEntry stage constants.
 */
export const MergeStage = {
  /** Normal/merged state (stage 0) */
  MERGED: 0,
  /** Base version - common ancestor (stage 1) */
  BASE: 1,
  /** Our version - current branch (stage 2) */
  OURS: 2,
  /** Their version - being merged (stage 3) */
  THEIRS: 3,
} as const;

export type MergeStageValue = (typeof MergeStage)[keyof typeof MergeStage];

/**
 * A single entry in the staging area (index).
 *
 * Represents the cached state of a file to be committed.
 * Based on JGit's DirCacheEntry structure.
 *
 * Git index entry format (62 bytes header + variable path):
 * - ctime: 8 bytes (seconds + nanoseconds)
 * - mtime: 8 bytes (seconds + nanoseconds)
 * - dev: 4 bytes
 * - ino: 4 bytes
 * - mode: 4 bytes
 * - uid: 4 bytes
 * - gid: 4 bytes
 * - size: 4 bytes
 * - objectId: 20 bytes (SHA-1)
 * - flags: 2 bytes (stage bits + name length)
 * - path: variable (null-terminated)
 */
export interface StagingEntry {
  /** Repository-relative path (UTF-8, forward slashes) */
  readonly path: string;
  /** File mode (regular, executable, symlink, gitlink) */
  readonly mode: FileModeValue | number;
  /** Object ID of staged content */
  readonly objectId: ObjectId;
  /** Merge stage (0 for normal, 1-3 for conflicts) */
  readonly stage: MergeStageValue;
  /** File size in bytes (working tree size, may differ from blob due to filters) */
  readonly size: number;
  /** Last modification time (ms since epoch) */
  readonly mtime: number;
  /** Creation time (ms since epoch, optional) */
  readonly ctime?: number;
  /** Device ID (for change detection, optional) */
  readonly dev?: number;
  /** Inode number (for change detection, optional) */
  readonly ino?: number;
  /** Assume-valid flag (skip stat checking) */
  readonly assumeValid?: boolean;
  /** Intent-to-add flag (placeholder for empty files) */
  readonly intentToAdd?: boolean;
  /** Skip-worktree flag (sparse checkout) */
  readonly skipWorktree?: boolean;
}

/**
 * Options for creating a staging entry.
 */
export interface StagingEntryOptions {
  path: string;
  mode: FileModeValue | number;
  objectId: ObjectId;
  stage?: MergeStageValue;
  size?: number;
  mtime?: number;
  ctime?: number;
  dev?: number;
  ino?: number;
  assumeValid?: boolean;
  intentToAdd?: boolean;
  skipWorktree?: boolean;
}

/**
 * Edit operation base interface.
 *
 * Edit operations are applied by the StagingEditor during finish().
 */
export interface StagingEdit {
  /** Path this edit applies to */
  readonly path: string;

  /**
   * Apply this edit to an entry.
   *
   * @param entry Current entry (undefined for new paths)
   * @returns New entry, or undefined to delete
   */
  apply(entry: StagingEntry | undefined): StagingEntry | undefined;
}
