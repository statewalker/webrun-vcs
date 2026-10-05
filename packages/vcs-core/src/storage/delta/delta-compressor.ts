/**
 * DeltaCompressor interface - Pure delta computation algorithm
 *
 * Computes binary deltas between objects. This is a pure algorithm
 * interface with no storage awareness.
 *
 * Implementations may use different algorithms:
 * - Git's delta algorithm (copy/insert instructions)
 * - xdelta3
 * - Custom algorithms optimized for specific content types
 */

/**
 * Result of computing a delta between base and target
 */
export interface DeltaResult {
  /** Compressed delta bytes */
  delta: Uint8Array;
  /** Compression ratio: targetSize / delta.length (higher is better) */
  ratio: number;
  /** Bytes saved: targetSize - delta.length */
  savings: number;
  /** Size of the base object */
  baseSize: number;
  /** Size of the target object */
  targetSize: number;
}

/**
 * Quick estimate of delta quality
 *
 * Used to filter candidates before expensive delta computation.
 */
export interface DeltaEstimate {
  /** Should we attempt full delta computation? */
  worthTrying: boolean;
  /** Estimated compression ratio (may be inaccurate) */
  expectedRatio: number;
  /** Reason why not worth trying (when worthTrying is false) */
  reason?: string;
}

/**
 * DeltaCompressor interface
 *
 * Pure delta computation - no storage awareness.
 * Takes raw bytes in, produces delta bytes out.
 */
export interface DeltaCompressor {
  /**
   * Compute delta from base to target
   *
   * @param base Base object content
   * @param target Target object content
   * @returns Delta result or null if delta would be larger than target
   */
  computeDelta(base: Uint8Array, target: Uint8Array): DeltaResult | null;

  /**
   * Apply delta to base to reconstruct target
   *
   * @param base Base object content
   * @param delta Delta bytes
   * @returns Reconstructed target content
   * @throws Error if delta is invalid or base doesn't match
   */
  applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array;

  /**
   * Estimate if delta would be beneficial without full computation
   *
   * Used for quick filtering before expensive delta computation.
   * Should be very fast (O(1) or O(log n) complexity).
   *
   * @param baseSize Size of base object
   * @param targetSize Size of target object
   * @returns Estimate of delta quality
   */
  estimateDeltaQuality(baseSize: number, targetSize: number): DeltaEstimate;
}
