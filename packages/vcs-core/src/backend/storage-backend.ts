/**
 * Storage Operations - Low-level storage APIs for optimization and transport
 *
 * This module provides the StorageOperations interface for delta compression
 * and Git-compatible serialization. These operations are NOT part of the main
 * History interface - they're for:
 *
 * 1. **DeltaApi** - Blob delta operations for storage optimization (GC, repacking)
 * 2. **SerializationApi** - Git-compatible wire format I/O (transport, interop)
 *
 * For typed access to Git objects, use the History interface:
 * ```typescript
 * import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
 * const history = createMemoryHistoryWithOperations();
 * const commit = await history.commits.load(commitId);
 * ```
 *
 * For storage operations, use HistoryWithOperations:
 * ```typescript
 * const history = createMemoryHistoryWithOperations();
 * // Delta operations
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, deltaStream);
 * await history.delta.endBatch();
 *
 * // Serialization operations
 * const pack = history.serialization.createPack(objectIds);
 * await history.serialization.importPack(receivedPackStream);
 * ```
 */

import type { SerializationApi } from "../serialization/serialization-api.js";
import type { DeltaApi } from "../storage/delta/delta-api.js";

// Re-export SerializationApi types for convenience
// Note: PackEntry and PackHeader are not re-exported to avoid conflicts
// with backend/git/pack types. Import from serialization-api directly if needed.
// Re-export serialization-specific types with qualified names to avoid ambiguity
export type {
  PackBuilder,
  PackBuildStats,
  PackEntry as SerializationPackEntry,
  PackHeader as SerializationPackHeader,
  PackImportResult,
  PackOptions,
  PackReaderApi,
  ParsedObjectMeta,
  SerializationApi,
} from "../serialization/serialization-api.js";

/**
 * Backend capability flags
 *
 * Describes what a backend can do natively vs. requiring emulation.
 * Used for optimization decisions and feature detection.
 */
export interface BackendCapabilities {
  /**
   * Can store blob deltas natively
   *
   * If true, blob deltas are stored as deltas.
   * If false, deltifyBlob() resolves to full content before storing.
   */
  nativeBlobDeltas: boolean;

  /**
   * Can store tree deltas natively
   *
   * If true, tree deltas are stored in backend-specific format.
   * Git-files: binary deltas. SQL/KV/memory: structural deltas.
   */
  nativeTreeDeltas: boolean;

  /**
   * Can store commit deltas natively
   *
   * If true, commit deltas are stored as binary deltas.
   */
  nativeCommitDeltas: boolean;

  /**
   * Supports random access reads
   *
   * If true, can efficiently read arbitrary byte ranges.
   * Required for efficient delta computation.
   */
  randomAccess: boolean;

  /**
   * Supports atomic batch operations
   *
   * If true, batch operations (startBatch/endBatch) are truly atomic.
   * If false, partial commits may occur on failure.
   */
  atomicBatch: boolean;

  /**
   * Already stores data in Git format
   *
   * If true, serialization is essentially a no-op (just read files).
   * If false, objects must be serialized/deserialized on I/O.
   */
  nativeGitFormat: boolean;
}

/**
 * Storage operations for optimization and transport
 *
 * This interface provides low-level storage operations that are NOT part
 * of the main History interface:
 * - Delta compression for storage optimization
 * - Serialization for pack file I/O and Git interoperability
 *
 * Unlike StorageBackend, this does not include typed stores (blobs, trees, etc.)
 * which are provided by the History interface instead.
 *
 * @example
 * ```typescript
 * // Use delta API for storage optimization
 * operations.delta.startBatch();
 * await operations.delta.blobs.deltifyBlob(blobId, baseId, deltaStream);
 * await operations.delta.endBatch();
 *
 * // Use serialization API for Git interop
 * const pack = operations.serialization.createPack(objectIds);
 * await operations.serialization.importPack(receivedPackStream);
 * ```
 */
export interface StorageOperations {
  /**
   * Delta/raw content manipulation
   *
   * Only blobs have delta support in internal storage.
   * Used for GC, repacking, and storage optimization.
   */
  readonly delta: DeltaApi;

  /**
   * Git-compatible serialization
   *
   * For pack file creation/parsing and loose object I/O.
   * Used for transport (fetch/push) and Git interoperability.
   */
  readonly serialization: SerializationApi;

  /**
   * Backend capabilities
   *
   * Describes what this backend supports natively.
   * Used for optimization and feature detection.
   */
  readonly capabilities: BackendCapabilities;

  /**
   * Initialize the storage operations
   *
   * Must be called before using any API.
   * Creates storage structures if needed and configured.
   *
   * @throws Error if initialization fails
   */
  initialize(): Promise<void>;

  /**
   * Close the storage operations
   *
   * Releases resources, flushes pending writes.
   * Should not be used after close().
   */
  close(): Promise<void>;
}
