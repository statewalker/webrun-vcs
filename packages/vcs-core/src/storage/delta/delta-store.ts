import type { Delta } from "@statewalker/vcs-utils";

/**
 * Base delta relationship information
 */
export interface DeltaInfo {
  /** Base object key (source for delta) */
  baseKey: string;
  /** Target object key (result of applying delta) */
  targetKey: string;
}

/**
 * Batched update handle for delta storage
 *
 * Encapsulates a transaction/batch of write operations. All writes
 * are collected and only persisted when close() is called.
 *
 * Usage:
 * ```typescript
 * const update = store.startUpdate();
 * await update.storeObject(id1, [contentWithHeader]);
 * update.storeDelta({ baseKey, targetKey }, delta);
 * await update.close(); // Commits all operations
 * ```
 */
export interface DeltaStoreUpdate {
  /**
   * Store a full object (non-delta) in this batch
   *
   * Content should be a stream of raw object data WITH Git header.
   * The implementation will parse the header to determine object type.
   *
   * @param key Object key (SHA-1 hash)
   * @param content Stream of raw object data WITH Git header
   */
  storeObject(
    key: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void>;

  /**
   * Store a delta relationship in this batch
   *
   * @param info Delta relationship info (baseKey, targetKey)
   * @param delta Delta instructions
   * @returns Compressed size in bytes
   */
  storeDelta(info: DeltaInfo, delta: Delta[]): Promise<number>;

  /**
   * Commit/flush all operations
   *
   * For pack-based: creates a single pack file with all objects
   * For SQL-based: commits the transaction
   * For KV-based: performs bulk write
   *
   * @returns Promise that resolves when all operations are persisted
   */
  close(): Promise<void>;
}

/**
 * Stored delta with instructions
 *
 * Returns delta as Delta[] instructions, regardless of how the backend
 * stores them internally (Git binary format, SQL rows, etc.).
 */
export interface StoredDelta extends DeltaInfo {
  /** Delta instructions (format-agnostic) */
  delta: Delta[];
  /** Compression ratio achieved (compressed/original) */
  ratio: number;
}

/**
 * Detailed delta chain information
 */
export interface DeltaChainDetails extends DeltaInfo {
  /** Chain depth (1 = direct delta, 2+ = chained) */
  depth: number;
  /** Original uncompressed size */
  originalSize: number;
  /** Compressed storage size */
  compressedSize: number;
  /** Object keys in chain order (target -> base) */
  chain: string[];
}

/**
 * Alias for backwards compatibility
 */
export type DeltaChainInfo = DeltaChainDetails;

/**
 * Delta compression storage interface
 *
 * Implementations store delta relationships and data in various formats:
 * - Git pack files (file-based) - serializes Delta[] to Git binary format
 * - SQL tables - stores Delta[] as JSON or individual rows
 * - In-memory maps - stores Delta[] directly
 *
 * All backends accept and return Delta[] instructions, handling
 * serialization internally.
 *
 * Write operations use the transaction pattern via startUpdate():
 * ```typescript
 * const update = store.startUpdate();
 * await update.storeObject(id, [contentWithHeader]);
 * await update.storeDelta(info, delta);
 * await update.close(); // Commits all operations
 * ```
 */
export interface DeltaStore {
  /**
   * Start a batched update transaction
   *
   * Returns an update handle that collects all write operations.
   * Operations are only persisted when close() is called on the handle.
   *
   * @returns Update handle for batched writes
   */
  startUpdate(): DeltaStoreUpdate;

  /**
   * Load delta for an object
   *
   * The backend deserializes from its native format to Delta[] internally.
   *
   * @param targetKey Target object key
   * @returns Stored delta with Delta[] instructions, or undefined if not a delta
   */
  loadDelta(targetKey: string): Promise<StoredDelta | undefined>;

  /**
   * Check if object is stored as delta
   *
   * @param targetKey Target object key
   * @returns True if object is stored as a delta
   */
  isDelta(targetKey: string): Promise<boolean>;

  /**
   * Remove delta relationship
   *
   * @param targetKey Target object key
   * @param keepAsBase If true, store full content; if false, remove entirely
   * @returns True if removed
   */
  removeDelta(targetKey: string, keepAsBase?: boolean): Promise<boolean>;

  /**
   * Get delta chain info for an object
   *
   * @param targetKey Target object key
   * @returns Chain details or undefined if not a delta
   */
  getDeltaChainInfo(targetKey: string): Promise<DeltaChainDetails | undefined>;

  /**
   * List all delta relationships
   *
   * @returns Async iterable of delta info (baseKey, targetKey)
   */
  listDeltas(): AsyncIterable<DeltaInfo>;

  /**
   * Load resolved object content from backing storage (optional)
   *
   * For pack-based implementations, loads the fully resolved
   * content (with delta resolution if needed) for any object
   * stored in packs, whether it's a delta or full object.
   *
   * @param key Object key
   * @returns Resolved content or undefined if not in backing storage
   */
  loadObject?(key: string): Promise<Uint8Array | undefined>;

  /**
   * Check if object exists in the delta store's backing storage (optional)
   *
   * For pack-based implementations, checks if an object exists
   * in any pack file, regardless of whether it's a delta or full object.
   *
   * @param key Object key
   * @returns True if object exists
   */
  hasObject?(key: string): Promise<boolean>;

  /**
   * Find all objects that depend on a base (optional)
   *
   * Returns target keys for which this base is used as a delta source.
   *
   * @param baseKey Base object key
   * @returns Array of dependent target keys
   */
  findDependents?(baseKey: string): Promise<string[]>;

  /**
   * Initialize the delta store (optional lifecycle)
   *
   * For pack-based implementations, loads pack index files.
   * Memory-based stores typically don't need initialization.
   */
  initialize?(): Promise<void>;

  /**
   * Close the delta store and release resources (optional lifecycle)
   *
   * For pack-based implementations, flushes caches and closes file handles.
   */
  close?(): Promise<void>;
}
