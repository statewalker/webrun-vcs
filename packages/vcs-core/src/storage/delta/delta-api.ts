/**
 * Unified Delta API - Delta management with batch operations
 *
 * This is the main entry point for delta operations in the storage layer.
 * Supports blobs (always), trees (optional), and commits (optional).
 *
 * Tree/commit delta support is backend-dependent:
 * - Git-files: binary deltas (same algorithm as blobs)
 * - SQL/KV/memory: structural tree deltas (base tree + entry changes)
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type { BlobDeltaApi, BlobDeltaChainInfo } from "./blob-delta-api.js";
import type { CommitDeltaApi } from "./commit-delta-api.js";
import type { TreeDeltaApi } from "./tree-delta-api.js";

/**
 * Storage delta relationship with metadata
 *
 * Describes a delta dependency between two objects with storage statistics.
 * Used for enumeration and analysis of storage structure.
 *
 * Note: Different from DeltaRelationship in delta-reverse-index.ts which
 * is simpler (target/base only) for pack file operations.
 */
export interface StorageDeltaRelationship {
  /** Target object ID (the one stored as delta) */
  targetId: ObjectId;
  /** Base object ID (the one it's delta'd against) */
  baseId: ObjectId;
  /** Current chain depth */
  depth: number;
  /** Compression ratio achieved (delta size / target size) */
  ratio: number;
}

/**
 * DeltaApi - Unified interface for delta operations
 *
 * Provides:
 * - Blob delta operations via `.blobs`
 * - Cross-type queries (though only blobs have deltas)
 * - Batch operations for atomic GC/repacking
 *
 * @example
 * ```typescript
 * // Start batch for atomic repacking
 * deltaApi.startBatch();
 * try {
 *   // Deltify multiple blobs
 *   for await (const blobId of blobsToProcess) {
 *     const result = await deltaApi.blobs.findBlobDelta(blobId, candidates);
 *     if (result) {
 *       await deltaApi.blobs.deltifyBlob(blobId, result.baseId, result.delta);
 *     }
 *   }
 *   // Commit all changes atomically
 *   await deltaApi.endBatch();
 * } catch (error) {
 *   deltaApi.cancelBatch();
 *   throw error;
 * }
 * ```
 */
export interface DeltaApi {
  /**
   * Blob delta operations
   */
  readonly blobs: BlobDeltaApi;

  /**
   * Tree delta operations (optional, backend-dependent)
   *
   * When available, trees can be stored as deltas.
   * Git-files backends use binary deltas; SQL/KV/memory use structural deltas.
   */
  readonly trees?: TreeDeltaApi;

  /**
   * Commit delta operations (optional, backend-dependent)
   *
   * When available, commits can be stored as binary deltas.
   */
  readonly commits?: CommitDeltaApi;

  // === Cross-type queries ===

  /**
   * Check if object is stored as delta
   *
   * Checks blobs, then trees (if available), then commits (if available).
   *
   * @param id ObjectId to check
   * @returns True if stored as delta
   */
  isDelta(id: ObjectId): Promise<boolean>;

  /**
   * Get delta chain for object
   *
   * Checks blobs, then trees (if available), then commits (if available).
   *
   * @param id ObjectId to query
   * @returns Chain info or undefined if not a delta
   */
  getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;

  /**
   * Enumerate all delta relationships
   *
   * Returns delta relationships across all object types.
   * Useful for storage analysis and optimization planning.
   *
   * @yields Delta relationships
   */
  listDeltas(): AsyncIterable<StorageDeltaRelationship>;

  /**
   * Get objects that depend on a base object
   *
   * Returns all objects stored as deltas against the given base.
   * Important for safe object deletion - a base cannot be deleted
   * while dependents exist.
   *
   * @param baseId ObjectId of the base object
   * @yields ObjectIds of dependent objects
   */
  getDependents(baseId: ObjectId): AsyncIterable<ObjectId>;

  // === Batch operations for atomic changes ===

  /**
   * Start a batch operation
   *
   * All delta changes after this call are collected and only
   * applied when endBatch() is called. If cancelBatch() is called,
   * all changes are discarded.
   *
   * Batches are useful for:
   * - GC repacking (all-or-nothing)
   * - Bulk deltification
   * - Safe delta chain reorganization
   *
   * Batches can be nested - only the outermost endBatch() commits.
   */
  startBatch(): void;

  /**
   * Commit all batched changes
   *
   * Applies all delta changes since the last startBatch() call.
   * This is an atomic operation - either all changes apply or none do.
   *
   * @throws Error if not in a batch or if commit fails
   */
  endBatch(): Promise<void>;

  /**
   * Cancel batch and discard changes
   *
   * Discards all delta changes since the last startBatch() call.
   * No changes are applied to storage.
   */
  cancelBatch(): void;
}
