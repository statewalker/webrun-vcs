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

  /**
   * Remove leftovers of interrupted writes older than `olderThanMs` that
   * `History.objects.sweepStale` does not reach (such as the SQL native blob
   * store's `tmp:*` rows). Optional.
   *
   * @returns The number of leftovers removed
   */
  sweepStale?(olderThanMs: number): Promise<number>;

  /**
   * Roots of reachability the refs do not show, which `GcOrchestrator` adds to every ref,
   * HEAD and the refs' reflogs: on git files, the index (all stages, its cache-tree and
   * resolve-undo), every reflog file, and each linked worktree's HEAD, index and reflogs; and
   * the shallow commits, if the refs do not give them. Optional; ids that are not stored are
   * skipped. Throw if a root cannot be read: a root skipped would let gc delete what it holds.
   *
   * @example
   * ```typescript
   * async collectRoots() {
   *   return { roots: await indexAndWorktreeIds(), shallow: await readShallow() };
   * }
   * ```
   */
  collectRoots?(): Promise<GcRoots>;

  /**
   * Of the unreachable `ids`, those written within the last `pruneExpireMs` (git's
   * `gc.pruneExpire`): `GcOrchestrator` keeps them and everything they reach, as git keeps
   * recent objects that may belong to a write in progress. An object whose age is unknown
   * should count as recent. Optional: without it every unreachable object is pruned.
   */
  recentObjects?(ids: Set<ObjectId>, pruneExpireMs: number): Promise<Set<ObjectId>>;
}

/** What `GcStrategy.collectRoots` adds to the roots the refs give. */
export interface GcRoots {
  /** Objects to keep, with everything they reach */
  roots: Iterable<ObjectId>;
  /** Shallow commits: their parents may be absent */
  shallow?: Iterable<ObjectId>;
  /**
   * Objects kept without being walked, present or not (a partial clone's promisor objects:
   * the objects of promisor packs and the absent objects they name, which git's walks leave
   * out with `--exclude-promisor-objects`): never pruned, never required, and what they
   * reach is kept only when a root or another kept walk reaches it
   */
  keep?: Iterable<ObjectId>;
}
