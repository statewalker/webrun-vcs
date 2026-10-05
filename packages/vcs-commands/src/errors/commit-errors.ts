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
