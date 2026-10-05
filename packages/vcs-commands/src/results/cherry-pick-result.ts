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
}
