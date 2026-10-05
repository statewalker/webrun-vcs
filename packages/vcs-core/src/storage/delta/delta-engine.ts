/**
 * DeltaEngine interface - Orchestrate delta compression
 *
 * Combines DeltaCompressor, CandidateFinder, and DeltaDecisionStrategy
 * to provide high-level delta compression operations.
 *
 * The DeltaEngine:
 * 1. Decides if delta should be attempted (strategy)
 * 2. Finds candidate bases (finder)
 * 3. Computes deltas (compressor)
 * 4. Selects the best delta (strategy)
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type { DeltaTarget } from "./candidate-finder.js";

/**
 * Best delta found for a target object
 */
export interface BestDeltaResult {
  /** Base object ID */
  baseId: ObjectId;
  /** Computed delta bytes */
  delta: Uint8Array;
  /** Compression ratio achieved */
  ratio: number;
  /** Bytes saved vs storing full object */
  savings: number;
  /** Delta chain depth (including this delta) */
  chainDepth: number;
}

/**
 * Result of processing a single target
 */
export interface DeltaProcessResult {
  /** Target object ID */
  targetId: ObjectId;
  /** Best delta found, or null if no good delta */
  result: BestDeltaResult | null;
}

/**
 * Loads object content by ID
 *
 * Abstraction for loading objects during delta computation.
 * Allows DeltaEngine to work with any storage backend.
 */
export interface ObjectLoader {
  /**
   * Load object content
   *
   * @param id Object ID
   * @returns Object content bytes
   * @throws Error if object not found
   */
  load(id: ObjectId): Promise<Uint8Array>;

  /**
   * Get current delta chain depth for an object
   *
   * @param id Object ID
   * @returns Chain depth (0 = full object, not found)
   */
  getChainDepth(id: ObjectId): Promise<number>;
}

/**
 * DeltaEngine interface
 *
 * High-level delta compression operations.
 * Orchestrates candidate finding, delta computation, and decision making.
 */
export interface DeltaEngine {
  /**
   * Find the best delta for a target object
   *
   * Searches candidates, computes deltas, and returns the best one.
   * Returns null if:
   * - Strategy decides not to attempt deltification
   * - No candidates found
   * - No computed delta meets the strategy's threshold
   *
   * @param target Target object info
   * @returns Best delta result or null
   */
  findBestDelta(target: DeltaTarget): Promise<BestDeltaResult | null>;

  /**
   * Process multiple objects, finding deltas where beneficial
   *
   * Batch processing with streaming results.
   * Each result indicates whether a delta was found.
   *
   * @param targets Async iterable of target objects
   * @returns Async iterable of results
   */
  processBatch(targets: AsyncIterable<DeltaTarget>): AsyncIterable<DeltaProcessResult>;
}

/**
 * Configuration for creating a DeltaEngine
 */
export interface DeltaEngineConfig {
  /** Window size for candidate search (default: 10) */
  windowSize?: number;
  /** Maximum candidates to evaluate per target (default: 10) */
  maxCandidatesPerTarget?: number;
  /** Skip targets larger than this size (default: 16MB) */
  maxTargetSize?: number;
}
