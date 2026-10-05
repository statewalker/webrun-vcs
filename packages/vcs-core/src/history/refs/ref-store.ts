/**
 * Reference storage interface
 *
 * Defines the abstract RefStore interface for managing Git refs.
 * The concrete Ref and SymbolicRef types are defined in ref-types.ts.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import type { ReflogReader } from "./reflog-types.js";

// Re-export RefStorage enum as RefStoreLocation for backwards compatibility
export { RefStorage as RefStoreLocation } from "./ref-types.js";

/**
 * Result of a compare-and-swap update operation
 */
export interface RefUpdateResult {
  success: boolean;
  previousValue?: ObjectId;
  errorMessage?: string;
}

/**
 * Abstract reference storage interface
 *
 * Provides ref management without filesystem dependencies.
 * Implementations may use files, databases, or other backends.
 */
export interface RefStore {
  /**
   * Read a ref by exact name
   */
  get(refName: string): Promise<Ref | SymbolicRef | undefined>;

  /**
   * Resolve a ref to its final object ID (follows symbolic refs)
   */
  resolve(refName: string): Promise<Ref | undefined>;

  /**
   * Check if a ref exists
   */
  has(refName: string): Promise<boolean>;

  /**
   * List all refs matching a prefix
   *
   * @param prefix Optional prefix filter (e.g., "refs/heads/")
   * @returns AsyncIterable of refs
   */
  list(prefix?: string): AsyncIterable<Ref | SymbolicRef>;

  /**
   * Set a ref to point to an object ID
   *
   * Creates or updates the ref.
   */
  set(refName: string, objectId: ObjectId): Promise<void>;

  /**
   * Set a symbolic ref
   */
  setSymbolic(refName: string, target: string): Promise<void>;

  /**
   * Delete a ref
   *
   * @returns True if ref was deleted, false if it didn't exist
   */
  delete(refName: string): Promise<boolean>;

  /**
   * Compare-and-swap update (for concurrent safety)
   *
   * @param refName Ref to update
   * @param expectedOld Expected current value (undefined for new refs)
   * @param newValue New value to set
   */
  compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult>;

  /**
   * Initialize storage structure (if needed)
   */
  initialize?(): Promise<void>;

  /**
   * Perform implementation-specific optimizations
   *
   * Each implementation decides what this means:
   * - Git filesystem: pack loose refs into packed-refs
   * - SQL: VACUUM, rebuild indexes
   * - Memory: no-op
   * - S3: batch consolidation
   *
   * Generic maintenance code can call this without knowing the implementation.
   */
  optimize?(): Promise<void>;

  /**
   * Get reflog reader for a ref
   *
   * @param refName Ref name (e.g., "HEAD", "refs/heads/main")
   * @returns ReflogReader or undefined if no reflog exists
   */
  getReflog?(refName: string): Promise<ReflogReader | undefined>;

  /**
   * Pack loose refs into packed-refs file
   *
   * @param refNames Specific refs to pack (empty array with all=true packs all)
   * @param options Pack options
   */
  packRefs?(refNames: string[], options?: { all?: boolean; deleteLoose?: boolean }): Promise<void>;
}
