/**
 * SQL-based RawStorage implementation
 *
 * Stores binary content in a SQL database table.
 * Implements the RawStorage interface.
 */

import type { RawStorage } from "@statewalker/vcs-core";
import type { DatabaseClient } from "../database-client.js";

/**
 * Collect async iterable to Uint8Array
 */
async function collect(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of input) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * SQL-based storage
 *
 * Stores content in a simple key-value table:
 * - key: TEXT (primary key)
 * - data: BLOB
 * - size: INTEGER (for efficient size queries)
 */
export class SqlRawStore implements RawStorage {
  private initialized = false;

  /**
   * Create SQL-based storage
   *
   * @param db Database client for SQL operations
   * @param tableName Table name for storing objects (default: "raw_store")
   */
  constructor(
    private readonly db: DatabaseClient,
    private readonly tableName: string = "raw_store",
  ) {}

  /**
   * Initialize the storage table if needed
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        size INTEGER NOT NULL
      )
    `);

    this.initialized = true;
  }

  /**
   * Store byte stream under key
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    await this.ensureInitialized();

    const bytes = await collect(content);

    await this.db.execute(
      `INSERT OR REPLACE INTO ${this.tableName} (key, data, size) VALUES (?, ?, ?)`,
      [key, bytes, bytes.length],
    );
  }

  /**
   * Load byte stream by key
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ data: Uint8Array }>(
      `SELECT data FROM ${this.tableName} WHERE key = ?`,
      [key],
    );

    if (rows.length === 0) {
      throw new Error(`Key not found: ${key}`);
    }

    let data = rows[0].data;

    // Apply start and end if specified
    if (options?.start !== undefined || options?.end !== undefined) {
      const start = options?.start ?? 0;
      const end = options?.end ?? data.length;
      data = data.subarray(start, end);
    }

    yield data;
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE key = ?`,
      [key],
    );

    return rows[0].count > 0;
  }

  /**
   * Remove content by key
   */
  async remove(key: string): Promise<boolean> {
    await this.ensureInitialized();

    const result = await this.db.execute(`DELETE FROM ${this.tableName} WHERE key = ?`, [key]);

    return result.changes > 0;
  }

  /**
   * List all keys
   */
  async *keys(): AsyncIterable<string> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ key: string }>(`SELECT key FROM ${this.tableName}`);

    for (const row of rows) {
      yield row.key;
    }
  }

  /**
   * Get content size for a key
   *
   * @returns Content size in bytes, or -1 if key not found
   */
  async size(key: string): Promise<number> {
    await this.ensureInitialized();

    const rows = await this.db.query<{ size: number }>(
      `SELECT size FROM ${this.tableName} WHERE key = ?`,
      [key],
    );

    if (rows.length === 0) {
      return -1;
    }

    return rows[0].size;
  }
}

/**
 * Create a new SQL-based raw store
 */
export function createSqlRawStore(db: DatabaseClient, tableName?: string): SqlRawStore {
  return new SqlRawStore(db, tableName);
}
