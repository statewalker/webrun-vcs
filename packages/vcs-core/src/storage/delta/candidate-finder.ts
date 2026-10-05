/**
 * CandidateFinder interface - Find delta base candidates
 *
 * Finds good delta base candidates for a target object.
 * Different implementations use different strategies:
 * - Path-based: Same file path, different versions
 * - Size-based: Similar sizes suggest similar content
 * - Content-based: Rolling hash fingerprints
 * - Commit-tree: Parent commits, same-tree objects
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type { ObjectTypeCode } from "../../history/objects/object-types.js";

/**
 * Target object for delta compression
 */
export interface DeltaTarget {
  /** Object ID */
  id: ObjectId;
  /** Object type */
  type: ObjectTypeCode;
  /** Object size in bytes */
  size: number;
  /** File path where object appears (for path-based similarity) */
  path?: string;
  /** Object content (if already loaded) */
  content?: Uint8Array;
}

/**
 * Why this object was selected as a candidate
 */
export type CandidateReason =
  | "same-path" // Same file path, different version
  | "similar-size" // Similar size suggests similar content
  | "same-tree" // In same tree (for tree objects)
  | "parent-commit" // Parent commit (for commit objects)
  | "rolling-hash" // Rolling hash match
  | "recent"; // Recently accessed (cache locality)

/**
 * A candidate base object for delta compression
 */
export interface DeltaCandidate {
  /** Object ID */
  id: ObjectId;
  /** Object type */
  type: ObjectTypeCode;
  /** Object size in bytes */
  size: number;
  /** Estimated similarity 0-1 (1 = identical) */
  similarity: number;
  /** Why this is a candidate */
  reason: CandidateReason;
}

/**
 * CandidateFinder interface
 *
 * Finds candidate base objects for delta compression.
 * Different implementations for different storage types and object types.
 */
export interface CandidateFinder {
  /**
   * Find candidate base objects for the given target
   *
   * Returns candidates ordered by likelihood of good delta
   * (highest similarity first).
   *
   * @param target Target object to find bases for
   * @returns Async iterable of candidates
   */
  findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate>;
}

/**
 * Configuration for limiting candidate search
 */
export interface CandidateFinderOptions {
  /** Maximum number of candidates to return */
  maxCandidates?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Object types to consider */
  allowedTypes?: ObjectTypeCode[];
}
