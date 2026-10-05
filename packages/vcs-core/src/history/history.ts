/**
 * History - Immutable repository history (Part 1 of Three-Part Architecture)
 *
 * The History interface provides unified access to all stored objects:
 * - Blobs: File content
 * - Trees: Directory structures
 * - Commits: Version snapshots
 * - Tags: Annotated version markers
 * - Refs: Named pointers (branches, tags)
 *
 * History is:
 * - Immutable: Objects are content-addressed and never change
 * - Shared: Multiple working copies can share the same history
 * - Persistent: Survives application restarts
 *
 * History does NOT include:
 * - Staging area (belongs to Checkout)
 * - Working directory (belongs to Worktree)
 * - HEAD pointer (belongs to Checkout)
 *
 * @see HistoryWithOperations for advanced operations (GC, delta, serialization)
 */

import type { BackendCapabilities } from "../backend/storage-backend.js";
import type { ObjectId } from "../common/id/index.js";
import type { SerializationApi } from "../serialization/serialization-api.js";
import type { DeltaApi } from "../storage/delta/delta-api.js";
import type { Blobs } from "./blobs/blobs.js";
import type { Commits } from "./commits/commits.js";
import type { Refs } from "./refs/refs.js";
import type { Tags } from "./tags/tags.js";
import type { Trees } from "./trees/trees.js";

/**
 * History interface - read/write access to repository objects
 *
 * This is the primary interface for working with Git objects.
 * Use factory functions to create instances:
 * - createMemoryHistory() for testing
 * - createMemoryHistoryWithOperations() for testing with delta/serialization
 * - createGitFilesHistory() for production Git-files backend
 * - createHistoryFromStores() with explicit stores
 */
export interface History {
  /**
   * Blob (file content) storage
   *
   * Blobs are stored as raw content without Git headers for efficiency.
   * Content is addressed by SHA-1 hash computed with "blob <size>\0" prefix.
   */
  readonly blobs: Blobs;

  /**
   * Tree (directory structure) storage
   *
   * Trees list entries pointing to blobs (files) or other trees (directories).
   * Entries are stored in Git's canonical sorted order.
   */
  readonly trees: Trees;

  /**
   * Commit (version snapshot) storage
   *
   * Commits link a tree (content) to parent commits (history) with metadata.
   * Provides graph traversal methods for history operations.
   */
  readonly commits: Commits;

  /**
   * Tag (annotated tag) storage
   *
   * Annotated tags point to objects (usually commits) with metadata.
   * Lightweight tags are just refs and don't use this store.
   */
  readonly tags: Tags;

  /**
   * Reference (branch/tag pointer) storage
   *
   * Refs are named pointers (branches, tags, HEAD) to objects.
   * Supports both direct refs and symbolic refs.
   */
  readonly refs: Refs;

  /**
   * Initialize the history store
   *
   * Creates necessary structures for a new repository.
   * Safe to call on already-initialized repositories.
   */
  initialize(): Promise<void>;

  /**
   * Close the history store
   *
   * Releases resources and flushes any pending writes.
   * The store should not be used after calling close().
   */
  close(): Promise<void>;

  /**
   * Check if the history store is initialized
   *
   * @returns True if initialize() has been called
   */
  isInitialized(): boolean;

  /**
   * Collect all objects reachable from wants, excluding haves
   *
   * Used for pack creation during transport operations (fetch/push).
   * Traverses the object graph from commits through trees to blobs.
   *
   * @param wants - Object IDs to include (with all reachable objects)
   * @param exclude - Object IDs to exclude (already known by recipient)
   * @returns AsyncIterable of object IDs in traversal order
   *
   * @example
   * ```typescript
   * const wants = new Set(["abc123..."]); // commits to send
   * const haves = new Set(["def456..."]); // commits client already has
   *
   * const objects = history.collectReachableObjects(wants, haves);
   * for await (const oid of objects) {
   *   // Pack this object for transport
   * }
   * ```
   */
  collectReachableObjects(wants: Set<string>, exclude: Set<string>): AsyncIterable<ObjectId>;
}

/**
 * Extended History interface with storage operations
 *
 * Used for operations that need low-level storage access:
 * - Delta compression for storage optimization
 * - Serialization for pack files and transport
 * - Garbage collection for cleanup
 *
 * Most application code should use the plain History interface.
 *
 * @example
 * ```typescript
 * // Access delta API for GC
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, delta);
 * await history.delta.endBatch();
 *
 * // Access serialization API for transport
 * const pack = history.serialization.createPack(objectIds);
 *
 * // Check backend capabilities
 * if (history.capabilities.nativeBlobDeltas) {
 *   // Use native delta support
 * }
 * ```
 */
export interface HistoryWithOperations extends History {
  /**
   * Delta compression API for storage optimization
   *
   * Only blobs have delta support in internal storage.
   * Used for GC, repacking, and storage optimization.
   */
  readonly delta: DeltaApi;

  /**
   * Git-compatible serialization API
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
}
