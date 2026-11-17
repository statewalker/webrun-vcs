import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a ref name is invalid.
 *
 * Based on JGit's InvalidRefNameException.
 */
export class InvalidRefNameError extends GitApiError {
  readonly refName: string;

  constructor(refName: string, message?: string) {
    super(message ?? `Invalid ref name: ${refName}`);
    this.name = "InvalidRefNameError";
    this.refName = refName;
  }
}

/**
 * Thrown when a ref already exists and force is not set.
 *
 * Based on JGit's RefAlreadyExistsException.
 */
export class RefAlreadyExistsError extends GitApiError {
  readonly refName: string;

  constructor(refName: string, message?: string) {
    super(message ?? `Ref already exists: ${refName}`);
    this.name = "RefAlreadyExistsError";
    this.refName = refName;
  }
}

/**
 * Thrown when a ref cannot be found.
 *
 * Based on JGit's RefNotFoundException.
 */
export class RefNotFoundError extends GitApiError {
  readonly refName: string;

  constructor(refName: string, message?: string) {
    super(message ?? `Ref not found: ${refName}`);
    this.name = "RefNotFoundError";
    this.refName = refName;
  }
}

/**
 * Thrown where git dies while interpreting a revision, its message git's `fatal:` line:
 * `@{upstream}` of a branch without one (`fatal: no upstream configured for branch 'x'`),
 * `@{u}` on a detached HEAD (`fatal: HEAD does not point to a branch`), `@{push}` that has
 * no destination, `<ref>@{<n>}` beyond the reflog (`fatal: log for 'x' only has 2 entries`).
 * Unlike {@link RefNotFoundError}, no command takes it for "not a revision".
 */
export class RevisionError extends GitApiError {
  readonly revision: string;

  constructor(revision: string, message: string) {
    super(message);
    this.name = "RevisionError";
    this.revision = revision;
  }
}

/**
 * Thrown when trying to delete the current branch.
 *
 * Based on JGit's CannotDeleteCurrentBranchException.
 */
export class CannotDeleteCurrentBranchError extends GitApiError {
  readonly branchName: string;

  constructor(branchName: string, message?: string) {
    super(message ?? `Cannot delete the branch you are currently on: ${branchName}`);
    this.name = "CannotDeleteCurrentBranchError";
    this.branchName = branchName;
  }
}

/**
 * Thrown when HEAD is detached and an operation requires a branch.
 *
 * Based on JGit's DetachedHeadException.
 */
export class DetachedHeadError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "HEAD is detached");
    this.name = "DetachedHeadError";
  }
}

/**
 * Thrown when HEAD ref cannot be found or resolved.
 *
 * Based on JGit's NoHeadException.
 */
export class NoHeadError extends GitApiError {
  constructor(message?: string) {
    super(message ?? "No HEAD ref found");
    this.name = "NoHeadError";
  }
}

/**
 * Thrown when branch has not been fully merged.
 *
 * Based on JGit's NotMergedException.
 */
export class NotMergedError extends GitApiError {
  readonly branchName: string;

  constructor(branchName: string, message?: string) {
    super(message ?? `Branch '${branchName}' is not fully merged`);
    this.name = "NotMergedError";
    this.branchName = branchName;
  }
}
