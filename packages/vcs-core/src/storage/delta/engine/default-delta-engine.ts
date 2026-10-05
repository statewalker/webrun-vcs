/**
 * DefaultDeltaEngine - Orchestrate delta compression
 *
 * Default implementation of DeltaEngine that combines:
 * - DeltaCompressor for computing deltas
 * - CandidateFinder for finding base candidates
 * - DeltaDecisionStrategy for deciding when to deltify
 */

import type { ObjectId } from "../../../common/id/object-id.js";
import type { CandidateFinder, DeltaTarget } from "../candidate-finder.js";
import type { DeltaCompressor } from "../delta-compressor.js";
import type { DeltaDecisionStrategy } from "../delta-decision-strategy.js";
import type {
  BestDeltaResult,
  DeltaEngine,
  DeltaEngineConfig,
  DeltaProcessResult,
  ObjectLoader,
} from "../delta-engine.js";

/**
 * Default values for engine configuration
 */
const DEFAULT_CONFIG: Required<DeltaEngineConfig> = {
  windowSize: 10,
  maxCandidatesPerTarget: 10,
  maxTargetSize: 16 * 1024 * 1024, // 16 MB
};

/**
 * DefaultDeltaEngine implementation
 *
 * Orchestrates the delta compression process:
 * 1. Check if target should be deltified (strategy)
 * 2. Find candidate bases (finder)
 * 3. Compute deltas for each candidate (compressor)
 * 4. Select the best delta that meets strategy criteria
 */
export class DefaultDeltaEngine implements DeltaEngine {
  private readonly config: Required<DeltaEngineConfig>;

  constructor(
    private readonly compressor: DeltaCompressor,
    private readonly candidateFinder: CandidateFinder,
    private readonly strategy: DeltaDecisionStrategy,
    private readonly objectLoader: ObjectLoader,
  ) {
    this.config = DEFAULT_CONFIG;
  }

  /**
   * Configure the engine with custom options
   */
  withConfig(config: DeltaEngineConfig): DefaultDeltaEngine {
    const newEngine = new DefaultDeltaEngine(
      this.compressor,
      this.candidateFinder,
      this.strategy,
      this.objectLoader,
    );
    Object.assign(newEngine.config, config);
    return newEngine;
  }

  async findBestDelta(target: DeltaTarget): Promise<BestDeltaResult | null> {
    // 1. Check if strategy allows deltification
    if (!this.strategy.shouldAttemptDelta(target)) {
      return null;
    }

    // 2. Skip if target is too large
    if (target.size > this.config.maxTargetSize) {
      return null;
    }

    // 3. Load target content if not already loaded
    const targetContent = target.content ?? (await this.objectLoader.load(target.id));

    // 4. Find and evaluate candidates
    let bestResult: BestDeltaResult | null = null;
    let candidatesEvaluated = 0;

    for await (const candidate of this.candidateFinder.findCandidates(target)) {
      // Limit candidates to avoid expensive searches
      if (candidatesEvaluated >= this.config.maxCandidatesPerTarget) {
        break;
      }
      candidatesEvaluated++;

      // Check chain depth limit
      const chainDepth = await this.objectLoader.getChainDepth(candidate.id);
      if (chainDepth >= this.strategy.maxChainDepth) {
        continue;
      }

      // Quick estimate before expensive computation
      const estimate = this.compressor.estimateDeltaQuality(candidate.size, target.size);
      if (!estimate.worthTrying) {
        continue;
      }

      // Load candidate content
      let candidateContent: Uint8Array;
      try {
        candidateContent = await this.objectLoader.load(candidate.id);
      } catch {
        // Skip if candidate can't be loaded
        continue;
      }

      // Compute delta
      const deltaResult = this.compressor.computeDelta(candidateContent, targetContent);

      // Check if delta is worthwhile
      if (!deltaResult) {
        continue;
      }

      if (!this.strategy.shouldUseDelta(deltaResult, candidate)) {
        continue;
      }

      // Track best result
      if (!bestResult || deltaResult.ratio > bestResult.ratio) {
        bestResult = {
          baseId: candidate.id,
          delta: deltaResult.delta,
          ratio: deltaResult.ratio,
          savings: deltaResult.savings,
          chainDepth: chainDepth + 1,
        };
      }
    }

    return bestResult;
  }

  async *processBatch(targets: AsyncIterable<DeltaTarget>): AsyncIterable<DeltaProcessResult> {
    for await (const target of targets) {
      const result = await this.findBestDelta(target);
      yield {
        targetId: target.id,
        result,
      };
    }
  }
}

/**
 * Simple object loader that wraps a load function
 *
 * Useful for creating ObjectLoader from a simple callback.
 */
export class SimpleObjectLoader implements ObjectLoader {
  constructor(
    private readonly loadFn: (id: ObjectId) => Promise<Uint8Array>,
    private readonly getChainDepthFn: (id: ObjectId) => Promise<number> = async () => 0,
  ) {}

  load(id: ObjectId): Promise<Uint8Array> {
    return this.loadFn(id);
  }

  getChainDepth(id: ObjectId): Promise<number> {
    return this.getChainDepthFn(id);
  }
}

/**
 * Create a delta engine with common configuration
 *
 * @param compressor Delta compressor to use
 * @param candidateFinder Candidate finder to use
 * @param strategy Decision strategy to use
 * @param objectLoader Object loader to use
 * @param config Optional engine configuration
 * @returns Configured delta engine
 */
export function createDeltaEngine(
  compressor: DeltaCompressor,
  candidateFinder: CandidateFinder,
  strategy: DeltaDecisionStrategy,
  objectLoader: ObjectLoader,
  config?: DeltaEngineConfig,
): DeltaEngine {
  const engine = new DefaultDeltaEngine(compressor, candidateFinder, strategy, objectLoader);
  if (config) {
    return engine.withConfig(config);
  }
  return engine;
}
