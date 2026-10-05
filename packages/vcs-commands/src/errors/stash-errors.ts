import { GitApiError } from "./git-api-error.js";

/**
 * Thrown when a stash index is invalid.
 */
export class InvalidStashIndexError extends GitApiError {
  readonly index: number;

  constructor(index: number, message?: string) {
    super(message ?? `Invalid stash index: ${index}`);
    this.name = "InvalidStashIndexError";
    this.index = index;
  }
}

/**
 * Thrown when a stash reference cannot be found.
 */
export class StashNotFoundError extends GitApiError {
  readonly stashRef: string;

  constructor(stashRef: string, message?: string) {
    super(message ?? `Stash not found: ${stashRef}`);
    this.name = "StashNotFoundError";
    this.stashRef = stashRef;
  }
}

/**
 * Thrown when applying a stash fails due to conflicts or other issues.
 */
export class StashApplyFailedError extends GitApiError {
  readonly stashRef: string;
  readonly conflicts?: string[];

  constructor(stashRef: string, conflicts?: string[], message?: string) {
    super(message ?? `Failed to apply stash: ${stashRef}`);
    this.name = "StashApplyFailedError";
    this.stashRef = stashRef;
    this.conflicts = conflicts;
  }
}
