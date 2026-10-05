import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Represents a stashed commit entry.
 *
 * Based on JGit's stash structure where each stash is a merge commit with:
 * - Parent 0: The HEAD commit at stash time
 * - Parent 1: The index state
 * - Parent 2 (optional): Untracked files
 */
export interface StashEntry {
  /** The stash commit ID */
  readonly commitId: ObjectId;

  /** The original HEAD commit at stash time */
  readonly headCommit: ObjectId;

  /** The index commit (staged changes) */
  readonly indexCommit: ObjectId;

  /** The untracked files commit (optional) */
  readonly untrackedCommit?: ObjectId;

  /** The stash message */
  readonly message: string;

  /** The stash index (0-based, most recent first) */
  readonly index: number;

  /** Timestamp when stash was created */
  readonly timestamp: number;
}

/**
 * Status of stash apply operation.
 */
export enum StashApplyStatus {
  /** Stash was applied successfully */
  OK = "ok",

  /** Stash apply resulted in conflicts */
  CONFLICTS = "conflicts",

  /** Stash apply failed */
  FAILED = "failed",
}

/**
 * Result of stash apply operation.
 */
export interface StashApplyResult {
  /** Status of the apply */
  readonly status: StashApplyStatus;

  /** The stash commit that was applied */
  readonly stashCommit?: ObjectId;

  /** List of conflicting paths */
  readonly conflicts?: string[];
}
