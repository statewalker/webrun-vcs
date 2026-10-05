/**
 * Chunk-based storage access interface
 *
 * This interface provides low-level chunk operations for backends
 * that need to split large content into smaller pieces (SQL, KV stores).
 *
 * Implementations are responsible for:
 * - Storing individual chunks with key+index addressing
 * - Tracking chunk count per key (via metadata or count queries)
 * - Atomic operations within a single key's chunks
 *
 * Chunk size is NOT part of this interface - that's determined by
 * the ChunkedRawStorage that uses this ChunkAccess.
 */
export interface ChunkAccess {
  /**
   * Store a single chunk
   *
   * If a chunk already exists at this key+index, it is replaced.
   *
   * @param key Content key (typically object ID)
   * @param index Zero-based chunk index
   * @param data Chunk data (size determined by caller)
   */
  storeChunk(key: string, index: number, data: Uint8Array): Promise<void>;

  /**
   * Load a single chunk
   *
   * @param key Content key
   * @param index Zero-based chunk index
   * @returns Chunk data
   * @throws Error if chunk not found
   */
  loadChunk(key: string, index: number): Promise<Uint8Array>;

  /**
   * Get the number of chunks stored for a key
   *
   * @param key Content key
   * @returns Number of chunks (0 if key not found)
   */
  getChunkCount(key: string): Promise<number>;

  /**
   * Remove all chunks for a key
   *
   * Removes all chunks associated with this key.
   * Named 'removeChunks' to be consistent with RawStorage.remove().
   *
   * @param key Content key
   * @returns True if any chunks were removed, false if key didn't exist
   */
  removeChunks(key: string): Promise<boolean>;

  /**
   * Check if a key has any chunks stored
   *
   * @param key Content key
   * @returns True if at least one chunk exists for this key
   */
  hasKey(key: string): Promise<boolean>;

  /**
   * List all keys that have chunks stored
   *
   * @returns Async iterable of all keys with stored chunks
   */
  keys(): AsyncIterable<string>;
}

/**
 * Metadata stored for each chunked content
 *
 * Implementations may store this as a separate record or
 * derive it from chunk queries.
 */
export interface ChunkMetadata {
  /** Total size in bytes (sum of all chunks) */
  totalSize: number;
  /** Number of chunks */
  chunkCount: number;
  /** Size of each chunk (except possibly last) */
  chunkSize: number;
}
