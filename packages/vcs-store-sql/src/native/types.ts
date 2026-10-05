/**
 * Types for native SQL stores with query capabilities
 *
 * Native stores provide optimized relational storage with queryable fields
 * while still computing Git-compatible SHA-1 object IDs for interoperability.
 */

import type { Blobs, Commits, ObjectId, Tags, Trees } from "@statewalker/vcs-core";

/**
 * Extended CommitStore with SQL query capabilities
 *
 * Provides methods for querying commits by author, date range,
 * and commit ancestry using SQL's power for efficient lookups.
 */
export interface SqlNativeCommitStore extends Commits {
  /**
   * Find commits by author email
   *
   * @param email Author email to search for
   * @returns Async iterable of matching commit IDs (newest first)
   */
  findByAuthor(email: string): AsyncIterable<ObjectId>;

  /**
   * Find commits in a date range
   *
   * @param since Start of date range
   * @param until End of date range
   * @returns Async iterable of matching commit IDs (newest first)
   */
  findByDateRange(since: Date, until: Date): AsyncIterable<ObjectId>;

  /**
   * Get all ancestors of a commit using recursive CTE
   *
   * More efficient than walking the graph manually as it uses
   * a single SQL query with recursive CTE.
   *
   * @param id Commit ID to find ancestors for
   * @returns Async iterable of ancestor commit IDs
   */
  getAncestors(id: ObjectId): AsyncIterable<ObjectId>;

  /**
   * Get commit count in the store
   */
  count(): Promise<number>;

  /**
   * Search commits by message content
   *
   * Uses LIKE for case-insensitive substring matching on commit messages.
   *
   * @param pattern Substring to search for in message
   * @returns Async iterable of matching commit IDs (newest first)
   */
  searchMessage(pattern: string): AsyncIterable<ObjectId>;
}

/**
 * Extended TreeStore with SQL query capabilities
 *
 * Provides methods for finding trees containing specific blobs
 * and building file paths across the tree structure.
 */
export interface SqlNativeTreeStore extends Trees {
  /**
   * Find trees containing a specific blob
   *
   * @param blobId Blob object ID to search for
   * @returns Async iterable of tree IDs containing the blob
   */
  findTreesWithBlob(blobId: ObjectId): AsyncIterable<ObjectId>;

  /**
   * Find tree entries matching a name pattern
   *
   * Uses SQL LIKE pattern matching (% for any chars, _ for single char).
   *
   * @param namePattern LIKE pattern for entry name (e.g., "%.ts", "src%")
   * @returns Async iterable of matching entries with their tree IDs
   */
  findByNamePattern(
    namePattern: string,
  ): AsyncIterable<{ treeId: ObjectId; entry: { mode: number; name: string; id: ObjectId } }>;

  /**
   * Get tree count in the store
   */
  count(): Promise<number>;
}

/**
 * Extended BlobStore with SQL query capabilities
 */
export interface SqlNativeBlobStore extends Blobs {
  /**
   * Get blob count in the store
   */
  count(): Promise<number>;

  /**
   * Get total size of all blobs in the store
   */
  totalSize(): Promise<number>;
}

/**
 * Extended TagStore with SQL query capabilities
 */
export interface SqlNativeTagStore extends Tags {
  /**
   * Find tags by name pattern
   *
   * @param pattern LIKE pattern for tag name (e.g., "v1.%")
   * @returns Async iterable of matching tag IDs
   */
  findByNamePattern(pattern: string): AsyncIterable<ObjectId>;

  /**
   * Find tags by tagger email
   *
   * @param email Tagger email to search for
   * @returns Async iterable of matching tag IDs (newest first)
   */
  findByTagger(email: string): AsyncIterable<ObjectId>;

  /**
   * Find tags by target object type
   *
   * @param targetType Target object type code (1=commit, 2=tree, 3=blob, 4=tag)
   * @returns Async iterable of matching tag IDs
   */
  findByTargetType(targetType: number): AsyncIterable<ObjectId>;

  /**
   * Get tag count in the store
   */
  count(): Promise<number>;
}

/**
 * Collection of native SQL stores with query capabilities
 *
 * Provides structured SQL storage with extended query methods.
 * Unlike GitStores, these don't use the Git object format internally,
 * but still compute Git-compatible SHA-1 object IDs for interoperability.
 */
export interface SqlNativeStores {
  readonly commits: SqlNativeCommitStore;
  readonly trees: SqlNativeTreeStore;
  readonly blobs: SqlNativeBlobStore;
  readonly tags: SqlNativeTagStore;
}
