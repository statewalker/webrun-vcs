import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a tag name is invalid.
 *
 * Based on JGit's InvalidTagNameException.
 */
export class InvalidTagNameError extends GitApiError {
  readonly tagName: string;

  constructor(tagName: string, message?: string) {
    super(message ?? `Invalid tag name: ${tagName}`);
    this.name = "InvalidTagNameError";
    this.tagName = tagName;
  }
}
