/**
 * Factory functions for creating History instances
 *
 * Recommended patterns (from history-backend-factory.ts):
 * - createHistory(type, config): Create from registered backend type
 * - createGitFilesHistory(config): Git-files backed storage
 * - createMemoryHistoryWithOperations(): In-memory with operations
 *
 * Additional patterns in this module:
 * - createHistoryFromStores(): Compose from explicit store instances
 * - createMemoryHistory(): Basic in-memory (without operations)
 */

import {
  GitFilesDeltaApi,
  type GitFilesStorageBackendConfig,
} from "../backend/git-files-storage-backend.js";
import type {
  GitFilesBackendConfig,
  MemoryBackendConfig,
} from "../backend/history-backend-factory.js";
import { MemoryDeltaApi } from "../backend/memory-storage-backend.js";
import type { BackendCapabilities } from "../backend/storage-backend.js";
import { DefaultSerializationApi } from "../serialization/serialization-api.impl.js";
import { MemoryRawStorage } from "../storage/raw/memory-raw-storage.js";
import { createBlobs } from "./blobs/blobs.impl.js";
import type { Blobs } from "./blobs/blobs.js";
import { createCommits } from "./commits/commits.impl.js";
import type { Commits } from "./commits/commits.js";
import { HistoryImpl, HistoryWithOperationsImpl } from "./history.impl.js";
import type { History, HistoryWithOperations } from "./history.js";
import { createGitObjectStore } from "./objects/index.js";
import type { GitObjectStore } from "./objects/object-store.js";
import type { RefStore } from "./refs/ref-store.js";
import { createMemoryRefs, createRefsAdapter } from "./refs/refs.impl.js";
import type { Refs } from "./refs/refs.js";
import { createTags } from "./tags/tags.impl.js";
import type { Tags } from "./tags/tags.js";
import { createTrees } from "./trees/trees.impl.js";
import type { Trees } from "./trees/trees.js";

/**
 * Configuration for creating History with explicit stores
 */
export interface HistoryStoresConfig {
  /** Blob (file content) storage */
  blobs: Blobs;
  /** Tree (directory structure) storage */
  trees: Trees;
  /** Commit (version snapshot) storage */
  commits: Commits;
  /** Tag (annotated tag) storage */
  tags: Tags;
  /** Reference (branch/tag pointer) storage */
  refs: Refs;
}

/**
 * Configuration for creating History from low-level components
 */
export interface HistoryComponentsConfig {
  /**
   * Git object store for structured types
   *
   * Trees, commits, and tags are stored as Git objects with
   * headers for transport compatibility.
   */
  objects: GitObjectStore;

  /**
   * Refs configuration
   *
   * Either use in-memory refs (for testing) or adapt an existing
   * RefStore implementation.
   */
  refs: { type: "memory" } | { type: "adapter"; refStore: RefStore };
}

/**
 * Create History from explicit store instances
 *
 * Use this when you have already-constructed store instances and want
 * to compose them into a History facade.
 *
 * @param config Store instances to compose
 * @returns History instance
 *
 * @example
 * ```typescript
 * const history = createHistoryFromStores({
 *   blobs: myBlobsImpl,
 *   trees: myTreesImpl,
 *   commits: myCommitsImpl,
 *   tags: myTagsImpl,
 *   refs: myRefsImpl,
 * });
 * ```
 */
export function createHistoryFromStores(config: HistoryStoresConfig): History {
  return new HistoryImpl(config.blobs, config.trees, config.commits, config.tags, config.refs);
}

/**
 * Create History from component configurations
 *
 * Builds store instances from lower-level components.
 * Use this when you have raw storage and want to construct stores.
 *
 * @param config Component configuration
 * @returns History instance
 *
 * @example
 * ```typescript
 * const history = createHistoryFromComponents({
 *   objects: createGitObjectStore(new MemoryRawStorage()),
 *   refs: { type: "memory" },
 * });
 * ```
 */
export function createHistoryFromComponents(config: HistoryComponentsConfig): History {
  const blobs = createBlobs(config.objects);
  const trees = createTrees(config.objects);
  const commits = createCommits(config.objects);
  const tags = createTags(config.objects);

  let refs: Refs;
  if (config.refs.type === "memory") {
    refs = createMemoryRefs();
  } else {
    refs = createRefsAdapter(config.refs.refStore);
  }
  return createHistoryFromStores({
    blobs,
    trees,
    commits,
    tags,
    refs,
  });
}

/**
 * Create in-memory History for testing
 *
 * Creates a completely in-memory History instance that can be used for
 * unit tests, integration tests, or any scenario where persistence
 * is not needed.
 *
 * @returns History instance with in-memory storage
 *
 * @example
 * ```typescript
 * const history = createMemoryHistory();
 * await history.initialize();
 *
 * const id = await history.blobs.store([new TextEncoder().encode("test")]);
 * const content = await history.blobs.load(id);
 *
 * await history.close();
 * ```
 */
export function createMemoryHistory(): History {
  const objectStorage = new MemoryRawStorage();
  const objects = createGitObjectStore(objectStorage);
  return createHistoryFromComponents({
    objects,
    refs: { type: "memory" },
  });
}

/**
 * Create in-memory History with full operations support
 *
 * Returns HistoryWithOperations backed by in-memory storage,
 * suitable for testing and ephemeral operations that need
 * delta compression or serialization APIs.
 *
 * @param config Optional configuration
 * @returns HistoryWithOperations instance with in-memory storage
 *
 * @example
 * ```typescript
 * const history = createMemoryHistoryWithOperations();
 * await history.initialize();
 *
 * // Use history for normal operations
 * const id = await history.blobs.store([new TextEncoder().encode("test")]);
 *
 * // Use delta API for storage optimization
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(targetId, baseId, delta);
 * await history.delta.endBatch();
 *
 * // Use serialization for pack files
 * const pack = history.serialization.createPack(objectIds);
 *
 * await history.close();
 * ```
 */
export function createMemoryHistoryWithOperations(
  _config: MemoryBackendConfig = {},
): HistoryWithOperations {
  // Create memory object storage for trees, commits, tags
  const objectStorage = new MemoryRawStorage();
  const objects = createGitObjectStore(objectStorage);

  // Create typed stores using new interfaces
  const blobs = createBlobs(objects);
  const trees = createTrees(objects);
  const commits = createCommits(objects);
  const tags = createTags(objects);
  const refs = createMemoryRefs();

  // Create base History for serialization API
  const history = new HistoryImpl(blobs, trees, commits, tags, refs);

  // Create delta API (memory backend doesn't track blob deltas, but supports tree deltas)
  const delta = new MemoryDeltaApi(blobs, undefined, trees);

  // Create serialization API using the History interface
  const serialization = new DefaultSerializationApi({
    history,
    treeDeltaApi: delta.trees,
  });

  // Memory backend capabilities
  const capabilities: BackendCapabilities = {
    nativeBlobDeltas: false,
    nativeTreeDeltas: true,
    nativeCommitDeltas: false,
    randomAccess: true,
    atomicBatch: false,
    nativeGitFormat: false,
  };

  // Create HistoryWithOperations directly (no adapters needed)
  return new HistoryWithOperationsImpl(
    blobs,
    trees,
    commits,
    tags,
    refs,
    delta,
    serialization,
    capabilities,
    async () => {
      // No initialization needed for memory storage
    },
    async () => {
      // No cleanup needed for memory storage
    },
  );
}

/**
 * Create Git-files backed History with full operations support
 *
 * Factory function that creates HistoryWithOperations directly from
 * GitFilesStorageBackend configuration. This is the recommended way
 * to create production Git-compatible storage.
 *
 * Note: This requires the stores (blobs, trees, commits, tags, refs, packDeltaStore)
 * to be provided. For file-system-based stores, use @statewalker/vcs-store-fs
 * which provides createGitFilesBackend() that sets up all components.
 *
 * @param config GitFilesStorageBackend configuration with all stores
 * @returns HistoryWithOperations instance
 *
 * @example
 * ```typescript
 * // With pre-created stores (typical for Node.js environments)
 * const history = createGitFilesHistory({
 *   blobs: myBlobStore,
 *   trees: myTreeStore,
 *   commits: myCommitStore,
 *   tags: myTagStore,
 *   refs: myRefStore,
 *   packDeltaStore: myDeltaStore,
 * });
 * await history.initialize();
 *
 * // Use history for normal operations
 * const commit = await history.commits.load(commitId);
 *
 * // Use delta API for GC
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, delta);
 * await history.delta.endBatch();
 * ```
 */
export function createGitFilesHistory(config: GitFilesStorageBackendConfig): HistoryWithOperations {
  const { blobs, trees, commits, tags, refs, packDeltaStore } = config;

  // Create delta API directly (with tree and commit delta support)
  const delta = new GitFilesDeltaApi(packDeltaStore, blobs, trees, { enableCommitDeltas: true });

  // Create base History for serialization API
  const history = new HistoryImpl(blobs, trees, commits, tags, refs);
  const serialization = new DefaultSerializationApi({
    history,
    blobDeltaApi: delta.blobs,
    treeDeltaApi: delta.trees,
    commitDeltaApi: delta.commits,
  });

  // Git-files backend capabilities
  const capabilities: BackendCapabilities = {
    nativeBlobDeltas: true,
    nativeTreeDeltas: true,
    nativeCommitDeltas: true,
    randomAccess: true,
    atomicBatch: true,
    nativeGitFormat: true,
  };

  let initialized = false;

  return new HistoryWithOperationsImpl(
    blobs,
    trees,
    commits,
    tags,
    refs,
    delta,
    serialization,
    capabilities,
    async () => {
      if (!initialized) {
        await packDeltaStore.initialize?.();
        initialized = true;
      }
    },
    async () => {
      if (initialized) {
        await packDeltaStore.close?.();
        initialized = false;
      }
    },
  );
}

/**
 * Configuration for simplified Git-files history creation
 *
 * Used with registerGitFilesHistoryFactory() to enable
 * createHistory("git-files", config) pattern.
 */
export interface GitFilesHistoryConfig extends GitFilesBackendConfig {
  // Inherits path, create, readOnly from GitFilesBackendConfig
}
