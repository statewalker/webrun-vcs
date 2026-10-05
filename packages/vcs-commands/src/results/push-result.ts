import type { ObjectId } from "@statewalker/vcs-core";

/**
 * Status of a ref update during push.
 *
 * Based on JGit's RemoteRefUpdate.Status.
 */
export enum PushStatus {
  /** Update was performed successfully */
  OK = "ok",
  /** Update was rejected (not fast-forward) */
  REJECTED_NONFASTFORWARD = "rejected-nonfastforward",
  /** Update was rejected (other reason) */
  REJECTED_OTHER = "rejected-other",
  /** Update failed (remote error) */
  FAILED = "failed",
  /** Update not attempted (nothing to push) */
  NOT_ATTEMPTED = "not-attempted",
  /** Update already up to date */
  UP_TO_DATE = "up-to-date",
  /** Waiting for other updates to complete (atomic push) */
  AWAITING_REPORT = "awaiting-report",
}

/**
 * Result of updating a single ref during push.
 *
 * Based on JGit's RemoteRefUpdate.
 */
export interface RemoteRefUpdate {
  /** Local ref name that was pushed */
  srcRef?: string;
  /** Remote ref name that was updated */
  remoteName: string;
  /** Expected old object ID (for compare-and-swap) */
  expectedOldObjectId?: ObjectId;
  /** New object ID that was pushed */
  newObjectId: ObjectId;
  /** Status of the update */
  status: PushStatus;
  /** Message from server (if any) */
  message?: string;
  /** Whether this was a forced update */
  forceUpdate: boolean;
  /** Whether this was a delete operation */
  delete: boolean;
}

/**
 * Result of a push operation.
 *
 * Based on JGit's PushResult.
 */
export interface PushResult {
  /** URI of the remote that was pushed to */
  uri: string;
  /** Results for each ref update */
  remoteUpdates: RemoteRefUpdate[];
  /** Total bytes sent */
  bytesSent: number;
  /** Number of objects sent */
  objectCount: number;
  /** Server messages */
  messages: string[];
}

/**
 * Check if all updates in push result were successful.
 */
export function isPushSuccessful(result: PushResult): boolean {
  return result.remoteUpdates.every(
    (u) => u.status === PushStatus.OK || u.status === PushStatus.UP_TO_DATE,
  );
}

/**
 * Get failed updates from push result.
 */
export function getFailedUpdates(result: PushResult): RemoteRefUpdate[] {
  return result.remoteUpdates.filter(
    (u) =>
      u.status !== PushStatus.OK &&
      u.status !== PushStatus.UP_TO_DATE &&
      u.status !== PushStatus.NOT_ATTEMPTED,
  );
}
