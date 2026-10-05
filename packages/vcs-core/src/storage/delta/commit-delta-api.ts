/**
 * Commit Delta API - Delta operations for commit objects
 *
 * Commits use binary deltas only (byte-level copy/insert via GitDeltaCompressor).
 * Structural deltas don't provide meaningful benefit for commits since they
 * are small and have flat structure.
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type {
  BlobDeltaChainInfo,
  DeltaCandidateSource,
  StreamingDeltaResult,
} from "./blob-delta-api.js";

/**
 * CommitDeltaApi - Core interface for commit delta operations
 *
 * Mirrors BlobDeltaApi but for commit objects. Uses binary deltas only.
 *
 * @example
 * ```typescript
 * // Find and apply best delta for a commit
 * const result = await commitDelta.findCommitDelta(targetId, candidateSource);
 * if (result) {
 *   await commitDelta.deltifyCommit(targetId, result.baseId, result.delta);
 * }
 * ```
 */
export interface CommitDeltaApi {
  /**
   * Find best delta candidate for a commit
   *
   * @param targetId ObjectId of the commit to deltify
   * @param candidates Source of candidate base objects
   * @returns Best delta result or null if no good delta found
   */
  findCommitDelta(
    targetId: ObjectId,
    candidates: DeltaCandidateSource,
  ): Promise<StreamingDeltaResult | null>;

  /**
   * Store commit as delta of another commit
   *
   * @param targetId ObjectId of the commit to store as delta
   * @param baseId ObjectId of the base commit
   * @param delta Delta instruction stream (consumed once)
   */
  deltifyCommit(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void>;

  /**
   * Expand commit delta to full content
   *
   * @param id ObjectId of the commit to undeltify
   */
  undeltifyCommit(id: ObjectId): Promise<void>;

  /**
   * Check if commit is stored as delta
   *
   * @param id ObjectId of the commit
   * @returns True if commit is currently stored as a delta
   */
  isCommitDelta(id: ObjectId): Promise<boolean>;

  /**
   * Get delta chain information for a commit
   *
   * @param id ObjectId of the commit
   * @returns Chain info or undefined if not stored as delta
   */
  getCommitDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;
}
