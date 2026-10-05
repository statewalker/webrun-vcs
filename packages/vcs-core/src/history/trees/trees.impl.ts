/**
 * Git tree store implementation
 *
 * Wraps GitObjectStore with tree serialization/deserialization.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObjectStore } from "../objects/object-store.js";
import type { TreeEntry } from "./tree-entry.js";
import { decodeTreeEntries, EMPTY_TREE_ID, encodeTreeEntries } from "./tree-format.js";
import type { Trees } from "./trees.js";

/**
 * Git tree store implementation
 *
 * Handles tree entry serialization (sorting, binary format)
 * and delegates storage to GitObjectStore.
 */
class GitTreeStore implements Trees {
  constructor(private readonly objects: GitObjectStore) {}

  // ============ New Trees Interface ============

  /**
   * Store tree entries (new interface)
   */
  async store(entries: AsyncIterable<TreeEntry> | Iterable<TreeEntry>): Promise<ObjectId> {
    return this.objects.store("tree", encodeTreeEntries(entries));
  }

  /**
   * Load tree entries (new interface)
   *
   * Returns undefined if tree doesn't exist.
   */
  async load(id: ObjectId): Promise<AsyncIterable<TreeEntry> | undefined> {
    // Handle empty tree specially
    if (id === EMPTY_TREE_ID) {
      return emptyTreeEntries();
    }

    if (!(await this.has(id))) {
      return undefined;
    }

    // Return a new async iterable that wraps the loadTree method
    const self = this;
    return (async function* () {
      yield* self.loadTreeInternal(id);
    })();
  }

  /**
   * Remove tree (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    // Git objects are content-addressed and generally immutable
    // This is implemented for interface compliance but shouldn't be used in practice
    return this.objects.remove(id);
  }

  /**
   * Load tree entries as stream (internal implementation)
   *
   * Handles the well-known empty tree ID specially since it doesn't need
   * to be stored - it's a virtual constant representing an empty directory.
   */
  private async *loadTreeInternal(id: ObjectId): AsyncIterable<TreeEntry> {
    // Handle empty tree specially - no need to look it up in storage
    if (id === EMPTY_TREE_ID) {
      return;
    }

    const [header, content] = await this.objects.loadWithHeader(id);
    try {
      if (header.type !== "tree") {
        throw new Error(`Object ${id} is not a tree (found type: ${header.type})`);
      }
      yield* decodeTreeEntries(content);
    } catch (err) {
      content?.return?.(void 0);
      throw err;
    }
  }

  // ============ Common Methods ============

  /**
   * Get specific entry from tree
   */
  async getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined> {
    const entries = await this.load(treeId);
    if (!entries) return undefined;
    for await (const entry of entries) {
      if (entry.name === name) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Check if tree exists
   *
   * The empty tree is always considered to exist.
   */
  async has(id: ObjectId): Promise<boolean> {
    if (id === EMPTY_TREE_ID) {
      return true;
    }
    if (!(await this.objects.has(id))) {
      return false;
    }
    try {
      const header = await this.objects.getHeader(id);
      return header.type === "tree";
    } catch {
      return false;
    }
  }

  /**
   * Enumerate all tree object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await this.objects.getHeader(id);
        if (header.type === "tree") {
          yield id;
        }
      } catch {
        // Skip invalid objects
      }
    }
  }

  /**
   * Get well-known empty tree ID
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }
}

/**
 * Return an empty async iterable of tree entries.
 *
 * Extracted as a named function to prevent rolldown from optimizing
 * away `(async function* () {})()` to a bare `return;`.
 */
async function* emptyTreeEntries(): AsyncGenerator<TreeEntry> {
  // intentionally yields nothing
}

/**
 * Create a Trees instance backed by GitObjectStore
 *
 * @param objects GitObjectStore implementation to use for persistence
 * @returns Trees instance
 */
export function createTrees(objects: GitObjectStore): Trees {
  return new GitTreeStore(objects);
}
