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

  /** `label <name>`: `refs/rewritten/<name>` set to HEAD (`--rebase-merges`) */
  LABEL = "label",

  /** `reset <label>`: HEAD and the worktree moved to a label (`--rebase-merges`) */
  RESET = "reset",

  /** `merge [-C <commit> | -c <commit>] <label> [# <oneline>]` (`--rebase-merges`) */
  MERGE = "merge",

  /** `exec <command>`: the command run by the exec handler (git runs it in a shell) */
  EXEC = "exec",

  /** `break`: the rebase stops here (`git rebase --continue` goes on) */
  BREAK = "break",

  /** `drop <commit>`: the commit left out */
  DROP = "drop",

  /** `noop`: nothing (the list of a rebase with nothing to pick) */
  NOOP = "noop",

  /** `update-ref <ref>`: the ref moved to HEAD at the end of the rebase (`--update-refs`) */
  UPDATE_REF = "update-ref",
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

  /**
   * The argument of a command without a commit (`exec <command>`, `label <name>`,
   * `reset <label>`, `update-ref <ref>`); `commit` is then empty
   */
  argument?: string;

  /** `fixup -C` (`"C"`) or `fixup -c` (`"c"`) */
  fixupFlag?: "C" | "c";
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
  /** The error printed on stderr for a refusal, or for a stop at a conflict (with hints) */
  readonly message?: string;
  /** What is printed on stdout: merge-ort's `Auto-merging f`, `CONFLICT (...)` lines */
  readonly output?: string[];

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
