import type { ObjectId } from "../../common/index.js";

/**
 * Base interface for content-addressed object stores (typed/semantic layer)
 *
 * All typed object stores (Blobs, Trees, Commits, Tags) extend this
 * interface with domain-specific operations. This is the **high-level layer**
 * that works with parsed values (Commit objects, TreeEntry arrays, etc.).
 *
 * Concrete implementations typically wrap a {@link GitObjectStore} which
 * handles the underlying Git object format (headers, SHA-1 hashing).
 *
 * Type parameter V represents the object type being stored:
 * - Blobs: streaming content (AsyncIterable<Uint8Array>)
 * - Trees: Tree structure
 * - Commits: Commit structure
 * - Tags: Tag structure
 *
 * @template V The object type being stored
 * @see {@link GitObjectStore} for the raw byte-level storage interface
 */
export interface ObjectStorage<V> {
  /**
   * Store an object and return its content-addressed ID
   *
   * The ID is computed as SHA-1 hash of the object content.
   * If the object already exists, the existing ID is returned.
   *
   * @param value The object to store
   * @returns Content-addressed object ID (SHA-1)
   */
  store(value: V): Promise<ObjectId>;

  /**
   * Load an object by its ID
   *
   * @param id Object ID to load
   * @returns The object if found, undefined otherwise
   */
  load(id: ObjectId): Promise<V | undefined>;

  /**
   * Check if an object exists
   *
   * @param id Object ID to check
   * @returns True if object exists
   */
  has(id: ObjectId): Promise<boolean>;

  /**
   * Remove an object
   *
   * Named 'remove' instead of 'delete' to avoid JavaScript keyword conflict.
   *
   * @param id Object ID to remove
   * @returns True if object was removed, false if it didn't exist
   */
  remove(id: ObjectId): Promise<boolean>;

  /**
   * Iterate over all stored object IDs
   *
   * @returns AsyncIterable of all object IDs
   */
  keys(): AsyncIterable<ObjectId>;
}
