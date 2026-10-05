import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Status of a rebase operation.
 *
 * Based on JGit's RebaseResult.Status.
 */
export enum RebaseStatus {
  /**
   * Rebase was successful.
   */
  OK = "ok",

  /**
   * Fast-forward was performed (no actual rebase needed).
   */
  FAST_FORWARD = "fast-forward",

  /**
   * Already up-to-date (no rebase needed).
   */
  UP_TO_DATE = "up-to-date",

  /**
   * Rebase stopped due to conflict.
   */
  STOPPED = "stopped",

  /**
   * Rebase was aborted.
   */
  ABORTED = "aborted",

  /**
   * Rebase was aborted due to failure (not conflict).
   */
  FAILED = "failed",

  /**
   * Uncommitted changes prevented rebase from starting.
   */
  UNCOMMITTED_CHANGES = "uncommitted-changes",

  /**
   * Interactive rebase is prepared but not started.
   */
  INTERACTIVE_PREPARED = "interactive-prepared",

  /**
   * Continue was called but there was nothing to commit.
   */
  NOTHING_TO_COMMIT = "nothing-to-commit",

  /**
   * Stash apply failed after successful rebase.
   */
  STASH_APPLY_CONFLICTS = "stash-apply-conflicts",

  /**
   * Rebase stopped at edit step.
   */
  EDIT = "edit",
}

/**
 * Rebase todo line action.
 *
 * Based on JGit's RebaseTodoLine.Action.
 */
export enum RebaseAction {
  /** Pick the commit (apply it) */
  PICK = "pick",

  /** Reword: pick but edit commit message */
  REWORD = "reword",

  /** Edit: stop for amending */
  EDIT = "edit",

  /** Squash into previous commit (combine messages) */
  SQUASH = "squash",

  /** Fixup: squash but discard this commit's message */
  FIXUP = "fixup",

  /** Comment line (ignored) */
  COMMENT = "comment",
}

/**
 * A single line in the rebase todo list.
 *
 * Based on JGit's RebaseTodoLine.
 */
export interface RebaseTodoLine {
  /** The action to perform */
  action: RebaseAction;

  /** The commit ID (abbreviated) */
  commit: string;

  /** Short message of the commit */
  shortMessage: string;
}

/**
 * Result of a rebase operation.
 *
 * Based on JGit's RebaseResult.
 */
export interface RebaseResult {
  /** Status of the rebase */
  readonly status: RebaseStatus;

  /** New HEAD after successful rebase */
  readonly newHead?: ObjectId;

  /** Commit that caused the stop (for conflicts/edit) */
  readonly currentCommit?: ObjectId;

  /** List of conflicting paths */
  readonly conflicts?: string[];

  /** List of failing paths (not conflicts) */
  readonly failingPaths?: Map<string, string>;

  /** Uncommitted changes that prevented rebase */
  readonly uncommittedChanges?: string[];
}

/**
 * Check if rebase status indicates success.
 */
export function isRebaseSuccessful(status: RebaseStatus): boolean {
  return (
    status === RebaseStatus.OK ||
    status === RebaseStatus.FAST_FORWARD ||
    status === RebaseStatus.UP_TO_DATE
  );
}
