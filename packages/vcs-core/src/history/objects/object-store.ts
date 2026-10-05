/**
 * Git object store interface
 *
 * Unified interface for all Git object types (blob, commit, tree, tag).
 * Git objects are stored with header: "type size\0content"
 * SHA-1 hash is computed over the full object (header + content).
 */

import type { ObjectId } from "../../common/id/index.js";
import type { VolatileStore } from "../../storage/binary/volatile-store.js";
import type { RawStorage } from "../../storage/raw/raw-storage.js";
import type { ObjectTypeString } from "./object-types.js";

/**
 * Git object header information
 */
export interface GitObjectHeader {
  /** Object type */
  type: ObjectTypeString;
  /** Content size in bytes */
  size: number;
}

/**
 * Options for creating a GitObjectStore
 *
 * This is the standard way to construct a GitObjectStore with the new
 * RawStorage-based architecture.
 */
export interface GitObjectStoreOptions {
  /**
   * Raw storage backend for persisted objects
   *
   * All Git objects are stored through this interface. The storage
   * handles compression internally (if needed, e.g. FileRawStorage
   * compresses by default).
   */
  storage: RawStorage;

  /**
   * Optional volatile storage for buffering unknown-size content
   *
   * When storing content with unknown size, it must be buffered to
   * determine the size before the Git header can be written.
   * If not provided, a default in-memory volatile store is used.
   */
  volatile?: VolatileStore;
}

/**
 * Low-level Git object storage interface (raw bytes with headers)
 *
 * Provides storage for all Git object types (blob, commit, tree, tag).
 * Objects are stored with Git format: "type size\0content"
 * and identified by their SHA-1 hash.
 *
 * This is the **raw layer** — it works with untyped byte streams and
 * Git object headers. Higher-level typed stores (Blobs, Trees, Commits, Tags)
 * extend {@link ObjectStorage} and wrap a GitObjectStore to provide
 * serialization/deserialization of semantic values.
 *
 * @see {@link ObjectStorage} for the generic typed store interface
 */
export interface GitObjectStore {
  /**
   * Store object content
   *
   * Content is provided without the Git header - the header is added
   * automatically based on type and content size.
   *
   * @param type Object type
   * @param content Async iterable of content chunks (without header)
   * @returns ObjectId (SHA-1 hash of header + content)
   */
  store(
    type: ObjectTypeString,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<ObjectId>;

  /**
   * Load raw object including header
   *
   * @param id ObjectId of the object
   * @returns Async iterable of raw object chunks (with header)
   * @throws Error if object not found
   */
  loadRaw(id: ObjectId): AsyncGenerator<Uint8Array>;

  /**
   * Get object header and content stream
   * @param id ObjectId of the object
   * @returns Tuple of object header and async iterable of content chunks
   * @throws Error if object not found
   */
  loadWithHeader(id: ObjectId): Promise<[GitObjectHeader, AsyncGenerator<Uint8Array>]>;

  /**
   * Load object content (header stripped)
   *
   * @param id ObjectId of the object
   * @returns Async iterable of content chunks (without header)
   * @throws Error if object not found
   */
  load(id: ObjectId): AsyncGenerator<Uint8Array>;

  /**
   * Get object header without loading content
   *
   * @param id ObjectId of the object
   * @returns Object type and content size
   * @throws Error if object not found
   */
  getHeader(id: ObjectId): Promise<GitObjectHeader>;

  /**
   * Check if object exists
   *
   * @param id ObjectId of the object
   * @returns True if object exists
   */
  has(id: ObjectId): Promise<boolean>;

  /**
   * Remove object
   *
   * Named 'remove' instead of 'delete' to align with RawStorage interface
   * and avoid conflicts with JavaScript reserved keyword when used as
   * object property in certain contexts.
   *
   * @param id ObjectId of the object
   * @returns True if object was removed, false if it didn't exist
   */
  remove(id: ObjectId): Promise<boolean>;

  /**
   * List all object IDs
   *
   * @returns Async iterable of all object IDs
   */
  list(): AsyncIterable<ObjectId>;
}
