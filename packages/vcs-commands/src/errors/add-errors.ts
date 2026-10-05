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
