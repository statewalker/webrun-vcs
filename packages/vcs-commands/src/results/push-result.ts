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
  /** Update was rejected: the remote ref no longer has the leased value (`--force-with-lease`) */
  REJECTED_REMOTE_CHANGED = "rejected-remote-changed",
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
  /** Why the update was refused: the server's reason, or git's status column */
  message?: string;
  /**
   * git's status column (`[new branch]`, `abc1234..def5678`, `[rejected] (fetch first)`,
   * `[remote rejected] (hook declined)`, …)
   */
  summary?: string;
  /** Whether the update was allowed to be a non-fast-forward (`+`, setForce, a lease that held) */
  forceUpdate: boolean;
  /** Whether this was a delete operation */
  delete: boolean;
  /**
   * What the server reported doing instead (report-status-v2, from its proc-receive hook):
   * one entry per rewrite, `refName`/`oldObjectId`/`newObjectId` absent where the update's own
   * value stands (git prints a status line per entry and follows each with its
   * remote-tracking ref)
   */
  reports?: RemoteRefReport[];
}

/** One rewrite the server reported for a pushed ref. */
export interface RemoteRefReport {
  /** The ref the server changed (`option refname`) */
  refName?: string;
  /** Its value before (`option old-oid`) */
  oldObjectId?: ObjectId;
  /** Its value after (`option new-oid`) */
  newObjectId?: ObjectId;
  /** A forced update (`option forced-update`) */
  forcedUpdate?: boolean;
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
  /**
   * The report git prints on stderr (`To <url>`, ` * [new branch]  main -> main`,
   * `   1a2b3c4..5d6e7f8  main -> main`, ` ! [rejected]  main -> main (fetch first)`,
   * `Everything up-to-date`), ids abbreviated as git's find_unique_abbrev under
   * `core.abbrev`, the status column `transport_summary_width` wide
   */
  display?: string[];
  /**
   * What `git push --porcelain` prints on stdout: `To <url>`, a
   * `<flag>\t<from>:<to>\t<summary>` line per ref (and per server report), `Done`
   */
  porcelain?: string[];
  /**
   * git's error lines after the push (stderr): the remote-tracking refs it could not update,
   * as transport.c's update_one_tracking_ref reports them (`error: update_ref failed for ref
   * '<ref>': ...`); the push itself succeeded (git exits 0)
   */
  errors?: string[];
  /**
   * The push failed although every ref's status says otherwise: the server's report broke
   * git's rules (an `option` line without its `ok`; git exits 1, its porcelain output has no
   * `Done`)
   */
  failed?: boolean;
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
