import type { ObjectId } from "@statewalker/vcs-core";

import type { MergeFailureReason } from "../errors/merge-errors.js";

/**
 * Status of a revert operation.
 *
 * Based on JGit's RevertCommand result patterns.
 */
export enum RevertStatus {
  /** Revert completed successfully */
  OK = "ok",
  /** Revert resulted in conflicts */
  CONFLICTING = "conflicting",
  /** Revert failed due to dirty working tree or other issues */
  FAILED = "failed",
}

/**
 * Result of a revert operation.
 *
 * Contains the status, new HEAD, and details about reverted commits or conflicts.
 */
export interface RevertResult {
  /** Status of the revert operation */
  readonly status: RevertStatus;
  /** New HEAD commit after revert (undefined if failed/conflicting) */
  readonly newHead?: ObjectId;
  /** Commits that were successfully reverted */
  readonly revertedRefs: ObjectId[];
  /** Conflicting paths (if status is CONFLICTING) */
  readonly conflicts?: string[];
  /** Paths that failed (if status is FAILED) */
  readonly failingPaths?: Map<string, MergeFailureReason>;
  /** The error printed on stderr for a refusal, or for a stop at a conflict (with hints) */
  readonly message?: string;
  /** What is printed on stdout: merge-ort's `Auto-merging f`, `CONFLICT (...)` lines */
  readonly output?: string[];
  /**
   * What the sparse checkout printed on stderr while the result was written, line by line:
   * the patterns' warnings, git's "The following paths are not up to date and were left
   * despite sparse patterns:" block. Absent when there was nothing to say.
   */
  readonly warnings?: string[];
}
