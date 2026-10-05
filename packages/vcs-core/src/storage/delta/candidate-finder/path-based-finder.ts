/**
 * PathBasedCandidateFinder - Find delta candidates based on file paths
 *
 * Best for blob objects where same path typically means similar content.
 * Uses path history to find previous versions of the same file.
 */

import type { ObjectId } from "../../../common/id/object-id.js";
import type { ObjectTypeCode } from "../../../history/objects/object-types.js";
import type {
  CandidateFinder,
  CandidateFinderOptions,
  DeltaCandidate,
  DeltaTarget,
} from "../candidate-finder.js";

/**
 * Index of path history for finding previous versions
 */
export interface PathHistoryIndex {
  /**
   * Get previous versions of an object at a path
   *
   * Returns objects that were previously stored at this path,
   * ordered by recency (most recent first).
   *
   * @param path File path
   * @returns Async iterable of previous object versions
   */
  getPreviousVersions(path: string): AsyncIterable<PathVersion>;
}

/**
 * A previous version of an object at a path
 */
export interface PathVersion {
  /** Object ID */
  id: ObjectId;
  /** Object type */
  type: ObjectTypeCode;
  /** Object size */
  size: number;
}

/**
 * Index for finding objects by size
 */
export interface SizeIndex {
  /**
   * Find objects within a size range
   *
   * @param range Size range to search
   * @returns Async iterable of objects in range
   */
  findInRange(range: SizeRange): AsyncIterable<SizeIndexEntry>;
}

/**
 * Size range for queries
 */
export interface SizeRange {
  /** Minimum size (inclusive) */
  min: number;
  /** Maximum size (inclusive) */
  max: number;
}

/**
 * Entry in the size index
 */
export interface SizeIndexEntry {
  /** Object ID */
  id: ObjectId;
  /** Object type */
  type: ObjectTypeCode;
  /** Object size */
  size: number;
}

/**
 * PathBasedCandidateFinder implementation
 *
 * Finds delta candidates based on:
 * 1. Same file path (previous versions) - highest priority
 * 2. Similar size objects - lower priority
 */
export class PathBasedCandidateFinder implements CandidateFinder {
  constructor(
    private readonly pathIndex: PathHistoryIndex,
    private readonly sizeIndex?: SizeIndex,
    private readonly options: CandidateFinderOptions = {},
  ) {}

  async *findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate> {
    const seen = new Set<ObjectId>();
    let count = 0;
    const maxCandidates = this.options.maxCandidates ?? 10;
    const minSimilarity = this.options.minSimilarity ?? 0;

    // 1. Same path, previous versions (highest priority)
    if (target.path) {
      for await (const prev of this.pathIndex.getPreviousVersions(target.path)) {
        if (seen.has(prev.id)) continue;
        if (prev.id === target.id) continue;
        seen.add(prev.id);

        const candidate: DeltaCandidate = {
          id: prev.id,
          type: prev.type,
          size: prev.size,
          similarity: 0.9, // Same path = high similarity
          reason: "same-path",
        };

        if (candidate.similarity >= minSimilarity) {
          yield candidate;
          count++;
          if (count >= maxCandidates) return;
        }
      }
    }

    // 2. Similar size objects (medium priority)
    if (this.sizeIndex && count < maxCandidates) {
      const sizeRange: SizeRange = {
        min: Math.floor(target.size * 0.5),
        max: Math.ceil(target.size * 2),
      };

      for await (const similar of this.sizeIndex.findInRange(sizeRange)) {
        if (seen.has(similar.id)) continue;
        if (similar.id === target.id) continue;
        seen.add(similar.id);

        // Calculate similarity based on size difference
        const sizeDiff = Math.abs(similar.size - target.size);
        const similarity = 1 - sizeDiff / Math.max(similar.size, target.size);

        if (similarity < minSimilarity) continue;

        const candidate: DeltaCandidate = {
          id: similar.id,
          type: similar.type,
          size: similar.size,
          similarity,
          reason: "similar-size",
        };

        yield candidate;
        count++;
        if (count >= maxCandidates) return;
      }
    }
  }
}

/**
 * In-memory implementation of PathHistoryIndex
 *
 * Useful for testing and simple use cases.
 */
export class MemoryPathHistoryIndex implements PathHistoryIndex {
  private readonly history = new Map<string, PathVersion[]>();

  addVersion(path: string, version: PathVersion): void {
    const versions = this.history.get(path) ?? [];
    versions.unshift(version); // Add to front (most recent)
    this.history.set(path, versions);
  }

  async *getPreviousVersions(path: string): AsyncIterable<PathVersion> {
    const versions = this.history.get(path) ?? [];
    for (const v of versions) {
      yield v;
    }
  }
}

/**
 * In-memory implementation of SizeIndex
 *
 * Useful for testing and simple use cases.
 */
export class MemorySizeIndex implements SizeIndex {
  private readonly entries: SizeIndexEntry[] = [];

  addEntry(entry: SizeIndexEntry): void {
    this.entries.push(entry);
    // Keep sorted by size for efficient range queries
    this.entries.sort((a, b) => a.size - b.size);
  }

  async *findInRange(range: SizeRange): AsyncIterable<SizeIndexEntry> {
    for (const entry of this.entries) {
      if (entry.size >= range.min && entry.size <= range.max) {
        yield entry;
      }
    }
  }
}
