/**
 * Key-value backed object storage with Git-compatible IDs
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
} from "@statewalker/vcs-core";
import { KvRawStore } from "../binary-storage/index.js";
import type { KVStore } from "../kv-store.js";

/**
 * Collection of KV-backed object stores
 */
export interface KvObjectStores {
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
 * Options for creating KV-backed object stores
 */
export interface CreateKvObjectStoresOptions {
  /** KVStore for key-value operations */
  kv: KVStore;
  /** Optional prefix for keys (defaults to "objects:") */
  prefix?: string;
}

/**
 * Create KV-backed object stores with Git-compatible IDs
 *
 * Uses the git-codec implementations from the vcs package to ensure
 * object IDs are computed identically to native Git.
 *
 * @param options Configuration options
 * @returns Collection of typed object stores
 *
 * @example
 * ```typescript
 * const kv = new MemoryKVAdapter();
 * const stores = createKvObjectStores({ kv });
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
export function createKvObjectStores(options: CreateKvObjectStoresOptions): KvObjectStores {
  const { kv, prefix = "objects:" } = options;

  // KvRawStore implements RawStorage directly
  const storage = new KvRawStore(kv, prefix);
  const objects = createGitObjectStore(storage);

  return {
    objects,
    blobs: createBlobs(objects),
    trees: createTrees(objects),
    commits: createCommits(objects),
    tags: createTags(objects),
  };
}

// Re-export git stores for direct usage
export {
  createBlobs,
  createCommits,
  createGitObjectStore,
  createTags,
  createTrees,
  type GitObjectStore,
} from "@statewalker/vcs-core";
