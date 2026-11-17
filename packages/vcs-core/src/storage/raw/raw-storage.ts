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
   * The keys that start with `prefix`, in no particular order. Optional: a store that can
   * look a prefix up without listing every key (a KV prefix scan, an SQL range, one fan-out
   * directory) offers it; callers fall back to filtering `keys()`. Abbreviated object ids
   * (`git rev-parse 1a2b`) are found through it.
   */
  keysWithPrefix?(prefix: string): AsyncIterable<string>;

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

  /**
   * Rename a value without copying its bytes, replacing what `to` held. Optional:
   * stores that can do this cheaply (a map entry, a manifest row, a file rename)
   * offer it, and `rawStorageStaging` then streams a write into a temporary key
   * and renames it once the object id is known, instead of collecting the bytes.
   *
   * @returns True if `from` existed and was moved, false if it did not exist
   */
  move?(from: string, to: string): Promise<boolean>;

  /**
   * Rename several values at once, all or none (each as `move`, replacing what its target
   * held). Optional: a store with transactions (the SQL store) offers it, and a quarantine's
   * `commit` then publishes every quarantined object in one step; without it the objects are
   * moved one by one.
   *
   * @throws when a source does not exist; nothing is moved then
   */
  moveAll?(moves: ReadonlyArray<readonly [from: string, to: string]>): Promise<void>;

  /**
   * Remove storage that no key reaches any more and that is older than
   * `olderThanMs`: what an interrupted write or a lost race left behind (the
   * KV store's unreferenced chunks, the SQL store's unreferenced chunk rows).
   * Optional; `rawStorageStaging(raw).sweepStale` calls it, and gc calls that.
   * Must not remove the parts of a write still in progress.
   *
   * @returns The number of leftovers removed
   */
  sweepStale?(options: SweepStaleOptions): Promise<number>;
}

/**
 * The keys of `raw` that start with `prefix`: its `keysWithPrefix` where it has one, else
 * `keys()` filtered.
 */
export async function* rawKeysWithPrefix(raw: RawStorage, prefix: string): AsyncIterable<string> {
  if (raw.keysWithPrefix) {
    yield* raw.keysWithPrefix(prefix);
    return;
  }
  for await (const key of raw.keys()) if (key.startsWith(prefix)) yield key;
}

/** What `sweepStale` removes: leftovers older than `olderThanMs` (0 or less: every leftover not in use). */
export interface SweepStaleOptions {
  olderThanMs: number;
}
