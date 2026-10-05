/**
 * In-memory Trees implementation
 *
 * Provides a pure in-memory tree storage for testing and ephemeral operations.
 * No persistence - data is lost when the instance is garbage collected.
 *
 * Unlike file-based implementations, this does not use Git format serialization.
 * Trees are stored directly as JavaScript arrays for simplicity and performance.
 */

import type { ObjectId, Tree, TreeEntry, Trees } from "@statewalker/vcs-core";
import { computeTreeHash, FileMode } from "@statewalker/vcs-core";

/**
 * Well-known empty tree SHA-1 hash
 */
const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Compare tree entries for canonical Git sorting.
 *
 * Git sorts tree entries by name, treating directories as if they
 * had a trailing '/'. This ensures consistent hashing.
 */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === FileMode.TREE ? `${a.name}/` : a.name;
  const bName = b.mode === FileMode.TREE ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/**
 * In-memory Trees implementation.
 */
export class MemoryTreeStore implements Trees {
  private trees = new Map<ObjectId, TreeEntry[]>();

  /**
   * Store a tree from a stream of entries.
   *
   * Entries are consumed, sorted canonically, and stored.
   */
  async store(tree: Tree): Promise<ObjectId> {
    // Collect entries
    const entryArray: TreeEntry[] = [];

    if (Array.isArray(tree)) {
      for (const entry of tree) {
        entryArray.push({ ...entry });
      }
    } else if (Symbol.asyncIterator in tree) {
      for await (const entry of tree as AsyncIterable<TreeEntry>) {
        entryArray.push({ ...entry });
      }
    } else {
      for (const entry of tree as Iterable<TreeEntry>) {
        entryArray.push({ ...entry });
      }
    }

    // Empty tree has well-known hash
    if (entryArray.length === 0) {
      return EMPTY_TREE_ID;
    }

    // Sort entries canonically
    entryArray.sort(compareTreeEntries);

    // Compute hash
    const id = computeTreeHash(entryArray);

    // Store (deduplication by content)
    if (!this.trees.has(id)) {
      this.trees.set(id, entryArray);
    }

    return id;
  }

  /**
   * Load tree entries as a stream.
   *
   * Entries are yielded in canonical sorted order.
   *
   * @returns AsyncIterable of entries, or undefined if not found
   */
  async load(id: ObjectId): Promise<AsyncIterable<TreeEntry> | undefined> {
    // Empty tree
    if (id === EMPTY_TREE_ID) {
      return (async function* () {})();
    }

    const entries = this.trees.get(id);
    if (!entries) {
      return undefined;
    }

    const entriesCopy = entries.map((e) => ({ ...e }));
    return (async function* () {
      for (const entry of entriesCopy) {
        yield entry;
      }
    })();
  }

  /**
   * Remove a tree by ID.
   *
   * @returns True if removed, false if not found
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.trees.delete(id);
  }

  /**
   * Get a specific entry from a tree.
   *
   * @returns Entry if found, undefined if tree or entry not found
   */
  async getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined> {
    // Empty tree
    if (treeId === EMPTY_TREE_ID) {
      return undefined;
    }

    const entries = this.trees.get(treeId);
    if (!entries) {
      return undefined;
    }

    // Binary search would be more efficient for large trees,
    // but linear search is fine for typical use cases
    const found = entries.find((e) => e.name === name);
    return found ? { ...found } : undefined;
  }

  /**
   * Check if tree exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    // Empty tree always exists
    if (id === EMPTY_TREE_ID) {
      return true;
    }

    return this.trees.has(id);
  }

  /**
   * Enumerate all tree object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    for (const id of this.trees.keys()) {
      yield id;
    }
  }

  /**
   * Get the empty tree ObjectId.
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }
}
