/**
 * Tree Delta API - Delta operations for tree objects
 *
 * Two storage strategies:
 * - **Binary deltas** (git-files): byte-level copy/insert via GitDeltaCompressor
 * - **Structural deltas** (SQL/KV/memory): base tree + entry-level changes
 *
 * Structural deltas are more efficient for backends that already store trees
 * in a normalized form (e.g., SQL with `tree` + `tree_entry` tables).
 */

import type { ObjectId } from "../../common/id/object-id.js";
import type {
  BlobDeltaChainInfo,
  DeltaCandidateSource,
  StreamingDeltaResult,
} from "./blob-delta-api.js";

/**
 * A single change in a structural tree delta
 */
export interface TreeDeltaChange {
  /** Type of change */
  type: "add" | "modify" | "delete";
  /** Entry name (filename or subdirectory name) */
  name: string;
  /** File mode (for add/modify) */
  mode?: number;
  /** Object ID (for add/modify) */
  objectId?: string;
}

/**
 * Structural tree delta representation
 *
 * Stores a tree as a set of changes relative to a base tree.
 * More efficient than binary deltas for SQL/KV/memory backends
 * that already store tree entries in normalized form.
 *
 * @example
 * ```typescript
 * // Base tree has: README.md, src/
 * // Target tree has: README.md (modified), src/, LICENSE (new)
 * const delta: StructuralTreeDelta = {
 *   baseTreeId: "abc123...",
 *   changes: [
 *     { type: "modify", name: "README.md", mode: 0o100644, objectId: "def456..." },
 *     { type: "add", name: "LICENSE", mode: 0o100644, objectId: "789abc..." },
 *   ],
 * };
 * ```
 */
export interface StructuralTreeDelta {
  /** Base tree object ID */
  baseTreeId: ObjectId;
  /** Changes relative to the base tree */
  changes: TreeDeltaChange[];
}

/**
 * TreeDeltaApi - Core interface for tree delta operations
 *
 * Mirrors BlobDeltaApi but for tree objects. Implementations may use
 * binary deltas (git-files) or structural deltas (SQL/KV/memory).
 *
 * @example
 * ```typescript
 * // Find and apply best delta for a tree
 * const result = await treeDelta.findTreeDelta(targetId, candidateSource);
 * if (result) {
 *   await treeDelta.deltifyTree(targetId, result.baseId, result.delta);
 * }
 *
 * // Check if tree is stored as delta
 * if (await treeDelta.isTreeDelta(treeId)) {
 *   const chain = await treeDelta.getTreeDeltaChain(treeId);
 *   console.log(`Chain depth: ${chain?.depth}`);
 * }
 * ```
 */
export interface TreeDeltaApi {
  /**
   * Find best delta candidate for a tree
   *
   * @param targetId ObjectId of the tree to deltify
   * @param candidates Source of candidate base objects
   * @returns Best delta result or null if no good delta found
   */
  findTreeDelta(
    targetId: ObjectId,
    candidates: DeltaCandidateSource,
  ): Promise<StreamingDeltaResult | null>;

  /**
   * Store tree as delta of another tree
   *
   * @param targetId ObjectId of the tree to store as delta
   * @param baseId ObjectId of the base tree
   * @param delta Delta instruction stream (consumed once)
   */
  deltifyTree(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void>;

  /**
   * Expand tree delta to full content
   *
   * @param id ObjectId of the tree to undeltify
   */
  undeltifyTree(id: ObjectId): Promise<void>;

  /**
   * Check if tree is stored as delta
   *
   * @param id ObjectId of the tree
   * @returns True if tree is currently stored as a delta
   */
  isTreeDelta(id: ObjectId): Promise<boolean>;

  /**
   * Get delta chain information for a tree
   *
   * @param id ObjectId of the tree
   * @returns Chain info or undefined if not stored as delta
   */
  getTreeDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;
}
