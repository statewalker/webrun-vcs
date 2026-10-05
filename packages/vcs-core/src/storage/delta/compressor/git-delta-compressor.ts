/**
 * GitDeltaCompressor - Git delta algorithm implementation
 *
 * Implements DeltaCompressor using Git's delta compression format.
 * Uses rolling hash algorithm for finding matching blocks.
 */

import { createDeltaRanges, deltaRangesToGitFormat, parseGitDelta } from "@statewalker/vcs-utils";
import type { DeltaCompressor, DeltaEstimate, DeltaResult } from "../delta-compressor.js";

/**
 * Configuration for GitDeltaCompressor
 */
export interface GitDeltaCompressorConfig {
  /** Block size for rolling hash (default: 16) */
  blockSize?: number;
  /** Minimum match length to consider (default: same as blockSize) */
  minMatch?: number;
  /** Minimum ratio to consider delta worthwhile (default: 1.1) */
  minRatio?: number;
}

/**
 * GitDeltaCompressor implementation
 *
 * Uses the rolling hash delta algorithm to compute Git-format deltas.
 */
export class GitDeltaCompressor implements DeltaCompressor {
  private readonly blockSize: number;
  private readonly minMatch: number;
  private readonly minRatio: number;

  constructor(config: GitDeltaCompressorConfig = {}) {
    this.blockSize = config.blockSize ?? 16;
    this.minMatch = config.minMatch ?? this.blockSize;
    this.minRatio = config.minRatio ?? 1.1;
  }

  computeDelta(base: Uint8Array, target: Uint8Array): DeltaResult | null {
    // Don't compute delta if target is very small
    if (target.length < this.blockSize) {
      return null;
    }

    // Compute delta using rolling hash algorithm
    const ranges = createDeltaRanges(base, target, this.blockSize, this.minMatch);

    // Convert to Git binary format
    const delta = deltaRangesToGitFormat(base, target, ranges);

    // Check if delta is worthwhile
    if (delta.length >= target.length) {
      return null;
    }

    const ratio = target.length / delta.length;
    if (ratio < this.minRatio) {
      return null;
    }

    return {
      delta,
      ratio,
      savings: target.length - delta.length,
      baseSize: base.length,
      targetSize: target.length,
    };
  }

  applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
    const parsed = parseGitDelta(delta);

    // Validate base size
    if (parsed.baseSize !== base.length) {
      throw new Error(`Base size mismatch: expected ${parsed.baseSize}, got ${base.length}`);
    }

    // Allocate result buffer
    const result = new Uint8Array(parsed.resultSize);
    let pos = 0;

    // Apply instructions
    for (const instr of parsed.instructions) {
      if (instr.type === "copy") {
        // Validate copy bounds
        if (instr.offset + instr.size > base.length) {
          throw new Error(
            `Copy out of bounds: offset=${instr.offset}, size=${instr.size}, base.length=${base.length}`,
          );
        }
        result.set(base.subarray(instr.offset, instr.offset + instr.size), pos);
        pos += instr.size;
      } else {
        // Insert
        result.set(instr.data, pos);
        pos += instr.data.length;
      }
    }

    // Validate result size
    if (pos !== parsed.resultSize) {
      throw new Error(`Result size mismatch: expected ${parsed.resultSize}, got ${pos}`);
    }

    return result;
  }

  estimateDeltaQuality(baseSize: number, targetSize: number): DeltaEstimate {
    // Quick heuristics for whether delta is likely to be beneficial

    // Very small targets don't benefit from deltification
    if (targetSize < this.blockSize * 2) {
      return {
        worthTrying: false,
        expectedRatio: 1.0,
        reason: "Target too small",
      };
    }

    // If sizes are very different (>10x), delta unlikely to help much
    const sizeRatio = Math.max(baseSize, targetSize) / Math.min(baseSize, targetSize);
    if (sizeRatio > 10) {
      return {
        worthTrying: false,
        expectedRatio: 1.0,
        reason: "Size difference too large",
      };
    }

    // Similar sizes suggest similar content
    if (sizeRatio < 1.5) {
      return {
        worthTrying: true,
        expectedRatio: 2.0 + (1 - (sizeRatio - 1) / 0.5), // Higher ratio for closer sizes
      };
    }

    // Moderate size difference - still worth trying
    return {
      worthTrying: true,
      expectedRatio: 1.5,
    };
  }
}
