import type { CloneResult } from "../results/index.js";
import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a path is not found in the index during checkout.
 */
export class PathNotInIndexError extends GitApiError {
  readonly path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Path not in index: ${path}`, { exitCode: 1 });
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
    super(message ?? `Path not found in tree: ${path}`, { exitCode: 1 });
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

/**
 * Thrown when a clone's destination is not empty (git: "destination path '<dir>' already
 * exists and is not an empty directory.", exit 128): nothing is written.
 */
export class CloneDestinationError extends GitApiError {
  constructor(message: string) {
    super(message);
    this.name = "CloneDestinationError";
  }
}

/**
 * Thrown when `git switch` refuses before anything changes, with git's message: a name
 * that is not a branch (`fatal: a branch is expected, got commit '...'` and its hint), an
 * operation in progress, a branch `-c` would create that exists, options that do not go
 * together.
 */
export class SwitchRefusedError extends GitApiError {
  constructor(message: string) {
    super(message, { defaultExitCode: 1 });
    this.name = "SwitchRefusedError";
  }
}

/**
 * Thrown when a tree would put a path git's `verify_path` refuses into the index or the
 * worktree (`.git` under any spelling `core.protectNTFS`/`core.protectHFS` cover, `..`, an
 * empty or absolute component, a symlinked `.gitmodules`): git's `error: invalid path
 * '<path>'`, given before anything is written. Commands that die there add their own lines
 * (`reset --hard`'s `fatal: Could not reset index file to revision '<rev>'.`).
 */
export class InvalidPathError extends GitApiError {
  /** The path refused, as git names it (the entry's full path) */
  readonly path: string;

  constructor(path: string, message?: string, exitCode?: number) {
    super(message ?? `error: invalid path '${path}'`, exitCode === undefined ? {} : { exitCode });
    this.name = "InvalidPathError";
    this.path = path;
  }
}

/**
 * Thrown when a tree holds an entry with an empty name: git dies reading it
 * (`decode_tree_entry`: `fatal: empty filename in tree entry`, exit 128).
 */
export class EmptyTreeEntryNameError extends GitApiError {
  constructor() {
    super("fatal: empty filename in tree entry");
    this.name = "EmptyTreeEntryNameError";
  }
}
