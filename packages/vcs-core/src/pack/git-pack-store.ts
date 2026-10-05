/**
 * Pack-based object storage with RawStorage interface
 *
 * GitPackStore provides efficient storage for Git objects using pack files.
 * Objects are written to a pending buffer and periodically flushed to disk
 * as complete pack files with indexes.
 *
 * Key features:
 * - Reads from multiple pack files via PackDirectory
 * - Writes to pending pack with configurable auto-flush
 * - Supports atomic batch operations
 * - Optional fallback to loose object storage
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/ObjectDirectory.java
 */

import type { RawStorage } from "../storage/raw/index.js";

/**
 * Configuration for GitPackStore
 */
export interface GitPackStoreConfig {
  /** Maximum pending objects before auto-flush (default: 100) */
  maxPendingObjects?: number;

  /** Maximum pending bytes before auto-flush (default: 10MB) */
  maxPendingBytes?: number;

  /** Optional loose object storage for fallback/hybrid storage */
  looseStorage?: RawStorage;

  /**
   * Whether to prefer writing to pack immediately (default: true)
   *
   * If true, objects go to pending pack buffer.
   * If false, objects go to looseStorage (requires looseStorage to be set).
   */
  packImmediately?: boolean;
}

/**
 * Statistics about pack storage
 */
export interface PackStoreStats {
  /** Number of pack files on disk */
  packCount: number;

  /** Total objects across all packs */
  totalPackedObjects: number;

  /** Objects in pending buffer (not yet flushed) */
  pendingObjects: number;

  /** Bytes in pending buffer (approximate, uncompressed) */
  pendingBytes: number;

  /** Per-pack statistics */
  packs: Array<{ name: string; objects: number }>;
}

/**
 * Result of flushing pending objects
 */
export interface FlushResult {
  /** Pack file name (without path or extension) */
  packName: string;

  /** Object IDs written to the pack */
  objectIds: string[];

  /** Number of objects written */
  objectCount: number;
}

/**
 * Pack-based object storage implementing RawStorage
 *
 * Provides efficient storage for Git objects by:
 * - Reading from multiple pack files with LRU caching
 * - Buffering writes and flushing to pack files at thresholds
 * - Supporting optional loose object fallback
 *
 * Usage:
 * ```typescript
 * const store = createGitPackStore(files, packPath, {
 *   maxPendingObjects: 100,
 *   maxPendingBytes: 10 * 1024 * 1024,
 * });
 *
 * await store.initialize();
 * await store.store("abc123...", [content]);
 * await store.flush(); // Write pending pack to disk
 * await store.close();
 * ```
 */
export interface GitPackStore extends RawStorage {
  /**
   * Initialize the pack store
   *
   * Ensures pack directory exists and scans for existing pack files.
   * Must be called before other operations.
   */
  initialize(): Promise<void>;

  /**
   * Flush pending objects to a new pack file
   *
   * Creates a new pack file and index from all pending objects.
   * After flush, the pending buffer is empty.
   *
   * Returns empty result if no pending objects.
   *
   * @returns Flush result with pack name and object IDs
   */
  flush(): Promise<FlushResult>;

  /**
   * Check if there are pending objects to flush
   */
  hasPending(): boolean;

  /**
   * Get current storage statistics
   */
  getStats(): Promise<PackStoreStats>;

  /**
   * Refresh pack directory (re-scan for new/removed pack files)
   *
   * Call this after external changes to the pack directory
   * (e.g., after GC or external pack operations).
   */
  refresh(): Promise<void>;

  /**
   * Close the store and release resources
   *
   * Automatically flushes pending objects before closing.
   * After close(), no other methods should be called.
   */
  close(): Promise<void>;
}
