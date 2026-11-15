import type { CloneResult } from "../results/index.js";
import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a path is not found in the index during checkout.
 */
export class PathNotInIndexError extends GitApiError {
  readonly path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Path not in index: ${path}`);
    this.name = "PathNotInIndexError";
    this.path = path;
  }
}

/**
 * Thrown when a path is not found in the tree during checkout.
 */
export class PathNotFoundInTreeError extends GitApiError {
  readonly path: string;
  readonly treeish?: string;

  constructor(path: string, treeish?: string, message?: string) {
    super(message ?? `Path not found in tree: ${path}`);
    this.name = "PathNotFoundInTreeError";
    this.path = path;
    this.treeish = treeish;
  }
}

/**
 * Thrown when a path is expected to be a directory but is not.
 */
export class NotADirectoryError extends GitApiError {
  readonly path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Not a directory: ${path}`);
    this.name = "NotADirectoryError";
    this.path = path;
  }
}

/**
 * Thrown when a clone fetched its objects and wrote its refs and configuration, but could
 * not check out the commit HEAD names (git: "Clone succeeded, but checkout failed").
 *
 * The repository is usable: `result` is what the clone returns, and the cause says
 * why the checkout failed. As with git, fixing the cause and checking out again (or a
 * `reset --hard`) completes the clone.
 */
export class CloneCheckoutError extends GitApiError {
  readonly result: CloneResult;

  constructor(result: CloneResult, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Clone succeeded, but checkout failed: ${reason}`, { cause });
    this.name = "CloneCheckoutError";
    this.result = result;
  }
}
