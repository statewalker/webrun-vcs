/**
 * Blobs - New interface for blob (file content) storage
 *
 * This is the new interface with bare naming convention (Blobs instead of BlobStore)
 * and consistent method names (remove instead of delete).
 */

import type { ObjectId } from "../../common/index.js";
import type { ObjectStorage } from "../objects/index.js";

/**
 * Blob content as a streaming type
 *
 * Blobs are stored as streaming content for efficiency with large files.
 */
export type BlobContent = AsyncIterable<Uint8Array>;

/**
 * Blob object store for file content
 *
 * Blobs represent file content in the repository. Unlike Trees, Commits,
 * and Tags, blobs are stored without Git object headers for efficiency.
 *
 * The store() method accepts streaming content and returns the SHA-1 hash.
 * The load() method returns a streaming AsyncIterable for memory efficiency.
 */
export interface Blobs extends ObjectStorage<BlobContent> {
  /**
   * Store blob content
   *
   * Accepts both sync and async iterables for flexibility.
   * The content is hashed incrementally during storage.
   *
   * @param content Blob content as byte stream
   * @returns SHA-1 hash of the blob content (with "blob <size>\0" prefix)
   */
  store(content: BlobContent | Iterable<Uint8Array>): Promise<ObjectId>;

  /**
   * Load blob content
   *
   * Returns a streaming AsyncIterable to avoid loading large files
   * entirely into memory.
   *
   * @param id Blob object ID
   * @returns Streaming content if found, undefined otherwise
   */
  load(id: ObjectId): Promise<BlobContent | undefined>;

  /**
   * Check if a blob exists
   *
   * @param id Blob object ID
   * @returns True if blob exists
   */
  has(id: ObjectId): Promise<boolean>;

  /**
   * Get blob size without loading content
   *
   * Useful for progress reporting and pre-allocation.
   *
   * @param id Blob object ID
   * @returns Size in bytes, or -1 if blob not found
   */
  size(id: ObjectId): Promise<number>;
}

/**
 * Extended queries for native Blobs implementations
 *
 * These methods are optional and only available in implementations
 * that support advanced queries (e.g., SQL with indexes).
 */
export interface BlobsExtended extends Blobs {
  /**
   * Find blobs by size range
   *
   * @param minSize Minimum size in bytes (inclusive)
   * @param maxSize Maximum size in bytes (exclusive)
   * @returns AsyncIterable of matching blob IDs
   */
  findBySize?(minSize: number, maxSize: number): AsyncIterable<ObjectId>;
}
