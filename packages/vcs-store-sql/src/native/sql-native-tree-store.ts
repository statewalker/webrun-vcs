/**
 * Native SQL TreeStore with Git-compatible IDs and query capabilities
 *
 * Stores trees in normalized SQL tables while computing SHA-1 hashes
 * identical to native Git. Provides extended query methods for efficient
 * lookups by blob content.
 */

import {
  computeTreeSize,
  encodeObjectHeader,
  encodeTreeEntries,
  FileMode,
  type ObjectId,
  type Tree,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { bytesToHex, Sha1 } from "@statewalker/vcs-utils";
import type { DatabaseClient } from "../database-client.js";
import type { SqlNativeTreeStore } from "./types.js";

/**
 * Well-known empty tree SHA-1 hash
 */
const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Compare tree entries for canonical Git sorting
 */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === FileMode.TREE ? `${a.name}/` : a.name;
  const bName = b.mode === FileMode.TREE ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/**
 * Compute Git-compatible SHA-1 hash for a tree
 */
async function computeGitTreeId(entries: TreeEntry[]): Promise<ObjectId> {
  if (entries.length === 0) {
    return EMPTY_TREE_ID;
  }

  // Sort entries canonically
  const sorted = [...entries].sort(compareTreeEntries);

  const size = await computeTreeSize(sorted);

  const sha1 = new Sha1();
  sha1.update(encodeObjectHeader("tree", size));

  for await (const chunk of encodeTreeEntries(sorted)) {
    sha1.update(chunk);
  }

  return bytesToHex(sha1.finalize());
}

/**
 * Native SQL TreeStore implementation
 *
 * Uses normalized tables:
 * - tree: Tree metadata (id, tree_id, created_at)
 * - tree_entry: Individual entries (tree_fk, position, mode, name, object_id)
 *
 * Computes Git-compatible SHA-1 object IDs for interoperability.
 */
export class SqlNativeTreeStoreImpl implements SqlNativeTreeStore {
  constructor(private db: DatabaseClient) {}

  /**
   * Store a tree from a stream of entries
   */
  async store(tree: Tree): Promise<ObjectId> {
    // Collect entries
    const entryArray: TreeEntry[] = [];
    const entries = tree;

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

    // Compute Git-compatible hash
    const treeId = await computeGitTreeId(entryArray);

    // Empty tree has well-known hash and doesn't need storage
    if (treeId === EMPTY_TREE_ID) {
      return EMPTY_TREE_ID;
    }

    // Check if tree already exists (deduplication)
    const existing = await this.db.query<{ id: number }>("SELECT id FROM tree WHERE tree_id = ?", [
      treeId,
    ]);

    if (existing.length > 0) {
      return treeId;
    }

    // Sort entries canonically for storage
    entryArray.sort(compareTreeEntries);

    // Store tree and entries in a transaction
    await this.db.transaction(async (tx) => {
      const now = Date.now();
      const result = await tx.execute("INSERT INTO tree (tree_id, created_at) VALUES (?, ?)", [
        treeId,
        now,
      ]);

      const treeFk = result.lastInsertRowId;

      // Insert entries with position
      for (let i = 0; i < entryArray.length; i++) {
        const entry = entryArray[i];
        await tx.execute(
          "INSERT INTO tree_entry (tree_fk, position, mode, name, object_id) VALUES (?, ?, ?, ?, ?)",
          [treeFk, i, entry.mode, entry.name, entry.id],
        );
      }
    });

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

    // Get tree internal ID
    const trees = await this.db.query<{ id: number }>("SELECT id FROM tree WHERE tree_id = ?", [
      id,
    ]);

    if (trees.length === 0) {
      return undefined;
    }

    const treeFk = trees[0].id;
    const db = this.db;

    // Return async generator
    return (async function* () {
      // Load entries in order
      const entries = await db.query<{
        mode: number;
        name: string;
        object_id: string;
      }>("SELECT mode, name, object_id FROM tree_entry WHERE tree_fk = ? ORDER BY position", [
        treeFk,
      ]);

      for (const entry of entries) {
        yield {
          mode: entry.mode,
          name: entry.name,
          id: entry.object_id,
        };
      }
    })();
  }

  /**
   * Get a specific entry from a tree.
   * Returns undefined if tree not found or entry not found.
   */
  async getEntry(treeId: ObjectId, name: string): Promise<TreeEntry | undefined> {
    // Empty tree
    if (treeId === EMPTY_TREE_ID) {
      return undefined;
    }

    // Get tree internal ID
    const trees = await this.db.query<{ id: number }>("SELECT id FROM tree WHERE tree_id = ?", [
      treeId,
    ]);

    if (trees.length === 0) {
      return undefined;
    }

    const treeFk = trees[0].id;

    // Find entry by name
    const entries = await this.db.query<{
      mode: number;
      name: string;
      object_id: string;
    }>("SELECT mode, name, object_id FROM tree_entry WHERE tree_fk = ? AND name = ?", [
      treeFk,
      name,
    ]);

    if (entries.length === 0) {
      return undefined;
    }

    return {
      mode: entries[0].mode,
      name: entries[0].name,
      id: entries[0].object_id,
    };
  }

  /**
   * Check if tree exists
   */
  async has(id: ObjectId): Promise<boolean> {
    // Empty tree always exists
    if (id === EMPTY_TREE_ID) {
      return true;
    }

    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM tree WHERE tree_id = ?",
      [id],
    );

    return result[0].cnt > 0;
  }

  /**
   * Remove a tree by ID.
   * @returns True if removed, false if not found
   */
  async remove(id: ObjectId): Promise<boolean> {
    // Don't allow removing empty tree (it's virtual)
    if (id === EMPTY_TREE_ID) {
      return false;
    }

    // Get tree internal ID
    const trees = await this.db.query<{ id: number }>("SELECT id FROM tree WHERE tree_id = ?", [
      id,
    ]);

    if (trees.length === 0) {
      return false;
    }

    const treeFk = trees[0].id;

    await this.db.transaction(async (tx) => {
      // Delete entries first (foreign key)
      await tx.execute("DELETE FROM tree_entry WHERE tree_fk = ?", [treeFk]);
      // Delete the tree
      await tx.execute("DELETE FROM tree WHERE id = ?", [treeFk]);
    });

    return true;
  }

  /**
   * Enumerate all tree object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    const trees = await this.db.query<{ tree_id: string }>("SELECT tree_id FROM tree");
    for (const row of trees) {
      yield row.tree_id;
    }
  }

  /**
   * Get the empty tree ObjectId
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }

  // --- Extended query methods ---

  /**
   * Find trees containing a specific blob
   */
  async *findTreesWithBlob(blobId: ObjectId): AsyncIterable<ObjectId> {
    const rows = await this.db.query<{ tree_id: string }>(
      `SELECT DISTINCT t.tree_id FROM tree t
       INNER JOIN tree_entry te ON te.tree_fk = t.id
       WHERE te.object_id = ? AND te.mode != ?`,
      [blobId, FileMode.TREE],
    );

    for (const row of rows) {
      yield row.tree_id;
    }
  }

  /**
   * Get tree count
   */
  async count(): Promise<number> {
    const result = await this.db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM tree");
    return result[0].cnt;
  }

  /**
   * Find tree entries matching a name pattern
   *
   * Uses SQL LIKE pattern matching (% for any chars, _ for single char).
   *
   * @param namePattern LIKE pattern for entry name (e.g., "%.ts", "src%")
   * @returns Async iterable of matching entries with their tree IDs
   */
  async *findByNamePattern(
    namePattern: string,
  ): AsyncIterable<{ treeId: ObjectId; entry: { mode: number; name: string; id: ObjectId } }> {
    const rows = await this.db.query<{
      tree_id: string;
      mode: number;
      name: string;
      object_id: string;
    }>(
      `SELECT t.tree_id, te.mode, te.name, te.object_id FROM tree t
       INNER JOIN tree_entry te ON te.tree_fk = t.id
       WHERE te.name LIKE ?
       ORDER BY t.tree_id, te.name`,
      [namePattern],
    );

    for (const row of rows) {
      yield {
        treeId: row.tree_id,
        entry: {
          mode: row.mode,
          name: row.name,
          id: row.object_id,
        },
      };
    }
  }
}
