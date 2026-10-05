/**
 * Blob Delta API - Delta operations for blob objects only
 *
 * Blobs (file content) benefit most from delta compression since:
 * - They comprise 90%+ of repository storage
 * - Same files across commits delta very well
 * - Large files benefit significantly from delta compression
 *
 * Trees and commits are stored as-is (no delta tracking) because:
 * - They're typically small (100B - 10KB)
 * - Fast access is more important than marginal space savings
 * - Delta chain resolution adds latency for every tree/commit read
 */

import type { ObjectId } from "../../common/id/object-id.js";

/**
 * Source for finding delta base candidates
 *
 * Implementations can provide candidates from various sources:
 * - Same file path across commits
 * - Similar-sized blobs
 * - Objects in parent commits
 */
export type DeltaCandidateSource = AsyncIterable<ObjectId>;

/**
 * Result of streaming delta computation
 *
 * Contains the computed delta and metadata about compression quality.
 * The delta field is a one-time consumable stream (different from
 * DeltaResult in delta-compressor.ts which uses Uint8Array buffer).
 */
export interface StreamingDeltaResult {
  /** Base object ID used for delta */
  baseId: ObjectId;
  /**
   * Delta instruction bytes (one-time stream)
   *
   * Git-compatible binary delta format:
   * - Header: base size + result size (varints)
   * - Instructions: copy (from base) or insert (literal data)
   */
  delta: AsyncIterable<Uint8Array>;
  /** Original target size in bytes */
  targetSize: number;
  /** Base object size in bytes */
  baseSize: number;
  /** Compression ratio (delta size / target size) - lower is better */
  ratio: number;
  /** Bytes saved compared to storing full object */
  savings: number;
  /** Delta chain depth after applying this delta */
  chainDepth: number;
}

/**
 * Blob-specific delta chain information
 *
 * Tracks the chain of base objects needed to reconstruct content.
 * Uses ObjectId[] for typed chain tracking (different from DeltaChainInfo
 * in delta-store.ts which uses string[]).
 */
export interface BlobDeltaChainInfo {
  /** Number of delta applications needed (1 = single delta, 2+ = chained) */
  depth: number;
  /** Total size of all delta data in the chain */
  totalSize: number;
  /** Object IDs in chain order (target -> intermediate bases -> final base) */
  baseIds: ObjectId[];
}

/**
 * BlobDeltaApi - Core interface for blob delta operations
 *
 * Only blobs have delta support in internal storage. This is intentional:
 * - Pack serialization can still use deltas for trees/commits (wire efficiency)
 * - But internal storage only tracks blob deltas (storage efficiency)
 *
 * @example
 * ```typescript
 * // Find and apply best delta for a blob
 * const result = await blobDelta.findBlobDelta(targetId, candidateSource);
 * if (result) {
 *   await blobDelta.deltifyBlob(targetId, result.baseId, result.delta);
 * }
 *
 * // Check if blob is stored as delta
 * if (await blobDelta.isBlobDelta(blobId)) {
 *   const chain = await blobDelta.getBlobDeltaChain(blobId);
 *   console.log(`Chain depth: ${chain.depth}`);
 * }
 * ```
 */
export interface BlobDeltaApi {
  /**
   * Find best delta candidate for a blob
   *
   * Searches through candidates, computes deltas, and returns the best one.
   * Returns null if:
   * - No candidates provided
   * - No candidate produces an acceptable compression ratio
   * - Maximum chain depth would be exceeded
   *
   * @param targetId ObjectId of the blob to deltify
   * @param candidates Source of candidate base objects
   * @returns Best delta result or null if no good delta found
   */
  findBlobDelta(
    targetId: ObjectId,
    candidates: DeltaCandidateSource,
  ): Promise<StreamingDeltaResult | null>;

  /**
   * Store blob as delta of another blob
   *
   * Replaces the full content with a delta reference.
   * The original full content is removed after delta storage succeeds.
   *
   * @param targetId ObjectId of the blob to store as delta
   * @param baseId ObjectId of the base blob
   * @param delta Delta instruction stream (consumed once)
   * @throws Error if base doesn't exist or delta application fails verification
   */
  deltifyBlob(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void>;

  /**
   * Expand blob delta to full content
   *
   * Resolves the delta chain and stores the full content.
   * Removes the delta relationship after expansion.
   *
   * Use this when:
   * - The base is being deleted
   * - Chain depth is too long
   * - Frequent access needs fast retrieval
   *
   * @param id ObjectId of the blob to undeltify
   * @throws Error if blob doesn't exist or isn't stored as delta
   */
  undeltifyBlob(id: ObjectId): Promise<void>;

  /**
   * Check if blob is stored as delta
   *
   * @param id ObjectId of the blob
   * @returns True if blob is currently stored as a delta
   */
  isBlobDelta(id: ObjectId): Promise<boolean>;

  /**
   * Get delta chain information for a blob
   *
   * @param id ObjectId of the blob
   * @returns Chain info or undefined if not stored as delta
   */
  getBlobDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;
}
