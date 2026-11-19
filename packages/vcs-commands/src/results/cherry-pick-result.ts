import type { ObjectId } from "@statewalker/vcs-core";

import type { MergeFailureReason } from "../errors/merge-errors.js";

/**
 * Status of a cherry-pick operation.
 *
 * Based on JGit's CherryPickResult.CherryPickStatus.
 */
export enum CherryPickStatus {
  /** Cherry-pick completed successfully */
  OK = "ok",
  /** Cherry-pick failed due to conflicts */
  CONFLICTING = "conflicting",
  /** Cherry-pick failed (preconditions not met) */
  FAILED = "failed",
}

/**
 * Result of a cherry-pick operation.
 *
 * Based on JGit's CherryPickResult.
 */
export interface CherryPickResult {
  /** Status of the cherry-pick operation */
  readonly status: CherryPickStatus;
  /** New HEAD commit after cherry-pick (if successful) */
  readonly newHead?: ObjectId;
  /** Cherry-picked commits (for OK status) */
  readonly cherryPickedRefs: ObjectId[];
  /** Paths with conflicts (for CONFLICTING status) */
  readonly conflicts?: string[];
  /** Paths that failed (for FAILED status) */
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
