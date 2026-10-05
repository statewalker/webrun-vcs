/**
 * DeltaDecisionStrategy interface - Decide when to use delta compression
 *
 * Decides whether to attempt delta compression for an object
 * and whether a computed delta is good enough to use.
 *
 * Different strategies for different use cases:
 * - Storage optimization: Higher thresholds, accept only significant savings
 * - Pack generation: Lower thresholds, any savings helps
 * - Network transfer: Balance between compression time and bandwidth savings
 */

import type { ObjectTypeCode } from "../../history/objects/object-types.js";
import type { DeltaCandidate, DeltaTarget } from "./candidate-finder.js";
import type { DeltaResult } from "./delta-compressor.js";

/**
 * DeltaDecisionStrategy interface
 *
 * Decides whether to use delta compression for an object.
 */
export interface DeltaDecisionStrategy {
  /**
   * Should we attempt delta compression for this object?
   *
   * Called before searching for candidates. Returns false
   * to skip delta compression entirely (e.g., for tiny objects).
   *
   * @param target Target object info
   * @returns True if we should attempt delta compression
   */
  shouldAttemptDelta(target: DeltaTarget): boolean;

  /**
   * Is this delta result good enough to use?
   *
   * Called after computing a delta. Returns false if the delta
   * doesn't provide enough benefit to justify storing it.
   *
   * @param result Computed delta result
   * @param candidate The candidate base that produced this delta
   * @returns True if we should use this delta
   */
  shouldUseDelta(result: DeltaResult, candidate: DeltaCandidate): boolean;

  /**
   * Maximum delta chain depth allowed
   *
   * Prevents excessively deep chains which are slow to resolve.
   * Typical values: 10 (random access) to 50 (sequential access).
   */
  readonly maxChainDepth: number;
}

/**
 * Configuration options for DefaultDeltaDecisionStrategy
 */
export interface DeltaDecisionOptions {
  /** Minimum object size to consider for deltification (default: 64 bytes) */
  minObjectSize?: number;
  /** Maximum object size to deltify (default: 512 MB) */
  maxObjectSize?: number;
  /** Minimum compression ratio required (default: 1.5) */
  minCompressionRatio?: number;
  /** Minimum bytes saved required (default: 32) */
  minBytesSaved?: number;
  /** Maximum delta chain depth (default: 50) */
  maxChainDepth?: number;
  /** Object types allowed for deltification (default: all) */
  allowedTypes?: ObjectTypeCode[];
}
