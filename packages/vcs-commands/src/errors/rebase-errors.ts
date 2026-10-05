import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a rebase operation is attempted but no rebase is in progress.
 */
export class NoRebaseInProgressError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "No rebase in progress");
    this.name = "NoRebaseInProgressError";
  }
}

/**
 * Thrown when the upstream commit is required but not set.
 */
export class UpstreamRequiredError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "Upstream commit is required for rebase");
    this.name = "UpstreamRequiredError";
  }
}

/**
 * Thrown when a commit cannot be found during rebase.
 */
export class CommitNotFoundError extends GitApiError {
  readonly commitRef: string;

  constructor(commitRef: string, message?: string) {
    super(message ?? `Cannot find commit: ${commitRef}`);
    this.name = "CommitNotFoundError";
    this.commitRef = commitRef;
  }
}
