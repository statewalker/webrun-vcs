/**
 * SizeSimilarityCandidateFinder - Find delta candidates based on size similarity
 *
 * Based on the observation that similar-sized objects often produce good deltas
 * (e.g., different versions of same file). This is a common heuristic used by
 * Git during pack generation.
 *
 * Only supports blobs since delta compression only applies to blobs per DeltaApi design.
 * Trees and commits are stored as-is without delta compression.
 */

import type { Blobs } from "../../../history/blobs/blobs.js";
import { ObjectType } from "../../../history/objects/object-types.js";
import type {
  CandidateFinder,
  CandidateFinderOptions,
  DeltaCandidate,
  DeltaTarget,
} from "../candidate-finder.js";

/**
 * Options for SizeSimilarityCandidateFinder
 */
export interface SizeSimilarityFinderOptions extends Omit<CandidateFinderOptions, "allowedTypes"> {
  /** Size tolerance ratio (default: 0.5 = 50% difference allowed) */
  tolerance?: number;
}

/**
 * Internal candidate representation for sorting
 */
interface ScoredCandidate {
  id: string;
  size: number;
  similarity: number;
}

/**
 * Find candidates with similar size to target
 *
 * Uses size similarity as a heuristic for content similarity.
 * Objects within the tolerance range are returned, sorted by
 * similarity (closest size first).
 *
 * Only supports blobs since delta compression only applies to blobs.
 */
export class SizeSimilarityCandidateFinder implements CandidateFinder {
  private readonly tolerance: number;
  private readonly maxCandidates: number;
  private readonly minSimilarity: number;

  constructor(
    private readonly blobs: Blobs,
    options: SizeSimilarityFinderOptions = {},
  ) {
    this.tolerance = options.tolerance ?? 0.5;
    this.maxCandidates = options.maxCandidates ?? 10;
    this.minSimilarity = options.minSimilarity ?? 0;
  }

  async *findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    // Calculate size bounds based on tolerance
    const minSize = Math.floor(target.size * (1 - this.tolerance));
    const maxSize = Math.ceil(target.size * (1 + this.tolerance));

    // Collect candidates with similar sizes
    const candidates: ScoredCandidate[] = [];
    const bufferSize = this.maxCandidates * 2; // Collect extra for sorting

    // Enumerate blobs directly - only blobs have delta support
    for await (const id of this.blobs.keys()) {
      // Skip the target itself
      if (id === target.id) continue;

      // Get blob size directly from BlobStore
      const size = await this.blobs.size(id);

      // Check size within tolerance range
      if (size < minSize || size > maxSize) continue;

      // Calculate similarity based on size difference
      // Closer sizes = higher similarity
      const sizeDiff = Math.abs(size - target.size);
      const similarity = 1 - sizeDiff / Math.max(target.size, 1);

      if (similarity < this.minSimilarity) continue;

      candidates.push({
        id,
        size,
        similarity,
      });

      // Early exit if we have enough candidates for sorting
      if (candidates.length >= bufferSize) {
        break;
      }
    }

    // Sort by similarity (highest first, i.e., closest size)
    candidates.sort((a, b) => b.similarity - a.similarity);

    // Yield top candidates
    let yielded = 0;
    for (const candidate of candidates) {
      if (yielded >= this.maxCandidates) break;

      const result: DeltaCandidate = {
        id: candidate.id,
        type: ObjectType.BLOB, // Always BLOB since we're iterating blobs
        size: candidate.size,
        similarity: candidate.similarity,
        reason: "similar-size",
      };

      yield result;
      yielded++;
    }
  }
}
