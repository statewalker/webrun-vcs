/**
 * Trees - New interface for tree (directory) storage
 *
 * This is the new interface with bare naming convention (Trees instead of TreeStore)
 * and consistent method names (remove instead of delete).
 */

import type { ObjectId } from "../../common/index.js";
import type { ObjectStorage } from "../objects/index.js";
import type { TreeEntry } from "./tree-entry.js";

/**
 * Tree structure - a list of entries representing a directory
 *
 * Trees are stored as Git-compatible sorted entry lists.
 * Represented as either an array (for convenience) or an async iterable (for streaming).
 */
export type Tree = TreeEntry[] | AsyncIterable<TreeEntry> | Iterable<TreeEntry>;

/**
 * Tree object store for directory structures
 *
 * Trees represent directory structures as a list of entries,
 * each pointing to a blob (file) or another tree (subdirectory).
 */
export interface Trees extends ObjectStorage<Tree> {
  /**
   * Store a tree
   *
   * Entries are consumed, sorted canonically, and stored.
   * Entries can be provided in any order - they will be sorted before storage.
   *
   * @param tree Tree entries (any order)
   * @returns ObjectId of the stored tree
   */
  store(tree: Tree): Promise<ObjectId>;

  /**
   * Load tree entries
   *
   * Returns entries in canonical sorted order (as stored in Git).
   *
   * @param id Tree object ID
   * @returns AsyncIterable of tree entries in sorted order, or undefined if not found
   */
  load(id: ObjectId): Promise<AsyncIterable<TreeEntry> | undefined>;

  /**
   * Check if a tree exists
   *
   * @param id Tree object ID
   * @returns True if tree exists
   */
  has(id: ObjectId): Promise<boolean>;

  /**
   * Get a single entry from a tree by name
   *
   * Convenience method to avoid loading the entire tree when
   * only one entry is needed.
   *
   * @param treeId Tree object ID
   * @param name Entry name to look up
   * @returns Entry if found, undefined otherwise
   */
  getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined>;

  /**
   * Get the well-known empty tree ID
   *
   * The empty tree has a fixed SHA-1 hash that can be computed
   * without storing anything. Useful for initial commits.
   *
   * @returns SHA-1 of the empty tree (4b825dc...)
   */
  getEmptyTreeId(): ObjectId;
}

/**
 * Extended queries for native Trees implementations
 *
 * These methods are optional and only available in implementations
 * that support advanced queries (e.g., SQL with indexes).
 */
export interface TreesExtended extends Trees {
  /**
   * Find trees containing entries matching a path pattern
   *
   * @param pathPattern Glob-like pattern (e.g., "*.ts", "src/**")
   * @returns AsyncIterable of matching entries with their tree IDs
   */
  findByPath?(pathPattern: string): AsyncIterable<{
    treeId: ObjectId;
    entry: TreeEntry;
  }>;
}
