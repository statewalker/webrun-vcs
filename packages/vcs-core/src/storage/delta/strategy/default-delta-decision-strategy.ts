/**
 * DefaultDeltaDecisionStrategy - Configurable delta decision strategy
 *
 * Default implementation of DeltaDecisionStrategy with configurable thresholds.
 */

import type { ObjectTypeCode } from "../../../history/objects/object-types.js";
import type { DeltaCandidate, DeltaTarget } from "../candidate-finder.js";
import type { DeltaResult } from "../delta-compressor.js";
import type { DeltaDecisionOptions, DeltaDecisionStrategy } from "../delta-decision-strategy.js";

/**
 * Default values for delta decision options
 */
const DEFAULT_OPTIONS: Required<DeltaDecisionOptions> = {
  minObjectSize: 64,
  maxObjectSize: 512 * 1024 * 1024, // 512 MB
  minCompressionRatio: 1.5,
  minBytesSaved: 32,
  maxChainDepth: 50,
  allowedTypes: [], // Empty = all types allowed
};

/**
 * DefaultDeltaDecisionStrategy implementation
 *
 * Provides configurable thresholds for:
 * - Minimum/maximum object sizes
 * - Minimum compression ratio
 * - Minimum bytes saved
 * - Maximum chain depth
 * - Allowed object types
 */
export class DefaultDeltaDecisionStrategy implements DeltaDecisionStrategy {
  private readonly options: Required<DeltaDecisionOptions>;

  constructor(options: DeltaDecisionOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  shouldAttemptDelta(target: DeltaTarget): boolean {
    const { minObjectSize, maxObjectSize, allowedTypes } = this.options;

    // Size checks
    if (target.size < minObjectSize) {
      return false;
    }
    if (target.size > maxObjectSize) {
      return false;
    }

    // Type checks
    if (allowedTypes.length > 0) {
      if (!allowedTypes.includes(target.type)) {
        return false;
      }
    }

    return true;
  }

  shouldUseDelta(result: DeltaResult, _candidate: DeltaCandidate): boolean {
    const { minCompressionRatio, minBytesSaved } = this.options;

    // Check compression ratio
    if (result.ratio < minCompressionRatio) {
      return false;
    }

    // Check absolute savings
    if (result.savings < minBytesSaved) {
      return false;
    }

    return true;
  }

  get maxChainDepth(): number {
    return this.options.maxChainDepth;
  }
}

/**
 * Pre-configured strategy for Git-native storage
 *
 * Allows all object types and uses standard Git thresholds.
 */
export function createGitNativeStrategy(): DeltaDecisionStrategy {
  return new DefaultDeltaDecisionStrategy({
    minObjectSize: 64,
    maxObjectSize: 512 * 1024 * 1024,
    minCompressionRatio: 1.5,
    minBytesSaved: 32,
    maxChainDepth: 50,
    allowedTypes: [], // All types
  });
}

/**
 * Pre-configured strategy for SQL/KV storage (blobs only)
 *
 * Only deltifies blobs since commits/trees are stored structured.
 */
export function createBlobOnlyStrategy(allowedTypes: ObjectTypeCode[]): DeltaDecisionStrategy {
  return new DefaultDeltaDecisionStrategy({
    minObjectSize: 64,
    maxObjectSize: 512 * 1024 * 1024,
    minCompressionRatio: 2.0, // Higher threshold for blob-only
    minBytesSaved: 64,
    maxChainDepth: 10, // Shorter chains for random access
    allowedTypes,
  });
}

/**
 * Pre-configured strategy for pack file generation
 *
 * Aggressive deltification - any savings helps.
 */
export function createPackStrategy(): DeltaDecisionStrategy {
  return new DefaultDeltaDecisionStrategy({
    minObjectSize: 32,
    maxObjectSize: 512 * 1024 * 1024,
    minCompressionRatio: 1.1, // Lower threshold - any savings helps
    minBytesSaved: 16,
    maxChainDepth: 50,
    allowedTypes: [], // All types
  });
}

/**
 * Pre-configured strategy for network streaming
 *
 * Balance between compression time and bandwidth savings.
 */
export function createNetworkStrategy(): DeltaDecisionStrategy {
  return new DefaultDeltaDecisionStrategy({
    minObjectSize: 128, // Skip very small objects
    maxObjectSize: 16 * 1024 * 1024, // Skip huge objects (too slow)
    minCompressionRatio: 1.3,
    minBytesSaved: 64,
    maxChainDepth: 10, // Shorter chains for streaming
    allowedTypes: [], // All types
  });
}
