/**
 * Errors for AddCommand operations.
 *
 * Based on JGit's add-related exception classes.
 */

import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when AddCommand is called without file patterns
 * and not in update or all mode.
 *
 * Equivalent to JGit's NoFilepatternException.
 */
export class NoFilepatternError extends GitApiError {
  constructor(message = "At least one file pattern is required") {
    super(message);
    this.name = "NoFilepatternError";
  }
}

/**
 * Thrown when `git add` fails on paths it cannot add, with git's messages as the error's
 * message (its standard error, line by line).
 *
 * - With {@link result}, the index was written (git's exit status 1): the pathspec named
 *   ignored files (`ignoredPaths`, "The following paths are ignored by one of your
 *   .gitignore files"), or `--ignore-errors` let the other paths through (`failedPaths`).
 * - Without, nothing was written (git's exit status 128): "fatal: adding files failed" or
 *   "fatal: updating files failed" after a path that cannot be added (a nested repository
 *   without a commit checked out).
 *
 * @example
 * ```typescript
 * try {
 *   await git.add().addFilepattern("build/out.o").call();
 * } catch (error) {
 *   if (error instanceof AddFailedError) console.log(error.ignoredPaths, error.result?.added);
 * }
 * ```
 */
export class AddFailedError<R = unknown> extends GitApiError {
  constructor(
    message: string,
    /** The paths git reports as ignored (exit status 1) */
    readonly ignoredPaths: readonly string[] = [],
    /** The paths that could not be added */
    readonly failedPaths: readonly string[] = [],
    /** What was added: present when the index was written all the same */
    readonly result?: R,
    /**
     * What git printed on its standard output before it failed (`--dry-run`, `--verbose`:
     * `add '<path>'`, `remove '<path>'`), also when nothing was written
     */
    readonly output: readonly string[] = [],
    /**
     * The warnings git printed on its standard error before it failed (an embedded
     * repository added, line endings converted), also when nothing was written
     */
    readonly warnings: readonly string[] = [],
  ) {
    super(message);
    this.name = "AddFailedError";
  }
}
