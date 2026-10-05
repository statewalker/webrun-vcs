/**
 * SQL-based TreeStore implementation
 *
 * Stores tree objects in a normalized SQL schema with separate
 * tables for trees and their entries. Uses positional indexing
 * for entry ordering.
 */

import type { ObjectId, Tree, TreeEntry, Trees } from "@statewalker/vcs-core";
import { computeTreeHash, FileMode } from "@statewalker/vcs-core";

import type { DatabaseClient } from "./database-client.js";

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
 * SQL-based TreeStore implementation.
 *
 * Uses normalized tables:
 * - tree: Tree metadata (id, tree_id, created_at)
 * - tree_entry: Individual entries (tree_fk, position, mode, name, object_id)
 */
export class SQLTreeStore implements Trees {
  constructor(private db: DatabaseClient) {}

  /**
   * Store a tree from a stream of entries.
   *
   * Entries are consumed, sorted canonically, and stored in the database.
   * Uses transaction to ensure atomicity.
   */
  async store(tree: Tree): Promise<ObjectId> {
    // Collect entries
    const entryArray: TreeEntry[] = [];
    const entries = tree;

    if (Symbol.asyncIterator in entries) {
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
    const existing = await this.db.query<{ id: number }>("SELECT id FROM tree WHERE tree_id = ?", [
      treeId,
    ]);

    if (existing.length > 0) {
      return treeId;
    }

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
   *
   * Entries are yielded in canonical sorted order (by position).
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
   * Check if tree exists.
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
   * Enumerate all tree object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    const trees = await this.db.query<{ tree_id: string }>("SELECT tree_id FROM tree");
    for (const row of trees) {
      yield row.tree_id;
    }
  }

  /**
   * Get the empty tree ObjectId.
   */
  getEmptyTreeId(): ObjectId {
    return EMPTY_TREE_ID;
  }
}
