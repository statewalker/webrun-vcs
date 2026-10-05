/**
 * SimpleHistory - A simple History-like implementation for testing
 *
 * Wraps individual stores into a History-compatible interface.
 * Used for creating WorkingCopy instances in tests without a full storage backend.
 *
 * Note: This uses the new store interfaces (Blobs, Trees, etc.)
 * and is cast to History for use with MemoryWorkingCopy.
 */

import type {
  Blobs,
  Commits,
  GitObjectStore,
  ObjectId,
  Refs,
  SerializationApi,
  Tags,
  Trees,
} from "@statewalker/vcs-core";
import { DefaultSerializationApi } from "@statewalker/vcs-core";

/**
 * Options for creating a SimpleHistory
 */
export interface SimpleHistoryOptions {
  /** Object store for raw Git objects */
  objects: GitObjectStore;
  /** Blob storage */
  blobs: Blobs;
  /** Tree storage */
  trees: Trees;
  /** Commit storage */
  commits: Commits;
  /** Tag storage */
  tags: Tags;
  /** Reference storage */
  refs: Refs;
}

/**
 * Simple in-memory History-like implementation for testing.
 *
 * This class provides a History-compatible interface using new store types.
 * It should be cast to History when used with MemoryWorkingCopy.
 */
export class SimpleHistory {
  readonly objects: GitObjectStore;
  readonly blobs: Blobs;
  readonly trees: Trees;
  readonly commits: Commits;
  readonly tags: Tags;
  readonly refs: Refs;
  readonly serialization: SerializationApi;

  private _initialized = false;

  constructor(options: SimpleHistoryOptions) {
    this.objects = options.objects;
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.commits = options.commits;
    this.tags = options.tags;
    this.refs = options.refs;
    // Create serialization API for pack import/export operations
    // Cast this to History since DefaultSerializationApi expects History interface
    this.serialization = new DefaultSerializationApi({ history: this as any });
  }

  async initialize(): Promise<void> {
    if ("initialize" in this.refs && typeof this.refs.initialize === "function") {
      await this.refs.initialize();
    }
    this._initialized = true;
  }

  async close(): Promise<void> {
    // No resources to clean up
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Collect reachable objects for pack creation
   */
  async *collectReachableObjects(
    wants: Set<string>,
    exclude: Set<string>,
  ): AsyncIterable<ObjectId> {
    const seen = new Set<string>(exclude);
    const queue: string[] = [...wants];

    while (queue.length > 0) {
      const oid = queue.shift();
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);

      yield oid;

      // If it's a commit, add its tree and parents
      if (await this.commits.has(oid)) {
        const commit = await this.commits.load(oid);
        if (commit && !seen.has(commit.tree)) {
          queue.push(commit.tree);
        }
        if (commit) {
          for (const parent of commit.parents) {
            if (!seen.has(parent)) {
              queue.push(parent);
            }
          }
        }
      }

      // If it's a tree, add its entries
      if (await this.trees.has(oid)) {
        const treeEntries = await this.trees.load(oid);
        if (treeEntries) {
          for await (const entry of treeEntries) {
            if (!seen.has(entry.id)) {
              queue.push(entry.id);
            }
          }
        }
      }

      // If it's a tag, add its target
      if (await this.tags.has(oid)) {
        const tag = await this.tags.load(oid);
        if (tag && !seen.has(tag.object)) {
          queue.push(tag.object);
        }
      }
    }
  }
}

/**
 * Create a SimpleHistory from individual stores
 */
export function createSimpleHistory(options: SimpleHistoryOptions): SimpleHistory {
  return new SimpleHistory(options);
}
