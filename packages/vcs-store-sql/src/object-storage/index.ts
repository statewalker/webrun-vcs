/**
 * SQL-backed object storage with Git-compatible format
 *
 * Creates typed stores (BlobStore, TreeStore, CommitStore, TagStore)
 * that use Git-compatible serialization and SHA-1 hashing.
 */

import {
  type Blobs,
  type Commits,
  createBlobs,
  createCommits,
  createGitObjectStore,
  createTags,
  createTrees,
  type GitObjectStore,
  type Tags,
  type Trees,
} from "@statewalker/vcs-core";
import { SqlRawStore } from "../binary-storage/sql-raw-store.js";
import type { DatabaseClient } from "../database-client.js";

/**
 * Collection of SQL-backed object stores
 *
 * Uses new interface types (Blobs, Trees, Commits, Tags) for compatibility
 * with the History interface.
 */
export interface SqlObjectStores {
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
 * Options for creating SQL-backed object stores
 */
export interface CreateSqlObjectStoresOptions {
  /** Database client for SQL operations */
  db: DatabaseClient;
  /** Table name for raw objects (default: "raw_objects") */
  tableName?: string;
}

/**
 * Create SQL-backed object stores with Git-compatible format
 *
 * Uses the git-codec implementations from the vcs package to ensure
 * objects are serialized in Git format with correct SHA-1 IDs.
 *
 * @param options Configuration options
 * @returns Collection of typed object stores
 *
 * @example
 * ```typescript
 * const stores = createSqlObjectStores({
 *   db: sqliteClient,
 *   tableName: "git_objects"
 * });
 *
 * // Store a blob in Git format
 * const blobId = await stores.blobs.store(content);
 * ```
 */
export function createSqlObjectStores(options: CreateSqlObjectStoresOptions): SqlObjectStores {
  const { db, tableName = "raw_objects" } = options;

  // SqlRawStore implements RawStorage directly
  const storage = new SqlRawStore(db, tableName);
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
