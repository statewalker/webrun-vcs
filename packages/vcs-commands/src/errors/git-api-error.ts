/**
 * Base exception for all Git API errors.
 *
 * Based on JGit's GitAPIException hierarchy.
 */
export class GitApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitApiError";
  }
}
