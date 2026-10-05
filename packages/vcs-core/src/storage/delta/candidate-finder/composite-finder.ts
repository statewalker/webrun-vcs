/**
 * CompositeCandidateFinder - Combine multiple candidate finders
 *
 * Delegates to multiple finders and deduplicates/orders results.
 * Allows combining different strategies (path-based, size-based, etc.)
 */

import type { ObjectId } from "../../../common/id/object-id.js";
import type {
  CandidateFinder,
  CandidateFinderOptions,
  DeltaCandidate,
  DeltaTarget,
} from "../candidate-finder.js";

/**
 * CompositeCandidateFinder implementation
 *
 * Combines multiple finders, deduplicates results, and orders by similarity.
 */
export class CompositeCandidateFinder implements CandidateFinder {
  constructor(
    private readonly finders: CandidateFinder[],
    private readonly options: CandidateFinderOptions = {},
  ) {}

  async *findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    const seen = new Set<ObjectId>();
    const candidates: DeltaCandidate[] = [];
    const maxCandidates = this.options.maxCandidates ?? 10;
    const minSimilarity = this.options.minSimilarity ?? 0;

    // Collect candidates from all finders
    for (const finder of this.finders) {
      for await (const candidate of finder.findCandidates(target)) {
        // Skip duplicates
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);

        // Skip low similarity
        if (candidate.similarity < minSimilarity) continue;

        candidates.push(candidate);
      }
    }

    // Sort by similarity (highest first)
    candidates.sort((a, b) => b.similarity - a.similarity);

    // Yield top candidates up to limit
    let count = 0;
    for (const candidate of candidates) {
      if (count >= maxCandidates) return;
      yield candidate;
      count++;
    }
  }
}

/**
 * Create a composite finder from multiple finders
 *
 * Convenience function for creating CompositeCandidateFinder.
 *
 * @param finders Finders to combine
 * @param options Options for limiting candidates
 * @returns Combined finder
 */
export function combineFinders(
  finders: CandidateFinder[],
  options?: CandidateFinderOptions,
): CandidateFinder {
  if (finders.length === 0) {
    return new EmptyCandidateFinder();
  }
  if (finders.length === 1) {
    return finders[0];
  }
  return new CompositeCandidateFinder(finders, options);
}

/**
 * Empty candidate finder that returns no candidates
 *
 * Useful as a null object or placeholder.
 */
export class EmptyCandidateFinder implements CandidateFinder {
  async *findCandidates(_target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    // Return nothing
  }
}

/**
 * Window-based candidate finder
 *
 * Finds candidates from a sliding window of recently seen objects.
 * Useful for pack file generation where objects are processed sequentially.
 */
export class WindowCandidateFinder implements CandidateFinder {
  private readonly window: DeltaCandidate[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 10) {
    this.windowSize = windowSize;
  }

  /**
   * Add an object to the window
   */
  addToWindow(candidate: DeltaCandidate): void {
    this.window.push(candidate);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
  }

  async *findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    // Yield all objects in window except the target itself
    for (const candidate of this.window) {
      if (candidate.id === target.id) continue;

      // Recalculate similarity based on type match
      const typeMatch = candidate.type === target.type;
      const sizeDiff = Math.abs(candidate.size - target.size);
      const sizeRatio = sizeDiff / Math.max(candidate.size, target.size);

      yield {
        ...candidate,
        similarity: typeMatch ? 0.5 + (1 - sizeRatio) * 0.3 : 0.2,
        reason: "recent",
      };
    }
  }

  /**
   * Clear the window
   */
  clear(): void {
    this.window.length = 0;
  }
}
