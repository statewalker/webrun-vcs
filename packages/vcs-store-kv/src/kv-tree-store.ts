/**
 * KV-based Trees implementation
 *
 * Stores tree objects using a key-value backend with JSON serialization.
 */

import type { ObjectId, Tree, TreeEntry, Trees } from "@statewalker/vcs-core";
import { computeTreeHash, FileMode } from "@statewalker/vcs-core";

import type { KVStore } from "./kv-store.js";

/**
 * Well-known empty tree SHA-1 hash
 */
const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Key prefix for tree data
 */
const TREE_PREFIX = "tree:";

/**
 * Serialized tree entry format
 */
interface SerializedEntry {
  m: number; // mode
  n: string; // name
  i: string; // id
}

/**
 * Compare tree entries for canonical Git sorting.
 */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === FileMode.TREE ? `${a.name}/` : a.name;
  const bName = b.mode === FileMode.TREE ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/**
 * Text encoder/decoder for JSON serialization
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * KV-based Trees implementation.
 */
export class KVTreeStore implements Trees {
  constructor(private kv: KVStore) {}

  /**
   * Store a tree from a stream of entries.
   */
  async store(entries: Tree): Promise<ObjectId> {
    // Collect entries
    const entryArray: TreeEntry[] = [];

    // Handle array input
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        entryArray.push({ mode: entry.mode, name: entry.name, id: entry.id });
      }
    } else if (Symbol.asyncIterator in entries) {
      for await (const entry of entries as AsyncIterable<TreeEntry>) {
        entryArray.push({ mode: entry.mode, name: entry.name, id: entry.id });
      }
    } else {
      for (const entry of entries as Iterable<TreeEntry>) {
        entryArray.push({ mode: entry.mode, name: entry.name, id: entry.id });
      }
    }

    // Empty tree has well-known hash
    if (entryArray.length === 0) {
      return EMPTY_TREE_ID;
    }

    // Sort entries canonically
    entryArray.sort(compareTreeEntries);

    // Compute hash
    const treeId = computeTreeHash(entryArray);

    // Check if tree already exists (deduplication)
    if (await this.kv.has(`${TREE_PREFIX}${treeId}`)) {
      return treeId;
    }

    // Serialize and store
    const serialized: SerializedEntry[] = entryArray.map((e) => ({
      m: e.mode,
      n: e.name,
      i: e.id,
    }));

    await this.kv.set(`${TREE_PREFIX}${treeId}`, encoder.encode(JSON.stringify(serialized)));

    return treeId;
  }

  /**
   * Load tree entries as a stream.
   * Returns undefined if not found (new API behavior).
   */
  async load(id: ObjectId): Promise<AsyncIterable<TreeEntry> | undefined> {
    // Empty tree
    if (id === EMPTY_TREE_ID) {
      return (async function* () {})();
    }

    const data = await this.kv.get(`${TREE_PREFIX}${id}`);
    if (!data) {
      return undefined;
    }

    const serialized: SerializedEntry[] = JSON.parse(decoder.decode(data));

    return (async function* () {
      for (const entry of serialized) {
        yield {
          mode: entry.m,
          name: entry.n,
          id: entry.i,
        };
      }
    })();
  }

  /**
   * Remove a tree object by ID.
   */
  async remove(id: ObjectId): Promise<boolean> {
    // Don't allow removing empty tree (it's virtual)
    if (id === EMPTY_TREE_ID) {
      return false;
    }
    return this.kv.delete(`${TREE_PREFIX}${id}`);
  }

  /**
   * Get a specific entry from a tree.
   * Returns undefined if tree doesn't exist or entry not found.
   */
  async getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined> {
    // Empty tree
    if (treeId === EMPTY_TREE_ID) {
      return undefined;
    }

    const data = await this.kv.get(`${TREE_PREFIX}${treeId}`);
    if (!data) {
      return undefined;
    }

    const serialized: SerializedEntry[] = JSON.parse(decoder.decode(data));
    const found = serialized.find((e) => e.n === name);

    return found
      ? {
          mode: found.m,
          name: found.n,
          id: found.i,
        }
      : undefined;
  }

  /**
   * Check if tree exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    // Empty tree always exists
    if (id === EMPTY_TREE_ID) {
      return true;
    }

    return this.kv.has(`${TREE_PREFIX}${id}`);
  }

  /**
   * Enumerate all tree object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const key of this.kv.list(TREE_PREFIX)) {
      yield key.slice(TREE_PREFIX.length);
    }
  }

  /**
   * Get the empty tree ObjectId.
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }

  // --- Extended query methods (O(n) scans) ---

  /**
   * Find trees containing a specific blob
   *
   * Note: This is an O(n) scan through all trees. For better performance,
   * use SQL-backed storage instead.
   *
   * @param blobId Blob object ID to search for
   * @returns Async iterable of tree IDs containing the blob
   */
  async *findTreesWithBlob(blobId: ObjectId): AsyncIterable<ObjectId> {
    for await (const treeId of this.keys()) {
      const entries = await this.load(treeId);
      if (!entries) continue;

      for await (const entry of entries) {
        if (entry.id === blobId && entry.mode !== FileMode.TREE) {
          yield treeId;
          break; // Found in this tree, move to next
        }
      }
    }
  }

  /**
   * Find tree entries matching a name pattern
   *
   * Note: This is an O(n) scan through all trees. For better performance,
   * use SQL-backed storage instead.
   *
   * @param namePattern Pattern to match (supports * and ? wildcards)
   * @returns Async iterable of matching entries with their tree IDs
   */
  async *findByNamePattern(
    namePattern: string,
  ): AsyncIterable<{ treeId: ObjectId; entry: { mode: number; name: string; id: ObjectId } }> {
    // Convert simple wildcards to regex
    const regexPattern = namePattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`, "i");

    for await (const treeId of this.keys()) {
      const entries = await this.load(treeId);
      if (!entries) continue;

      for await (const entry of entries) {
        if (regex.test(entry.name)) {
          yield {
            treeId,
            entry: {
              mode: entry.mode,
              name: entry.name,
              id: entry.id,
            },
          };
        }
      }
    }
  }

  /**
   * Get tree count
   */
  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this.keys()) {
      count++;
    }
    return count;
  }
}
