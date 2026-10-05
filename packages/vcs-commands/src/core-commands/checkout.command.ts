/**
 * Checkout interface for materializing tree contents to filesystem.
 *
 * Supports:
 * - Branch/tag/commit checkout
 * - Path-specific checkout
 * - Conflict detection
 * - Progress reporting
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/CheckoutCommand.java
 */

import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Options for checkout operations.
 */
export interface CheckoutOptions {
  /** Force checkout even if working tree has changes */
  force?: boolean;

  /** Create branch at target commit */
  createBranch?: string;

  /** Checkout specific paths only */
  paths?: string[];

  /** Source for path checkout (default: "index") */
  source?: "index" | "head" | ObjectId;

  /** Progress callback */
  onProgress?: (current: number, total: number, path: string) => void;
}

/**
 * Result of a checkout operation.
 */
export interface CheckoutResult {
  /** Files updated in working tree */
  updated: string[];

  /** Files added to working tree */
  added: string[];

  /** Files removed from working tree */
  removed: string[];

  /** Files that couldn't be checked out (conflicts) */
  conflicts: string[];

  /** New HEAD after checkout */
  newHead?: ObjectId;

  /** New branch name if created */
  newBranch?: string;
}

/**
 * Checkout command interface.
 *
 * Materializes tree contents from commits, branches, or tags to the working tree.
 * Handles conflict detection and index updates.
 */
export interface Checkout {
  /**
   * Checkout a branch, tag, or commit.
   *
   * If target is a branch name, HEAD becomes a symbolic ref to that branch.
   * If target is a tag or commit, HEAD becomes detached.
   *
   * @param target Branch name, tag name, or commit ID
   * @param options Checkout options
   * @returns Checkout result with lists of affected files
   * @throws Error if target cannot be resolved or conflicts exist (without force)
   */
  checkout(target: string, options?: CheckoutOptions): Promise<CheckoutResult>;

  /**
   * Checkout specific paths from index or commit.
   *
   * Unlike full checkout, this:
   * - Does not move HEAD
   * - Only updates specified paths
   * - Restores files from index (default) or a specific commit
   *
   * @param paths Paths to checkout
   * @param options Checkout options (source specifies where to get files)
   * @returns Checkout result
   */
  checkoutPaths(paths: string[], options?: CheckoutOptions): Promise<CheckoutResult>;
}

/**
 * Conflict information for a path.
 */
export interface CheckoutConflict {
  /** Path with conflict */
  path: string;

  /** Reason for conflict */
  reason: CheckoutConflictReason;

  /** Local changes that would be overwritten (if applicable) */
  localChanges?: "modified" | "deleted" | "untracked";
}

/**
 * Reasons why checkout failed for a path.
 */
export const CheckoutConflictReason = {
  /** Local modifications would be overwritten */
  LOCAL_MODIFIED: "LOCAL_MODIFIED",

  /** Untracked file would be overwritten */
  UNTRACKED_OVERWRITTEN: "UNTRACKED_OVERWRITTEN",

  /** File deleted locally but modified in target */
  DELETED_LOCALLY: "DELETED_LOCALLY",

  /** Cannot delete directory - not empty */
  DIRECTORY_NOT_EMPTY: "DIRECTORY_NOT_EMPTY",
} as const;

export type CheckoutConflictReason =
  (typeof CheckoutConflictReason)[keyof typeof CheckoutConflictReason];
