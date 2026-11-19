import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when commit message is missing.
 *
 * Based on JGit's NoMessageException.
 */
export class NoMessageError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Commit message is required");
    this.name = "NoMessageError";
  }
}

/**
 * Thrown when trying to create an empty commit without allow-empty.
 *
 * Based on JGit's EmptyCommitException.
 */
export class EmptyCommitError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Nothing to commit");
    this.name = "EmptyCommitError";
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
  /** git's exit code */
  readonly exitCode = 128;

  constructor(
    readonly lockPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IndexLockFailedError";
  }
}
