import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Result of a ref update during fetch.
 *
 * Based on JGit's TrackingRefUpdate.
 */
export interface TrackingRefUpdate {
  /** Local ref name that was updated */
  localRef: string;
  /** Remote ref name this tracks */
  remoteRef: string;
  /** Old object ID (before update) */
  oldObjectId?: ObjectId;
  /** New object ID (after update) */
  newObjectId: ObjectId;
  /** Update result status */
  status: RefUpdateStatus;
  /**
   * How git prints the update: `[new branch]`, `[new tag]`, `abc1234..def5678` (fast-forward),
   * `+ abc1234...def5678` (forced), `[rejected]`, `[up to date]`
   */
  summary?: string;
  /** Why a ref was rejected (`non-fast-forward`, `would clobber existing tag`, a lock failure) */
  reason?: string;
}

/**
 * Status of a ref update.
 *
 * Based on JGit's RefUpdate.Result.
 */
export enum RefUpdateStatus {
  /** Update was performed successfully */
  NEW = "new",
  /** Update was a fast-forward */
  FAST_FORWARD = "fast-forward",
  /** Update was forced (non-fast-forward) */
  FORCED = "forced",
  /** No update needed (already up to date) */
  NO_CHANGE = "no-change",
  /** Update rejected (non-fast-forward without force) */
  REJECTED = "rejected",
  /** Update rejected (ref is locked) */
  LOCK_FAILURE = "lock-failure",
  /** Ref was deleted */
  DELETED = "deleted",
  /** Update renamed the ref */
  RENAMED = "renamed",
}

/**
 * Result of a fetch operation.
 *
 * Based on JGit's FetchResult.
 */
export interface FetchResult {
  /** URI of the remote that was fetched from */
  uri: string;
  /** Refs advertised by the remote */
  advertisedRefs: Map<string, ObjectId>;
  /** Tracking ref updates that were performed */
  trackingRefUpdates: TrackingRefUpdate[];
  /**
   * Default branch of the remote, exactly as advertised: the target of the
   * `symref=HEAD:` capability, so a fully qualified `refs/heads/<name>` from
   * any remote that qualifies it. Deliberately not normalised — see
   * {@link CloneResult.defaultBranch} for the bare branch name.
   */
  defaultBranch?: string;
  /** Total bytes received */
  bytesReceived: number;
  /** Whether the remote repository was empty */
  isEmpty: boolean;
  /**
   * Messages as git prints them: the `followRemoteHEAD=warn` warning and its hint lines,
   * the symbolic refs a prune left dangling
   */
  messages: string[];
  /**
   * The ref lines git prints on stderr (`From <url>`, ` * [new branch]  main -> origin/main`,
   * `   1a2b3c4..5d6e7f8  dev  -> origin/dev`, ` - [deleted]  (none) -> origin/gone`), ids
   * abbreviated as git's find_unique_abbrev under `core.abbrev`, the columns as wide as git
   * makes them; empty when no ref changed
   */
  display?: string[];
  /**
   * What failed without stopping the fetch (a refused prune), where git reports an error
   * and exits 1; absent when nothing failed
   */
  errors?: string[];
  /** Submodule fetch results (if any) */
  submodules?: Map<string, FetchResult>;
  /**
   * The layer hashes of the commit-graph chain the fetch wrote (`fetch.writeCommitGraph`,
   * `--write-commit-graph`), base first; absent when it wrote none
   */
  commitGraph?: string[];
}

/**
 * Check if fetch result has any updates.
 */
export function hasUpdates(result: FetchResult): boolean {
  return result.trackingRefUpdates.some((u) => u.status !== RefUpdateStatus.NO_CHANGE);
}

/**
 * Get successful updates from fetch result.
 */
export function getSuccessfulUpdates(result: FetchResult): TrackingRefUpdate[] {
  return result.trackingRefUpdates.filter(
    (u) =>
      u.status === RefUpdateStatus.NEW ||
      u.status === RefUpdateStatus.FAST_FORWARD ||
      u.status === RefUpdateStatus.FORCED,
  );
}
