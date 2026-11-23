import type { FetchResult } from "./fetch-result.js";
import type { MergeResult } from "./merge-result.js";
import type { RebaseResult } from "./rebase-result.js";

/**
 * Result of a pull operation.
 *
 * Based on JGit's PullResult.
 */
export interface PullResult {
  /**
   * Result of the fetch phase; undefined when a rebasing pull refused a dirty tree before
   * fetching (`rebaseResult` then holds git's refusal, `UNCOMMITTED_CHANGES`)
   */
  fetchResult?: FetchResult;
  /** Result of the merge phase (if applicable; also the fast-forward of a rebasing pull) */
  mergeResult?: MergeResult;
  /**
   * The rebase's result (`git pull --rebase`, or pull.rebase); a pull that only
   * fast-forwards reports `FAST_FORWARD` here (git runs `merge --ff-only` for it)
   */
  rebaseResult?: RebaseResult;
  /** Whether rebase was used instead of merge */
  rebaseUsed: boolean;
  /** Whether pull was successful */
  successful: boolean;
  /** Fetch-from remote */
  fetchedFrom: string;
  /**
   * git's warnings, one message each: pull.c's `fetch updated the current branch head.`
   * when the fetch moved the checked-out branch (a branches remote named after it)
   */
  warnings?: string[];
}

/**
 * Check if pull result was successful.
 */
export function isPullSuccessful(result: PullResult): boolean {
  return result.successful;
}
