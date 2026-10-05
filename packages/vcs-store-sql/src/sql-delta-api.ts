/**
 * SQL-based DeltaApi implementation
 *
 * Implements the DeltaApi and BlobDeltaApi interfaces from vcs-core
 * using SQL database for storage.
 */

import type {
  BlobDeltaApi,
  BlobDeltaChainInfo,
  DeltaApi,
  ObjectId,
  StorageDeltaRelationship,
  StreamingDeltaResult,
} from "@statewalker/vcs-core";
import type { DatabaseClient } from "./database-client.js";
import { SqlTreeDeltaApi } from "./sql-tree-delta-api.js";

/**
 * SQL-based BlobDeltaApi implementation
 *
 * Tracks delta relationships in a SQL table with depth tracking.
 */
class SqlBlobDeltaApi implements BlobDeltaApi {
  private readonly tableName = "blob_delta";
  private initialized = false;
  private readonly maxChainDepth = 50;

  constructor(private readonly db: DatabaseClient) {}

  /**
   * Ensure delta table exists
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        target_id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        delta_data BLOB NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1,
        ratio REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_base_idx ON ${this.tableName}(base_id)
    `);

    this.initialized = true;
  }

  /**
   * Find best delta candidate for a blob
   *
   * Delta computation is handled by DeltaEngine externally.
   * This API is for storage operations.
   */
  async findBlobDelta(
    _targetId: ObjectId,
    _candidates: AsyncIterable<ObjectId>,
  ): Promise<StreamingDeltaResult | null> {
    // Delta computation is handled by DeltaEngine externally
    return null;
  }

  /**
   * Store blob as delta of another blob
   */
  async deltifyBlob(
    targetId: ObjectId,
    baseId: ObjectId,
    delta: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.ensureInitialized();

    // Collect delta bytes
    const chunks: Uint8Array[] = [];
    for await (const chunk of delta) {
      chunks.push(chunk);
    }
    const deltaBytes = concatBytes(chunks);

    // Calculate depth based on base's depth
    const baseChain = await this.getBlobDeltaChain(baseId);
    const depth = (baseChain?.depth ?? 0) + 1;

    if (depth > this.maxChainDepth) {
      throw new Error(`Delta chain would exceed max depth (${this.maxChainDepth})`);
    }

    const now = Date.now();
    await this.db.execute(
      `INSERT OR REPLACE INTO ${this.tableName}
       (target_id, base_id, delta_data, depth, ratio, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [targetId, baseId, deltaBytes, depth, 0, now],
    );
  }

  /**
   * Expand blob delta to full content
   */
  async undeltifyBlob(id: ObjectId): Promise<void> {
    await this.ensureInitialized();

    await this.db.execute(`DELETE FROM ${this.tableName} WHERE target_id = ?`, [id]);
  }

  /**
   * Check if blob is stored as delta
   */
  async isBlobDelta(id: ObjectId): Promise<boolean> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE target_id = ?`,
      [id],
    );

    return rows[0].cnt > 0;
  }

  /**
   * Get delta chain information for a blob
   */
  async getBlobDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    await this.ensureInitialized();

    const rows = await this.db.query<{
      base_id: string;
      delta_data: Uint8Array;
      depth: number;
    }>(`SELECT base_id, delta_data, depth FROM ${this.tableName} WHERE target_id = ?`, [id]);

    if (rows.length === 0) {
      return undefined;
    }

    const entry = rows[0];

    // Build full chain
    const baseIds: ObjectId[] = [id];
    let currentId = entry.base_id;
    let totalSize = entry.delta_data.length;
    let depth = 0;

    while (depth < this.maxChainDepth) {
      baseIds.push(currentId);

      const baseRows = await this.db.query<{
        base_id: string;
        delta_data: Uint8Array;
      }>(`SELECT base_id, delta_data FROM ${this.tableName} WHERE target_id = ?`, [currentId]);

      if (baseRows.length === 0) {
        // Found the final base (non-delta)
        break;
      }

      totalSize += baseRows[0].delta_data.length;
      currentId = baseRows[0].base_id;
      depth++;
    }

    return {
      depth: entry.depth,
      totalSize,
      baseIds,
    };
  }

  /**
   * List all delta relationships
   */
  async *listDeltas(): AsyncIterable<{ targetId: ObjectId; baseId: ObjectId; depth: number }> {
    await this.ensureInitialized();

    const rows = await this.db.query<{
      target_id: string;
      base_id: string;
      depth: number;
    }>(`SELECT target_id, base_id, depth FROM ${this.tableName}`);

    for (const row of rows) {
      yield {
        targetId: row.target_id,
        baseId: row.base_id,
        depth: row.depth,
      };
    }
  }

  /**
   * Get objects that depend on a base object
   */
  async *getDependents(baseId: ObjectId): AsyncIterable<ObjectId> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ target_id: string }>(
      `SELECT target_id FROM ${this.tableName} WHERE base_id = ?`,
      [baseId],
    );

    for (const row of rows) {
      yield row.target_id;
    }
  }
}

/**
 * SQL-based DeltaApi implementation
 *
 * Provides the unified delta interface using SQL database.
 */
export class SqlDeltaApi implements DeltaApi {
  readonly blobs: BlobDeltaApi;
  readonly trees: SqlTreeDeltaApi;
  private batchDepth = 0;

  constructor(readonly db: DatabaseClient) {
    this.blobs = new SqlBlobDeltaApi(db);
    this.trees = new SqlTreeDeltaApi(db);
  }

  async isDelta(id: ObjectId): Promise<boolean> {
    if (await this.blobs.isBlobDelta(id)) return true;
    if (await this.trees.isTreeDelta(id)) return true;
    return false;
  }

  async getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined> {
    const blobChain = await this.blobs.getBlobDeltaChain(id);
    if (blobChain) return blobChain;
    return this.trees.getTreeDeltaChain(id);
  }

  async *listDeltas(): AsyncIterable<StorageDeltaRelationship> {
    const blobApi = this.blobs as SqlBlobDeltaApi;
    for await (const delta of blobApi.listDeltas()) {
      yield {
        targetId: delta.targetId,
        baseId: delta.baseId,
        depth: delta.depth,
        ratio: 0, // Ratio not tracked in this implementation
      };
    }
  }

  async *getDependents(baseId: ObjectId): AsyncIterable<ObjectId> {
    const blobApi = this.blobs as SqlBlobDeltaApi;
    yield* blobApi.getDependents(baseId);
  }

  startBatch(): void {
    this.batchDepth++;
    // SQL transactions are used per operation
  }

  async endBatch(): Promise<void> {
    if (this.batchDepth <= 0) {
      throw new Error("No batch in progress");
    }
    this.batchDepth--;
    // SQL storage commits immediately within transactions
  }

  cancelBatch(): void {
    if (this.batchDepth > 0) {
      this.batchDepth--;
    }
    // SQL storage doesn't need explicit rollback for batch semantics
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
