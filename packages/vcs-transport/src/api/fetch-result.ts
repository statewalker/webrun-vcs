/**
 * Common result types for fetch operations.
 */

import type { FetchClientResult } from "../fetch-client/index.js";

/**
 * Result of a fetch over a duplex (`fetchOverDuplex`), which reports failures instead of
 * throwing them.
 */
export interface FetchResult {
  /** Whether the fetch completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Local refs that hold the fetched values (written, or already up to date), name to id */
  updatedRefs?: Map<string, string>;
  /** Number of objects imported */
  objectsImported?: number;
  /** The whole report of a successful fetch: ref statuses, shallow change, counters */
  report?: FetchClientResult;
}

/**
 * Result of a serve operation.
 */
export interface ServeResult {
  /** Whether the serve completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Number of objects sent */
  objectsSent?: number;
}
