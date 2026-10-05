/**
 * SQL-based DeltaStore implementation
 *
 * Stores delta relationships and instructions in a SQL database.
 * Implements the new DeltaStore interface from binary-storage.
 */

import type {
  DeltaChainDetails,
  DeltaInfo,
  DeltaStore,
  DeltaStoreUpdate,
  StoredDelta,
} from "@statewalker/vcs-core";
import type { Delta } from "@statewalker/vcs-utils";
import type { DatabaseClient } from "../database-client.js";

/**
 * Pending delta for batch update
 */
interface PendingDelta {
  info: DeltaInfo;
  delta: Delta[];
}

/**
 * Batched update handle for SQL delta storage
 */
class SqlDeltaStoreUpdate implements DeltaStoreUpdate {
  private readonly pendingDeltas: PendingDelta[] = [];
  private readonly store: SqlDeltaStore;
  private closed = false;

  constructor(store: SqlDeltaStore) {
    this.store = store;
  }

  /**
   * Store a full object - no-op for SQL delta store
   */
  async storeObject(
    _key: string,
    _content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Update already closed");
    }
    // SQL delta store only handles deltas, not full objects
  }

  /**
   * Store a delta relationship in this batch
   */
  async storeDelta(info: DeltaInfo, delta: Delta[]): Promise<number> {
    if (this.closed) {
      throw new Error("Update already closed");
    }

    this.pendingDeltas.push({ info, delta });

    // Calculate approximate size
    return delta.reduce((sum, d) => {
      switch (d.type) {
        case "copy":
          return sum + 8;
        case "insert":
          return sum + 1 + d.data.length;
        case "start":
        case "finish":
          return sum + 4;
        default:
          return sum;
      }
    }, 0);
  }

  /**
   * Commit all pending deltas
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // Apply all pending deltas
    for (const { info, delta } of this.pendingDeltas) {
      await this.store.applyDelta(info, delta);
    }
  }
}

/**
 * SQL-based delta storage
 *
 * Stores deltas in a table with:
 * - target_key: TEXT (primary key)
 * - base_key: TEXT (reference to base object)
 * - delta_data: BLOB (serialized delta instructions)
 * - ratio: REAL (compression ratio)
 */
export class SqlDeltaStore implements DeltaStore {
  private readonly maxChainDepth = 50;
  private initialized = false;

  /**
   * Create SQL-based delta store
   *
   * @param db Database client for SQL operations
   * @param tableName Table name for storing deltas (default: "delta_store")
   */
  constructor(
    private readonly db: DatabaseClient,
    private readonly tableName: string = "delta_store",
  ) {}

  /**
   * Initialize the storage table if needed
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        target_key TEXT PRIMARY KEY,
        base_key TEXT NOT NULL,
        delta_data BLOB NOT NULL,
        ratio REAL NOT NULL
      )
    `);

    // Index for base_key lookups
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_base_key
      ON ${this.tableName} (base_key)
    `);

    this.initialized = true;
  }

  /**
   * Serialize delta instructions to bytes
   */
  private serializeDelta(delta: Delta[]): Uint8Array {
    const encoder = new TextEncoder();
    return encoder.encode(
      JSON.stringify(
        delta.map((d): object => {
          switch (d.type) {
            case "start":
              return { type: "start", targetLen: d.targetLen };
            case "copy":
              return { type: "copy", start: d.start, len: d.len };
            case "insert":
              return { type: "insert", data: Array.from(d.data) };
            case "finish":
              return { type: "finish", checksum: d.checksum };
            default: {
              const _exhaustive: never = d;
              throw new Error(`Unknown delta type: ${(_exhaustive as Delta).type}`);
            }
          }
        }),
      ),
    );
  }

  /**
   * Deserialize delta instructions from bytes
   */
  private deserializeDelta(data: Uint8Array): Delta[] {
    const decoder = new TextDecoder();
    const parsed = JSON.parse(decoder.decode(data));
    return parsed.map(
      (d: {
        type: string;
        targetLen?: number;
        start?: number;
        len?: number;
        data?: number[];
        checksum?: number;
      }) => {
        switch (d.type) {
          case "start":
            return { type: "start", targetLen: d.targetLen };
          case "copy":
            return { type: "copy", start: d.start, len: d.len };
          case "insert":
            return { type: "insert", data: new Uint8Array(d.data || []) };
          case "finish":
            return { type: "finish", checksum: d.checksum };
          default:
            throw new Error(`Unknown delta type: ${d.type}`);
        }
      },
    );
  }

  /**
   * Start a batched update transaction
   */
  startUpdate(): DeltaStoreUpdate {
    return new SqlDeltaStoreUpdate(this);
  }

  /**
   * Apply a delta (internal method used by update)
   */
  async applyDelta(info: DeltaInfo, delta: Delta[]): Promise<void> {
    await this.ensureInitialized();

    // Calculate ratio
    const deltaSize = delta.reduce((sum, d) => {
      switch (d.type) {
        case "copy":
          return sum + 8;
        case "insert":
          return sum + 1 + d.data.length;
        case "start":
        case "finish":
          return sum + 4;
        default:
          return sum;
      }
    }, 0);

    const ratio = deltaSize > 0 ? 1 : 0;
    const deltaData = this.serializeDelta(delta);

    await this.db.execute(
      `INSERT OR REPLACE INTO ${this.tableName} (target_key, base_key, delta_data, ratio) VALUES (?, ?, ?, ?)`,
      [info.targetKey, info.baseKey, deltaData, ratio],
    );
  }

  /**
   * Load delta for an object
   */
  async loadDelta(targetKey: string): Promise<StoredDelta | undefined> {
    await this.ensureInitialized();

    const rows = await this.db.query<{
      base_key: string;
      delta_data: Uint8Array;
      ratio: number;
    }>(`SELECT base_key, delta_data, ratio FROM ${this.tableName} WHERE target_key = ?`, [
      targetKey,
    ]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      baseKey: row.base_key,
      targetKey,
      delta: this.deserializeDelta(row.delta_data),
      ratio: row.ratio,
    };
  }

  /**
   * Check if object is stored as delta
   */
  async isDelta(targetKey: string): Promise<boolean> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE target_key = ?`,
      [targetKey],
    );

    return rows[0].count > 0;
  }

  /**
   * Remove delta relationship
   */
  async removeDelta(targetKey: string, _keepAsBase?: boolean): Promise<boolean> {
    await this.ensureInitialized();

    const result = await this.db.execute(`DELETE FROM ${this.tableName} WHERE target_key = ?`, [
      targetKey,
    ]);

    return result.changes > 0;
  }

  /**
   * Get delta chain info for an object
   */
  async getDeltaChainInfo(targetKey: string): Promise<DeltaChainDetails | undefined> {
    await this.ensureInitialized();

    const entry = await this.loadDelta(targetKey);
    if (!entry) {
      return undefined;
    }

    // Build chain
    const chain: string[] = [targetKey];
    let currentKey = entry.baseKey;
    let depth = 1;
    let compressedSize = this.calculateDeltaSize(entry.delta);

    while (depth < this.maxChainDepth) {
      const baseEntry = await this.loadDelta(currentKey);
      if (!baseEntry) {
        // Found the base object
        chain.push(currentKey);
        break;
      }
      chain.push(currentKey);
      compressedSize += this.calculateDeltaSize(baseEntry.delta);
      currentKey = baseEntry.baseKey;
      depth++;
    }

    return {
      baseKey: chain[chain.length - 1],
      targetKey,
      depth,
      originalSize: 0, // Not tracked in this implementation
      compressedSize,
      chain,
    };
  }

  /**
   * Calculate approximate delta size
   */
  private calculateDeltaSize(delta: Delta[]): number {
    return delta.reduce((sum, d) => {
      switch (d.type) {
        case "copy":
          return sum + 8;
        case "insert":
          return sum + 1 + d.data.length;
        case "start":
        case "finish":
          return sum + 4;
        default:
          return sum;
      }
    }, 0);
  }

  /**
   * List all delta relationships
   */
  async *listDeltas(): AsyncIterable<DeltaInfo> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ target_key: string; base_key: string }>(
      `SELECT target_key, base_key FROM ${this.tableName}`,
    );

    for (const row of rows) {
      yield {
        baseKey: row.base_key,
        targetKey: row.target_key,
      };
    }
  }
}

/**
 * Create a new SQL-based delta store
 */
export function createSqlDeltaStore(db: DatabaseClient, tableName?: string): SqlDeltaStore {
  return new SqlDeltaStore(db, tableName);
}
