import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when merge cannot proceed due to uncommitted changes.
 *
 * Based on JGit's CheckoutConflictException.
 */
export class MergeConflictError extends GitApiError {
  readonly conflicts: string[];

  constructor(conflicts: string[] = [], message?: string) {
    super(message ?? `Merge conflicts in ${conflicts.length} file(s)`);
    this.name = "MergeConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Thrown when no merge heads are specified.
 *
 * Based on JGit's InvalidMergeHeadsException.
 */
export class InvalidMergeHeadsError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "No merge heads specified");
    this.name = "InvalidMergeHeadsError";
  }
}

/**
 * Thrown when fast-forward merge is requested but not possible.
 *
 * Based on JGit's merge behavior with FF_ONLY mode.
 */
export class NotFastForwardError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Cannot fast-forward merge; branches have diverged");
    this.name = "NotFastForwardError";
  }
}

/**
 * Thrown when cherry-picking/reverting a merge commit without specifying parent.
 *
 * Based on JGit's MultipleParentsNotAllowedException.
 */
export class MultipleParentsNotAllowedError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Cannot cherry-pick merge commit without specifying mainline parent");
    this.name = "MultipleParentsNotAllowedError";
  }
}

/**
 * Failure reasons for merge operations.
 *
 * Based on JGit's ResolveMerger.MergeFailureReason.
 */
export enum MergeFailureReason {
  /** Could not delete existing file on disk */
  COULD_NOT_DELETE = "could-not-delete",
  /** Working tree file was dirty (uncommitted changes) */
  DIRTY_WORKTREE = "dirty-worktree",
  /** Index had uncommitted changes */
  DIRTY_INDEX = "dirty-index",
}

/**
 * Thrown when no merge base can be found between commits.
 */
export class NoMergeBaseError extends GitApiError {
  readonly commits: string[];

  constructor(commits: string[] = [], message?: string) {
    super(message ?? "No merge base found");
    this.name = "NoMergeBaseError";
    this.commits = commits;
  }
}

/**
 * Thrown when mainline parent is invalid for cherry-pick or revert.
 */
export class InvalidMainlineParentError extends GitApiError {
  readonly parent: number;
  readonly maxParents: number;

  constructor(parent: number, maxParents: number, message?: string) {
    super(message ?? `Invalid mainline parent: ${parent} (commit has ${maxParents} parent(s))`);
    this.name = "InvalidMainlineParentError";
    this.parent = parent;
    this.maxParents = maxParents;
  }
}
