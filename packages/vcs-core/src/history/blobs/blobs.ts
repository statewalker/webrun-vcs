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
   * With `size`, the content is read once and never held in memory (it must be
   * exactly `size` bytes, or the store rejects with `SizeMismatchError` and keeps
   * nothing). Without it, the content is read twice: content up to the kernel's
   * spool threshold (1 MiB by default) is kept in memory, longer content is
   * spooled to the store's temporary storage first (`GitObjects.putUnsized`).
   *
   * @param content Blob content as byte stream
   * @param size The content's length in bytes, when known
   * @returns SHA-1 hash of the blob content (with "blob <size>\0" prefix)
   */
  store(content: BlobContent | Iterable<Uint8Array>, size?: number): Promise<ObjectId>;

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

/** The id of the empty blob (`git hash-object /dev/null`). */
export const EMPTY_BLOB_ID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
