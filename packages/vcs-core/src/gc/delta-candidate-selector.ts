/**
 * Delta candidate selection algorithm for GC.
 *
 * Selects pairs of objects that would benefit from delta compression
 * using a sliding window algorithm similar to `git pack-objects`.
 *
 * Storage-independent: works with any backend that can provide
 * object metadata (type + size).
 */

import type { ObjectId } from "../common/id/index.js";
import type { DeltaCandidatePair } from "./gc-strategy.js";

/**
 * Object metadata needed for delta candidate selection.
 */
export interface DeltaObjectInfo {
  /** Object ID */
  id: ObjectId;
  /** Git object type */
  type: string;
  /** Uncompressed object size in bytes */
  size: number;
  /** Current delta chain depth (0 = not deltified) */
  depth?: number;
}

/**
 * Options for delta candidate selection.
 */
export interface DeltaCandidateSelectorOptions {
  /** Number of neighbors to compare against (default: 10) */
  window?: number;
  /** Maximum delta chain depth (default: 50) */
  maxDepth?: number;
  /** Skip objects larger than this (default: 512MB) */
  maxSize?: number;
  /** Minimum savings ratio to select a pair (default: 0.5 = 50%) */
  minSavingsRatio?: number;
}

/**
 * Select delta candidate pairs from a list of objects.
 *
 * Algorithm (mirrors `git pack-objects --window=10 --depth=50`):
 * 1. Sort objects by type, then by size (ascending)
 * 2. Sliding window: for each object, compare against window neighbors
 *    of the same type. Pair with the nearest-sized neighbor.
 * 3. Estimate savings from size similarity (closer sizes = better delta)
 * 4. Skip objects at max depth or above max size
 *
 * The returned pairs can be passed to GcStrategy.deltify() for execution.
 *
 * @example
 * ```typescript
 * const objects: DeltaObjectInfo[] = [];
 * for await (const id of history.blobs.keys()) {
 *   const header = await history.objects.getHeader(id);
 *   objects.push({ id, type: header.type, size: header.size });
 * }
 * const candidates = selectDeltaCandidates(objects, { window: 10 });
 * await strategy.deltify(candidates);
 * ```
 */
export function selectDeltaCandidates(
  objects: DeltaObjectInfo[],
  options: DeltaCandidateSelectorOptions = {},
): DeltaCandidatePair[] {
  const {
    window: windowSize = 10,
    maxDepth = 50,
    maxSize = 512 * 1024 * 1024,
    minSavingsRatio = 0.5,
  } = options;

  // Filter out oversized objects and those already at max depth
  const eligible = objects.filter(
    (obj) => obj.size <= maxSize && (obj.depth ?? 0) < maxDepth && obj.size > 0,
  );

  // Sort by type, then by size ascending (similar objects cluster together)
  eligible.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    if (typeCmp !== 0) return typeCmp;
    return a.size - b.size;
  });

  const candidates: DeltaCandidatePair[] = [];
  const selected = new Set<ObjectId>(); // Already selected as target

  for (let i = 0; i < eligible.length; i++) {
    const target = eligible[i];
    if (selected.has(target.id)) continue;

    let bestBase: DeltaObjectInfo | null = null;
    let bestSavings = 0;

    // Look back in the window for same-type neighbors
    const start = Math.max(0, i - windowSize);
    for (let j = start; j < i; j++) {
      const base = eligible[j];
      if (base.type !== target.type) continue;
      if (selected.has(base.id)) continue;

      // Estimate savings from size similarity.
      // Objects of similar size produce small deltas.
      // savings ≈ min(targetSize, baseSize) - |targetSize - baseSize|
      const sizeDiff = Math.abs(target.size - base.size);
      const minSize = Math.min(target.size, base.size);
      const estimatedSavings = minSize - sizeDiff;

      if (estimatedSavings <= 0) continue;

      // Check if savings ratio meets threshold
      const savingsRatio = estimatedSavings / target.size;
      if (savingsRatio < minSavingsRatio) continue;

      if (estimatedSavings > bestSavings) {
        bestSavings = estimatedSavings;
        bestBase = base;
      }
    }

    if (bestBase) {
      candidates.push({
        targetId: target.id,
        baseId: bestBase.id,
        estimatedSavings: bestSavings,
      });
      selected.add(target.id);
    }
  }

  return candidates;
}
