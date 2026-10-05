/**
 * Raw byte storage interface
 *
 * This is THE backend boundary - the lowest level of storage abstraction.
 * All higher-level stores (Blobs, Trees, Commits, Tags) eventually
 * store their data through a RawStorage implementation.
 *
 * Implementations handle:
 * - Persistence (files, SQL, KV, memory)
 * - Compression (internal detail, transparent to consumers)
 * - Key mapping (e.g., Git's XX/XXXXXX structure)
 *
 * Higher-level APIs receive/provide uncompressed data.
 */
export interface RawStorage {
  /**
   * Store byte stream under key
   *
   * If content already exists under this key, it is replaced.
   * The stream is fully consumed before returning.
   *
   * @param key Storage key (typically object ID or content hash)
   * @param content Async iterable of content chunks
   */
  store(key: string, content: AsyncIterable<Uint8Array>): Promise<void>;

  /**
   * Load byte stream by key
   *
   * Returns an async iterable that yields the stored content.
   * Supports random access via start/end options for efficient
   * partial reads (e.g., reading headers without full content).
   *
   * @param key Storage key
   * @param options Optional range to load
   * @param options.start Byte offset to start reading (inclusive, default 0)
   * @param options.end Byte offset to stop reading (exclusive, default end of content)
   * @returns Async iterable of content chunks
   * @throws Error if key not found
   */
  load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array>;

  /**
   * Check if key exists
   *
   * @param key Storage key
   * @returns True if content exists for this key
   */
  has(key: string): Promise<boolean>;

  /**
   * Remove content by key
   *
   * Named 'remove' instead of 'delete' to avoid conflicts with
   * JavaScript reserved keyword when used as object property.
   *
   * @param key Storage key
   * @returns True if content was removed, false if key didn't exist
   */
  remove(key: string): Promise<boolean>;

  /**
   * List all keys
   *
   * @returns Async iterable of all storage keys
   */
  keys(): AsyncIterable<string>;

  /**
   * Get content size for a key
   *
   * Returns the uncompressed content size (actual data size,
   * not the on-disk compressed size).
   *
   * @param key Storage key
   * @returns Content size in bytes, or -1 if key not found
   */
  size(key: string): Promise<number>;
}
