/**
 * SQL-based TreeDeltaApi implementation
 *
 * Stores structural tree deltas as entry-level changes (add/modify/delete)
 * in SQL tables. Uses two tables:
 * - `tree_delta`: header with target_id -> base_id mapping
 * - `tree_delta_entry`: individual change entries per delta
 *
 * This is more efficient than binary deltas for SQL backends that already
 * store tree entries in normalized form.
 */

import type {
  BlobDeltaChainInfo,
  DeltaCandidateSource,
  ObjectId,
  StreamingDeltaResult,
  TreeDeltaApi,
  TreeDeltaChange,
} from "@statewalker/vcs-core";
import { parseStructuralDelta } from "@statewalker/vcs-core";
import type { DatabaseClient } from "./database-client.js";

/**
 * SQL-based TreeDeltaApi implementation
 *
 * Tracks structural tree delta relationships in SQL tables with
 * entry-level change storage.
 */
export class SqlTreeDeltaApi implements TreeDeltaApi {
  private initialized = false;
  private readonly maxChainDepth = 50;

  constructor(private readonly db: DatabaseClient) {}

  /**
   * Ensure delta tables exist
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tree_delta (
        target_id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL
      )
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tree_delta_entry (
        target_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        name TEXT NOT NULL,
        mode INTEGER,
        object_id TEXT,
        PRIMARY KEY (target_id, name),
        FOREIGN KEY (target_id) REFERENCES tree_delta(target_id) ON DELETE CASCADE
      )
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS tree_delta_base_idx ON tree_delta(base_id)
    `);

    this.initialized = true;
  }

  /**
   * Find best delta candidate for a tree
   *
   * Delta computation is handled by DeltaEngine externally.
   * This API is for storage operations.
   */
  async findTreeDelta(
    _targetId: ObjectId,
    _candidates: DeltaCandidateSource,
  ): Promise<StreamingDeltaResult | null> {
    // Delta computation is handled by DeltaEngine externally
    return null;
  }

  /**
   * Store tree as structural delta of another tree
   *
   * Parses the serialized structural delta and stores each entry-level
   * change in the tree_delta_entry table.
   */
  async deltifyTree(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.ensureInitialized();

    // Collect and parse structural delta
    const chunks: Uint8Array[] = [];
    for await (const chunk of delta) {
      chunks.push(chunk);
    }
    const deltaBytes = concatBytes(chunks);
    const parsed = parseStructuralDelta(deltaBytes);

    await this.db.transaction(async (tx) => {
      // Insert delta header
      await tx.execute(`INSERT OR REPLACE INTO tree_delta (target_id, base_id) VALUES (?, ?)`, [
        targetId,
        parsed.baseTreeId || baseId,
      ]);

      // Delete old entries if replacing
      await tx.execute(`DELETE FROM tree_delta_entry WHERE target_id = ?`, [targetId]);

      // Insert change entries
      for (const change of parsed.changes) {
        await tx.execute(
          `INSERT INTO tree_delta_entry (target_id, change_type, name, mode, object_id) VALUES (?, ?, ?, ?, ?)`,
          [targetId, change.type, change.name, change.mode ?? null, change.objectId ?? null],
        );
      }
    });
  }

  /**
   * Remove tree delta (expand to full content)
   */
  async undeltifyTree(id: ObjectId): Promise<void> {
    await this.ensureInitialized();

    await this.db.transaction(async (tx) => {
      await tx.execute(`DELETE FROM tree_delta_entry WHERE target_id = ?`, [id]);
      await tx.execute(`DELETE FROM tree_delta WHERE target_id = ?`, [id]);
    });
  }

  /**
   * Check if tree is stored as delta
   */
  async isTreeDelta(id: ObjectId): Promise<boolean> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM tree_delta WHERE target_id = ?`,
      [id],
    );

    return rows[0].cnt > 0;
  }

  /**
   * Get delta chain information for a tree
   */
  async getTreeDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ base_id: string }>(
      `SELECT base_id FROM tree_delta WHERE target_id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;

    const baseIds: ObjectId[] = [rows[0].base_id];
    let currentId = rows[0].base_id;
    let depth = 1;

    while (depth < this.maxChainDepth) {
      const baseRows = await this.db.query<{ base_id: string }>(
        `SELECT base_id FROM tree_delta WHERE target_id = ?`,
        [currentId],
      );
      if (baseRows.length === 0) break;

      baseIds.push(baseRows[0].base_id);
      currentId = baseRows[0].base_id;
      depth++;
    }

    return { depth, totalSize: 0, baseIds };
  }

  /**
   * Load stored changes for a delta (for resolution by external code)
   *
   * Returns the base tree ID and the list of entry-level changes
   * that were stored for this delta.
   */
  async loadDeltaChanges(
    targetId: ObjectId,
  ): Promise<{ baseId: ObjectId; changes: TreeDeltaChange[] } | undefined> {
    await this.ensureInitialized();

    const deltaRows = await this.db.query<{ base_id: string }>(
      `SELECT base_id FROM tree_delta WHERE target_id = ?`,
      [targetId],
    );
    if (deltaRows.length === 0) return undefined;

    const entryRows = await this.db.query<{
      change_type: string;
      name: string;
      mode: number | null;
      object_id: string | null;
    }>(`SELECT change_type, name, mode, object_id FROM tree_delta_entry WHERE target_id = ?`, [
      targetId,
    ]);

    const changes: TreeDeltaChange[] = entryRows.map((row) => ({
      type: row.change_type as "add" | "modify" | "delete",
      name: row.name,
      mode: row.mode ?? undefined,
      objectId: row.object_id ?? undefined,
    }));

    return { baseId: deltaRows[0].base_id, changes };
  }
}

/**
 * Concatenate byte arrays
 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
