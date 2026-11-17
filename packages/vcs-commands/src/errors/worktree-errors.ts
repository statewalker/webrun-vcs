import { GitApiError } from "./git-api-error.js";

/**
 * Thrown by a `git worktree` command on a working copy whose backend keeps no linked
 * worktrees (`WorkingCopy.worktrees` is undefined).
 */
export class WorktreesUnsupportedError extends GitApiError {
  constructor(operation: string) {
    super(`worktree ${operation}: this repository's storage has no linked worktrees`);
    this.name = "WorktreesUnsupportedError";
  }
}

/**
 * A `git worktree` command refused: the message is git's (what follows `fatal: `).
 *
 * @example
 * ```typescript
 * try {
 *   await git.worktreeLock().setWorktree("wt").call();
 * } catch (e) {
 *   if (e instanceof WorktreeError) console.error(`fatal: ${e.message}`);
 * }
 * ```
 */
export class WorktreeError extends GitApiError {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * A branch is checked out (or being rebased or bisected) in a worktree, so it cannot be
 * deleted, force-updated or checked out again. The message is git's.
 */
export class BranchUsedByWorktreeError extends GitApiError {
  /** The branch name (without `refs/heads/`). */
  readonly branchName: string;
  /** The worktree that uses it, as git prints its path. */
  readonly worktreePath: string;

  constructor(branchName: string, worktreePath: string, message: string) {
    super(message);
    this.name = "BranchUsedByWorktreeError";
    this.branchName = branchName;
    this.worktreePath = worktreePath;
  }
}
