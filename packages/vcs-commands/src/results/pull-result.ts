import type { FetchResult } from "./fetch-result.js";
import type { MergeResult } from "./merge-result.js";

/**
 * Result of a pull operation.
 *
 * Based on JGit's PullResult.
 */
export interface PullResult {
  /** Result of the fetch phase */
  fetchResult: FetchResult;
  /** Result of the merge phase (if applicable) */
  mergeResult?: MergeResult;
  /** Whether rebase was used instead of merge */
  rebaseUsed: boolean;
  /** Whether pull was successful */
  successful: boolean;
  /** Fetch-from remote */
  fetchedFrom: string;
}

/**
 * Check if pull result was successful.
 */
export function isPullSuccessful(result: PullResult): boolean {
  return result.successful;
}
