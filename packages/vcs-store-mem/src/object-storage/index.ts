/**
 * Memory-backed object storage with Git-compatible IDs
 *
 * Creates typed stores that compute Git-compatible SHA-1 object IDs
 * using the Git implementations from the vcs package.
 */

import type { Blobs, Commits, Tags, Trees } from "@statewalker/vcs-core";
import {
  createBlobs,
  createCommits,
  createGitObjectStore,
  createTags,
  createTrees,
  type GitObjectStore,
  MemoryRawStorage,
} from "@statewalker/vcs-core";

/**
 * Collection of memory-backed object stores
 */
export interface MemoryObjectStores {
  /** Low-level Git object store */
  objects: GitObjectStore;
  /** Blob (file content) store */
  blobs: Blobs;
  /** Tree (directory) store */
  trees: Trees;
  /** Commit store */
  commits: Commits;
  /** Tag store */
  tags: Tags;
}

/**
 * Options for creating memory object stores
 */
export interface CreateMemoryObjectStoresOptions {
  /**
   * Optional RawStorage to use for persistence
   * If not provided, a new MemoryRawStorage is created
   */
  storage?: MemoryRawStorage;
}

/**
 * Create memory-backed object stores with Git-compatible IDs
 *
 * Uses the git-codec implementations from the vcs package to ensure
 * object IDs are computed identically to native Git.
 *
 * @param options Configuration options
 * @returns Collection of typed object stores
 *
 * @example
 * ```typescript
 * const stores = createMemoryObjectStores();
 *
 * // Store a blob
 * const blobId = await stores.blobs.store(content);
 *
 * // Store a commit
 * const commitId = await stores.commits.store({
 *   tree: treeId,
 *   parents: [],
 *   author: { name: "Test", email: "test@test.com", timestamp: 123, tzOffset: "+0000" },
 *   committer: { name: "Test", email: "test@test.com", timestamp: 123, tzOffset: "+0000" },
 *   message: "Initial commit"
 * });
 * ```
 */
export function createMemoryObjectStores(
  options: CreateMemoryObjectStoresOptions = {},
): MemoryObjectStores {
  const storage = options.storage ?? new MemoryRawStorage();
  const objects = createGitObjectStore(storage);

  return {
    objects,
    blobs: createBlobs(objects),
    trees: createTrees(objects),
    commits: createCommits(objects),
    tags: createTags(objects),
  };
}
