/**
 * Refs - New interface for reference storage
 *
 * This is the new interface with bare naming convention (Refs instead of RefStore)
 * and consistent method names (remove instead of delete).
 *
 * Unlike Blobs, Trees, Commits, and Tags, Refs does NOT extend ObjectStorage<V>
 * because refs have fundamentally different semantics:
 * - Use names as keys (not content-addressed hashes)
 * - Support symbolic references (refs pointing to other refs)
 * - Support atomic compare-and-swap updates
 * - Maintain reflogs for history tracking
 */

import type { ObjectId } from "../../common/index.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import type { ReflogEntry, ReflogReader } from "./reflog-types.js";

/**
 * Result of a compare-and-swap update operation
 */
export interface RefUpdateResult {
  success: boolean;
  previousValue?: ObjectId;
  errorMessage?: string;
}

// Re-export types from existing modules for convenience
export type { Ref, ReflogEntry, ReflogReader, SymbolicRef };

/**
 * Reference value - either a direct reference or symbolic reference
 */
export type RefValue = Ref | SymbolicRef;

/**
 * Reference entry for listing
 */
export type RefEntry = Ref | SymbolicRef;

/**
 * Reference store for branch and tag pointers
 *
 * Refs are named pointers to objects. Unlike object stores, refs:
 * - Use names as keys (not content-addressed hashes)
 * - Support symbolic references (refs pointing to other refs)
 * - Support atomic compare-and-swap updates
 * - Maintain reflogs for history tracking
 *
 * This interface does NOT extend ObjectStorage<V> because refs have
 * fundamentally different semantics.
 */
export interface Refs {
  /**
   * Get a reference value
   *
   * Returns the raw value (direct or symbolic).
   * Use resolve() to get the final object ID.
   *
   * @param name Reference name (e.g., "refs/heads/main")
   * @returns Reference value if exists, undefined otherwise
   */
  get(name: string): Promise<RefValue | undefined>;

  /**
   * Resolve a reference to its final object ID
   *
   * Follows symbolic references until reaching a direct ref.
   * Returns undefined if ref doesn't exist or chain is broken.
   *
   * @param name Reference name
   * @returns Resolved Ref object, or undefined if not found
   */
  resolve(name: string): Promise<Ref | undefined>;

  /**
   * Check if a reference exists
   *
   * @param name Reference name
   * @returns True if reference exists
   */
  has(name: string): Promise<boolean>;

  /**
   * List references
   *
   * @param prefix Optional prefix filter (e.g., "refs/heads/")
   * @returns AsyncIterable of reference entries
   */
  list(prefix?: string): AsyncIterable<RefEntry>;

  /**
   * Set a direct reference
   *
   * @param name Reference name
   * @param objectId Object ID to point to
   */
  set(name: string, objectId: ObjectId): Promise<void>;

  /**
   * Set a symbolic reference
   *
   * @param name Reference name
   * @param target Target reference name
   */
  setSymbolic(name: string, target: string): Promise<void>;

  /**
   * Remove a reference
   *
   * Named 'remove' instead of 'delete' to match other store interfaces.
   *
   * @param name Reference name
   * @returns True if removed, false if didn't exist
   */
  remove(name: string): Promise<boolean>;

  /**
   * Atomic compare-and-swap update
   *
   * Updates the reference only if its current value matches expected.
   * Used for safe concurrent updates.
   *
   * @param name Reference name
   * @param expected Expected current value (undefined for new refs)
   * @param newValue New value to set
   * @returns Result of the update operation
   */
  compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult>;

  /**
   * Initialize the refs store
   *
   * Creates necessary structures (e.g., HEAD pointing to refs/heads/main).
   * Optional - implementations that don't need initialization can omit.
   */
  initialize?(): Promise<void>;

  /**
   * Optimize storage
   *
   * Implementation-specific optimization (e.g., pack loose refs).
   * Optional - implementations that don't need optimization can omit.
   */
  optimize?(): Promise<void>;

  /**
   * Get reflog reader for a ref
   *
   * @param name Reference name (e.g., "HEAD", "refs/heads/main")
   * @returns ReflogReader or undefined if no reflog exists
   */
  getReflog?(name: string): Promise<ReflogReader | undefined>;

  /**
   * Pack loose refs
   *
   * Git-specific optimization to consolidate refs.
   * Optional - non-Git implementations can omit.
   *
   * @param refNames Specific refs to pack (empty array with all=true packs all)
   * @param options Pack options
   */
  packRefs?(refNames: string[], options?: { all?: boolean; deleteLoose?: boolean }): Promise<void>;
}
