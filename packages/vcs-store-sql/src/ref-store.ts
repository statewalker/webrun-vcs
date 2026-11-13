/**
 * SQL-based RefStore implementation
 *
 * Stores Git references in a SQL database.
 */

import {
  type BatchOptions,
  type BatchResult,
  type ObjectId,
  planRefBatch,
  type Ref,
  type RefCommand,
  RefStorage,
  type Refs,
  type RefUpdateResult,
  type SymbolicRef,
} from "@statewalker/vcs-core";
import type { DatabaseClient } from "./database-client.js";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

/**
 * Database row type for ref queries
 */
interface RefRow {
  name: string;
  object_id: string | null;
  target: string | null;
  peeled_object_id: string | null;
  storage: string;
}

/**
 * SQL-based RefStore implementation.
 */
function rowToRef(row: RefRow): Ref | SymbolicRef {
  const storage = (row.storage as RefStorage) || RefStorage.LOOSE;
  if (row.target != null) {
    return { name: row.name, target: row.target, storage } as SymbolicRef;
  }
  return {
    name: row.name,
    objectId: row.object_id || undefined,
    storage,
    peeled: row.peeled_object_id != null,
    peeledObjectId: row.peeled_object_id || undefined,
  } as Ref;
}

export class SQLRefStore implements Refs {
  constructor(private db: DatabaseClient) {}

  /**
   * Interim: a single command through {@link compareAndSwap}; several commands
   * are refused as "not-atomic" until this store applies batches atomically.
   */
  /**
   * Apply all commands atomically, or none (see {@link Refs.batch}): the batch is
   * planned and written inside one transaction. Reflogs are not kept yet, so
   * `options` is ignored.
   */
  batch(commands: RefCommand[], _options?: BatchOptions): Promise<BatchResult> {
    return this.db.transaction(async (tx) => {
      const plan = await planRefBatch(commands, {
        read: async (name) => {
          const rows = await tx.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [name]);
          return rows[0] ? rowToRef(rows[0]) : undefined;
        },
        hasChildren: async (name) => {
          // Names below `name/` sort in [name/, name0): "0" follows "/" in byte order.
          const rows = await tx.query<{ name: string }>(
            "SELECT name FROM vcs_ref WHERE name >= ? AND name < ? LIMIT 1",
            [`${name}/`, `${name}0`],
          );
          return rows.length > 0;
        },
      });
      if (!plan.ok) return { ok: false, rejected: plan.rejected };
      const now = Date.now();
      for (const u of plan.updates) {
        if (u.newValue === null) {
          await tx.execute("DELETE FROM vcs_ref WHERE name = ?", [u.name]);
        } else {
          await tx.execute(
            `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
             VALUES (?, ?, NULL, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               object_id = excluded.object_id,
               target = NULL,
               peeled_object_id = NULL,
               updated_at = excluded.updated_at`,
            [u.name, u.newValue, RefStorage.LOOSE, now],
          );
        }
      }
      return { ok: true, rejected: [] };
    });
  }

  /**
   * Read a ref by exact name.
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    const refs = await this.db.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [refName]);
    return refs[0] ? rowToRef(refs[0]) : undefined;
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs).
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    let current = refName;
    let depth = 0;

    while (depth < MAX_SYMBOLIC_REF_DEPTH) {
      const refs = await this.db.query<RefRow>("SELECT * FROM vcs_ref WHERE name = ?", [current]);

      if (refs.length === 0) {
        return undefined;
      }

      const row = refs[0];

      if (row.target == null) {
        // Direct ref
        return {
          name: current,
          objectId: row.object_id || undefined,
          storage: (row.storage as RefStorage) || RefStorage.LOOSE,
          peeled: row.peeled_object_id != null,
          peeledObjectId: row.peeled_object_id || undefined,
        } as Ref;
      }

      // Follow symbolic ref
      current = row.target;
      depth++;
    }

    throw new Error(`Symbolic ref chain too deep (> ${MAX_SYMBOLIC_REF_DEPTH})`);
  }

  /**
   * Check if a ref exists.
   */
  async has(refName: string): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM vcs_ref WHERE name = ?",
      [refName],
    );
    return result[0].cnt > 0;
  }

  /**
   * List all refs matching a prefix.
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    let rows: RefRow[];

    if (prefix) {
      rows = await this.db.query<RefRow>("SELECT * FROM vcs_ref WHERE name LIKE ? ORDER BY name", [
        `${prefix}%`,
      ]);
    } else {
      rows = await this.db.query<RefRow>("SELECT * FROM vcs_ref ORDER BY name", []);
    }

    for (const row of rows) {
      const storage = (row.storage as RefStorage) || RefStorage.LOOSE;

      if (row.target != null) {
        yield {
          name: row.name,
          target: row.target,
          storage,
        } as SymbolicRef;
      } else {
        yield {
          name: row.name,
          objectId: row.object_id || undefined,
          storage,
          peeled: row.peeled_object_id != null,
          peeledObjectId: row.peeled_object_id || undefined,
        } as Ref;
      }
    }
  }

  /**
   * Set a ref to point to an object ID.
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         object_id = excluded.object_id,
         target = NULL,
         updated_at = excluded.updated_at`,
      [refName, objectId, RefStorage.LOOSE, now],
    );
  }

  /**
   * Set a symbolic ref.
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO vcs_ref (name, object_id, target, storage, updated_at)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         object_id = NULL,
         target = excluded.target,
         updated_at = excluded.updated_at`,
      [refName, target, RefStorage.LOOSE, now],
    );
  }

  /**
   * Remove a ref.
   */
  async remove(refName: string): Promise<boolean> {
    const result = await this.db.execute("DELETE FROM vcs_ref WHERE name = ?", [refName]);
    return result.changes > 0;
  }

  /**
   * Compare-and-swap update (for concurrent safety).
   */
  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const r = await this.batch([{ name: refName, old: expectedOld ?? null, new: newValue }]);
    if (r.ok) return { success: true, previousValue: expectedOld };
    return {
      success: false,
      previousValue: (await this.resolve(refName))?.objectId,
      errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
    };
  }

  /**
   * Initialize storage structure (no-op for SQL - handled by migrations).
   */
  async initialize(): Promise<void> {
    // Schema is created by migrations
  }

  /**
   * Perform implementation-specific optimizations.
   */
  async optimize(): Promise<void> {
    // Could run ANALYZE or VACUUM here if needed
    await this.db.execute("ANALYZE vcs_ref", []);
  }
}
