/**
 * Common result types for fetch operations.
 */

/**
 * Result of a high-level fetch operation (duplex or HTTP).
 */
export interface FetchResult {
  /** Whether the fetch completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Refs that were updated */
  updatedRefs?: Map<string, string>;
  /** Number of objects imported */
  objectsImported?: number;
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

/**
 * Raw fetch/clone result with pack data and binary OIDs.
 *
 * Shared interface for HTTP fetch and clone operations that return
 * low-level protocol data before it's imported into a repository.
 */
export interface RawFetchResult {
  /** Map of ref names to object IDs */
  refs: Map<string, Uint8Array>;
  /** Pack data received */
  packData: Uint8Array;
  /** Default branch name */
  defaultBranch?: string;
  /** Total bytes received */
  bytesReceived: number;
  /** Whether the remote repository is empty */
  isEmpty: boolean;
}
