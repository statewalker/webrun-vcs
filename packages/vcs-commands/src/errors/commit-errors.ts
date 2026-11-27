import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when commit message is missing.
 *
 * Based on JGit's NoMessageException.
 */
export class NoMessageError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Commit message is required", { exitCode: 1 });
    this.name = "NoMessageError";
  }
}

/**
 * builtin/commit.c's `empty_amend_advice`: what `git commit --amend` prints on stderr when
 * the amended commit would have its first parent's tree (the same text in 2.43 and 2.5x).
 */
export const EMPTY_AMEND_ADVICE =
  "You asked to amend the most recent commit, but doing so would make\n" +
  "it empty. You can repeat your command with --allow-empty, or you can\n" +
  'remove the commit entirely with "git reset HEAD^".\n';

/**
 * Thrown when trying to create an empty commit without allow-empty.
 *
 * git's prepare_to_commit refuses it with exit status 1, printing the status of what would
 * be committed on stdout ({@link stdout}, `git commit --dry-run`'s text) and, when amending,
 * {@link EMPTY_AMEND_ADVICE} on stderr ({@link stderr}, also the message then).
 *
 * Based on JGit's EmptyCommitException.
 */
export class EmptyCommitError extends GitApiError {
  /** git's stdout: the status run_status prints before the refusal (when computed) */
  readonly stdout?: string;
  /** git's stderr: the amend advice, or nothing */
  readonly stderr: string;

  constructor(message?: string, output?: { stdout?: string; stderr?: string }) {
    super(message ?? (output?.stderr ? output.stderr.replace(/\n$/, "") : "Nothing to commit"), {
      exitCode: 1,
    });
    this.name = "EmptyCommitError";
    this.stdout = output?.stdout;
    this.stderr = output?.stderr ?? "";
  }
}

/**
 * Thrown when there are unmerged paths that prevent commit.
 *
 * Based on JGit's UnmergedPathsException (internal to commit).
 */
export class UnmergedPathsError extends GitApiError {
  readonly paths: string[];

  constructor(paths: string[] = [], message?: string) {
    super(message ?? "Cannot commit with unresolved conflicts");
    this.name = "UnmergedPathsError";
    this.paths = paths;
  }
}

/**
 * The index lock (`index.lock`) is held by another process: git dies with exit code 128
 * (`unable_to_lock_die`). The message is git's (`fatal: Unable to create '<path>': File
 * exists.` and its advice); the lock is left where it is.
 */
export class IndexLockFailedError extends GitApiError {
  constructor(
    readonly lockPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IndexLockFailedError";
  }
}
