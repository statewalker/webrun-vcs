/**
 * GC strategy interface for storage-independent garbage collection.
 *
 * Core owns the algorithms (reachability analysis, orchestration).
 * Backends own the storage operations (prune, compact, deltify).
 */

import type { ObjectId } from "../common/id/index.js";

/**
 * Result of a compact operation.
 */
export interface CompactResult {
  /** Number of new pack files created */
  packsCreated: number;
  /** Number of objects moved into pack files */
  objectsPacked: number;
  /** Number of small packs merged into larger ones */
  packsMerged: number;
}

/**
 * Storage statistics from a GC strategy.
 */
export interface StorageStats {
  /** Number of loose (unpacked) objects */
  looseObjectCount: number;
  /** Number of objects in pack files */
  packedObjectCount: number;
  /** Total storage size in bytes (approximate) */
  totalSize: number;
  /** Number of pack files */
  packCount: number;
}

/**
 * A candidate pair for delta compression.
 */
export interface DeltaCandidatePair {
  /** Object to be deltified */
  targetId: ObjectId;
  /** Base object to delta against */
  baseId: ObjectId;
  /** Estimated space savings in bytes */
  estimatedSavings: number;
}

/**
 * Storage-specific GC operations.
 *
 * Each storage backend (file, SQL, memory) implements this interface
 * to handle the actual storage operations. The GcOrchestrator calls
 * these methods after determining what work needs to be done.
 *
 * @example
 * ```typescript
 * class FileGcStrategy implements GcStrategy {
 *   async prune(unreachableIds) {
 *     for (const id of unreachableIds) {
 *       await this.looseStorage.remove(id);
 *     }
 *     return unreachableIds.size;
 *   }
 *   // ...
 * }
 * ```
 */
export interface GcStrategy {
  /**
   * Remove unreachable objects from storage.
   *
   * @param unreachableIds Set of object IDs determined to be unreachable
   * @returns Number of objects actually removed
   */
  prune(unreachableIds: Set<ObjectId>): Promise<number>;

  /**
   * Compact storage (e.g., repack loose objects into packs).
   *
   * @returns Statistics about the compaction
   */
  compact(): Promise<CompactResult>;

  /**
   * Apply delta compression to candidate pairs.
   *
   * Backends that don't support deltification should return 0.
   *
   * @param candidates Pairs of objects to deltify
   * @returns Number of deltas actually created
   */
  deltify(candidates: DeltaCandidatePair[]): Promise<number>;

  /**
   * Get current storage statistics.
   */
  getStats(): Promise<StorageStats>;
}
