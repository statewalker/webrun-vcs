/**
 * Repository operation state enumeration.
 *
 * Tracks in-progress operations that affect what actions are allowed.
 * Use with `getStateCapabilities()` to determine allowed operations.
 *
 * Based on JGit's RepositoryState enum from lib/RepositoryState.java.
 *
 * @example Detecting repository state
 * ```typescript
 * import { RepositoryState, getStateCapabilities } from "@statewalker/vcs-working-tree";
 *
 * const state = await workingCopy.getState();
 *
 * if (state === RepositoryState.MERGING) {
 *   console.log("Merge in progress - resolve conflicts");
 * }
 *
 * const caps = getStateCapabilities(state);
 * if (!caps.canCommit) {
 *   console.log("Cannot commit in current state");
 * }
 * ```
 *
 * @example State-aware UI
 * ```typescript
 * switch (state) {
 *   case RepositoryState.SAFE:
 *     showNormalUI();
 *     break;
 *   case RepositoryState.MERGING:
 *   case RepositoryState.MERGING_RESOLVED:
 *     showMergeUI();
 *     break;
 *   case RepositoryState.REBASING:
 *   case RepositoryState.REBASING_MERGE:
 *   case RepositoryState.REBASING_INTERACTIVE:
 *     showRebaseUI();
 *     break;
 * }
 * ```
 */
export const RepositoryState = {
  /**
   * Bare repository with no working tree.
   * No checkout, commit, or worktree operations are possible.
   */
  BARE: "bare",

  /**
   * Normal safe state - all operations allowed.
   * This is the default state for a repository with no in-progress operations.
   */
  SAFE: "safe",

  /**
   * Merge in progress with unresolved conflicts.
   * User must resolve conflicts before committing. Can abort with reset.
   * Detected by presence of .git/MERGE_HEAD file.
   */
  MERGING: "merging",

  /**
   * Merge resolved and ready to commit.
   * All conflicts have been resolved. Commit to complete the merge.
   */
  MERGING_RESOLVED: "merging-resolved",

  /**
   * Cherry-pick in progress with unresolved conflicts.
   * User must resolve conflicts before continuing. Can abort with reset.
   * Detected by presence of .git/CHERRY_PICK_HEAD file.
   */
  CHERRY_PICKING: "cherry-picking",

  /**
   * Cherry-pick resolved and ready to commit.
   * All conflicts have been resolved. Commit to complete the cherry-pick.
   */
  CHERRY_PICKING_RESOLVED: "cherry-picking-resolved",

  /**
   * Revert in progress with unresolved conflicts.
   * User must resolve conflicts before continuing. Can abort with reset.
   * Detected by presence of .git/REVERT_HEAD file.
   */
  REVERTING: "reverting",

  /**
   * Revert resolved and ready to commit.
   * All conflicts have been resolved. Commit to complete the revert.
   */
  REVERTING_RESOLVED: "reverting-resolved",

  /**
   * Rebase in progress using git-am style (patch-based).
   * Detected by presence of .git/rebase-apply directory.
   * Use `git rebase --continue/--skip/--abort` to proceed.
   */
  REBASING: "rebasing",

  /**
   * Rebase in progress using merge strategy.
   * Detected by presence of .git/rebase-merge directory.
   * Use `git rebase --continue/--skip/--abort` to proceed.
   */
  REBASING_MERGE: "rebasing-merge",

  /**
   * Interactive rebase in progress.
   * Similar to REBASING_MERGE but with .git/rebase-merge/interactive marker.
   * Use `git rebase --continue/--skip/--abort` to proceed.
   */
  REBASING_INTERACTIVE: "rebasing-interactive",

  /**
   * Git am (apply mailbox) in progress.
   * Applying patches from a mailbox. Similar to rebase-apply.
   * Use `git am --continue/--skip/--abort` to proceed.
   */
  APPLY: "apply",

  /**
   * Git bisect in progress.
   * Binary search for a bug. Checkout is allowed for testing commits.
   * Detected by presence of .git/BISECT_LOG file.
   * Use `git bisect good/bad/reset` to proceed.
   */
  BISECTING: "bisecting",
} as const;

/**
 * Type representing any valid repository state value.
 * Use this type for variables that hold a repository state.
 *
 * @example
 * ```typescript
 * function handleState(state: RepositoryStateValue) {
 *   if (state === RepositoryState.SAFE) {
 *     // Normal operations
 *   }
 * }
 * ```
 */
export type RepositoryStateValue = (typeof RepositoryState)[keyof typeof RepositoryState];

/**
 * Capability queries for repository state.
 *
 * Determines what operations are allowed in the current state.
 * Obtain via `getStateCapabilities(state)` or `workingCopy.getStateCapabilities()`.
 *
 * @example Checking capabilities before operations
 * ```typescript
 * const caps = await workingCopy.getStateCapabilities();
 *
 * if (caps.canCheckout) {
 *   await git.checkout().setName("feature").call();
 * } else {
 *   console.log("Complete or abort current operation first");
 * }
 *
 * if (caps.isRebasing) {
 *   showRebaseToolbar(); // Continue, Skip, Abort buttons
 * }
 * ```
 */
export interface StateCapabilities {
  /**
   * Whether checkout to another branch/commit is allowed.
   *
   * True in: SAFE, BISECTING
   * False in: All conflict/in-progress states
   */
  readonly canCheckout: boolean;

  /**
   * Whether creating new commits is allowed.
   *
   * True in: SAFE, MERGING_RESOLVED, CHERRY_PICKING_RESOLVED, REVERTING_RESOLVED
   * False in: Conflict states, rebase states, bare repos
   */
  readonly canCommit: boolean;

  /**
   * Whether HEAD can be reset (e.g., to abort an operation).
   *
   * True in: SAFE, MERGING, MERGING_RESOLVED, CHERRY_PICKING, REVERTING states
   * False in: REBASING states, APPLY, BISECTING, BARE
   */
  readonly canResetHead: boolean;

  /**
   * Whether the last commit can be amended.
   *
   * True in: SAFE, REBASING states, APPLY
   * False in: Merge/cherry-pick/revert states (would corrupt history)
   */
  readonly canAmend: boolean;

  /**
   * Whether a rebase operation is currently in progress.
   *
   * True in: REBASING, REBASING_MERGE, REBASING_INTERACTIVE
   * Used to show rebase-specific UI (continue/skip/abort).
   */
  readonly isRebasing: boolean;
}

/**
 * Get capabilities for a repository state.
 *
 * Determines what operations are allowed based on the current state.
 * Logic follows JGit's RepositoryState capability methods.
 *
 * @param state The repository state to query
 * @returns Capabilities object indicating allowed operations
 */
export function getStateCapabilities(state: RepositoryStateValue): StateCapabilities {
  switch (state) {
    case RepositoryState.BARE:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: false,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.SAFE:
      return {
        canCheckout: true,
        canCommit: true,
        canResetHead: true,
        canAmend: true,
        isRebasing: false,
      };

    case RepositoryState.MERGING:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.MERGING_RESOLVED:
      return {
        canCheckout: false,
        canCommit: true,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.CHERRY_PICKING:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.CHERRY_PICKING_RESOLVED:
      return {
        canCheckout: false,
        canCommit: true,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.REVERTING:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.REVERTING_RESOLVED:
      return {
        canCheckout: false,
        canCommit: true,
        canResetHead: true,
        canAmend: false,
        isRebasing: false,
      };

    case RepositoryState.REBASING:
    case RepositoryState.REBASING_MERGE:
    case RepositoryState.REBASING_INTERACTIVE:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: false,
        canAmend: true,
        isRebasing: true,
      };

    case RepositoryState.APPLY:
      return {
        canCheckout: false,
        canCommit: false,
        canResetHead: false,
        canAmend: true,
        isRebasing: false,
      };

    case RepositoryState.BISECTING:
      return {
        canCheckout: true,
        canCommit: false,
        canResetHead: false,
        canAmend: false,
        isRebasing: false,
      };

    default: {
      const _exhaustive: never = state;
      throw new Error(`Unknown repository state: ${_exhaustive}`);
    }
  }
}
