/**
 * Common result types for push operations.
 */

import type { PushClientResult, PushRefStatus } from "../push-client/index.js";

/**
 * Result of a push over a duplex (`pushOverDuplex`), which reports failures instead of
 * throwing them.
 */
export interface PushResult {
  /** Whether every ref was pushed (or was up to date) */
  success: boolean;
  /** Error message if the push failed */
  error?: string;
  /** Each matched remote ref's verdict, by remote ref name */
  refStatus?: Map<string, RefPushStatus>;
  /** The whole report of a push that reached the server */
  report?: PushClientResult;
}

/**
 * Status of a single ref push.
 */
export interface RefPushStatus {
  /** Whether this ref was pushed, or up to date */
  success: boolean;
  /** git's status of the ref */
  status: PushRefStatus;
  /** Why it failed (the server's reason, or git's status column) */
  error?: string;
  /** The remote's value before the push (zero id: absent) */
  oldOid?: string;
  /** The value pushed (zero id: a delete) */
  newOid?: string;
}
