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
  /** Messages from the remote */
  messages: string[];
  /** Submodule fetch results (if any) */
  submodules?: Map<string, FetchResult>;
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
