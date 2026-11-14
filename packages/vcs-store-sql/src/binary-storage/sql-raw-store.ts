/**
 * SQL-based RawStorage implementation
 *
 * Stores binary content in a SQL database table, cutting large values into
 * fixed-size chunk rows so that neither a write nor a read holds a whole value.
 */

import { fixedSizeChunks, type RawStorage } from "@statewalker/vcs-core";
import type { DatabaseClient } from "../database-client.js";

/** Default chunk size: 256 KiB. */
export const SQL_RAW_CHUNK_SIZE = 256 * 1024;

export interface SqlRawStoreOptions {
  /** Values longer than this are cut into chunk rows of this many bytes. Default 256 KiB. */
  chunkSize?: number;
}

/**
 * Bring a raw-store table to the chunked layout, keeping its rows: creates the
 * table if needed, adds the `chunk_count` and `chunk_token` columns to a table
 * of the old single-row layout (`key`, `data`, `size`), and creates the
 * `<table>_chunk` table. Idempotent. Run by `SqlRawStore` before first use and
 * by schema migration 6 for the default table names.
 *
 * @param db Database client (inside a transaction, the transaction's client)
 * @param tableName The raw-store table
 */
export async function upgradeRawStoreTable(db: DatabaseClient, tableName: string): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      key TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      size INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      chunk_token TEXT
    )
  `);
  const columns = await db.query<{ name: string }>(`PRAGMA table_info(${tableName})`);
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("chunk_count")) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!has("chunk_token")) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN chunk_token TEXT`);
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${tableName}_chunk (
      token TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (token, seq)
    )
  `);
}

interface Row {
  data: Uint8Array;
  size: number;
  chunk_count: number;
  chunk_token: string | null;
}

/**
 * SQL-based storage
 *
 * A value up to one chunk is one row of `<table>` (`key`, `data`, `size`), the
 * layout older versions wrote for every value. A longer value is written as
 * `(token, seq)` rows of `<table>_chunk` while it streams in; its `<table>` row
 * then holds the size, the chunk count and the token, and an empty `data`.
 * A fresh token per write makes `move` an update of one small row. Reads stream
 * one chunk row at a time.
 *
 * @example
 * ```typescript
 * const raw = new SqlRawStore(db, "raw_objects");
 * const objects = createGitObjects(rawStorageStaging(raw)); // streams through raw.move
 * ```
 */
export class SqlRawStore implements RawStorage {
  private initialized?: Promise<void>;
  private readonly chunkSize: number;
  private readonly chunkTable: string;

  /**
   * @param db Database client for SQL operations
   * @param tableName Table name for storing objects (default: "raw_store")
   * @param options Chunking options
   */
  constructor(
    private readonly db: DatabaseClient,
    private readonly tableName: string = "raw_store",
    options: SqlRawStoreOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? SQL_RAW_CHUNK_SIZE;
    if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new RangeError(`bad chunk size ${this.chunkSize}`);
    }
    this.chunkTable = `${tableName}_chunk`;
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= upgradeRawStoreTable(this.db, this.tableName).catch((e) => {
      this.initialized = undefined;
      throw e;
    });
    return this.initialized;
  }

  private async row(db: DatabaseClient, key: string): Promise<Row | undefined> {
    const rows = await db.query<Row>(
      `SELECT data, size, chunk_count, chunk_token FROM ${this.tableName} WHERE key = ?`,
      [key],
    );
    return rows[0];
  }

  private async tokenOf(db: DatabaseClient, key: string): Promise<string | null | undefined> {
    const rows = await db.query<{ chunk_token: string | null }>(
      `SELECT chunk_token FROM ${this.tableName} WHERE key = ?`,
      [key],
    );
    return rows[0]?.chunk_token;
  }

  private async dropChunks(db: DatabaseClient, token: string | null | undefined): Promise<void> {
    if (token) await db.execute(`DELETE FROM ${this.chunkTable} WHERE token = ?`, [token]);
  }

  /**
   * Store byte stream under key, inserting each chunk row as soon as it is full.
   */
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    await this.ensureInitialized();
    const chunks = fixedSizeChunks(content, this.chunkSize)[Symbol.asyncIterator]();
    const first = await chunks.next();
    const second = first.done ? first : await chunks.next();
    if (second.done) {
      const bytes = first.done ? new Uint8Array(0) : first.value;
      await this.db.transaction(async (tx) => {
        const previous = await this.tokenOf(tx, key);
        await tx.execute(
          `INSERT OR REPLACE INTO ${this.tableName} (key, data, size, chunk_count, chunk_token) VALUES (?, ?, ?, 0, NULL)`,
          [key, bytes, bytes.length],
        );
        await this.dropChunks(tx, previous);
      });
      return;
    }

    const token = crypto.randomUUID();
    let count = 0;
    let size = 0;
    let published = false;
    try {
      const put = async (chunk: Uint8Array) => {
        await this.db.execute(
          `INSERT INTO ${this.chunkTable} (token, seq, data) VALUES (?, ?, ?)`,
          [token, count++, chunk],
        );
        size += chunk.length;
      };
      await put(first.value as Uint8Array);
      await put(second.value);
      for (let r = await chunks.next(); !r.done; r = await chunks.next()) await put(r.value);
      await this.db.transaction(async (tx) => {
        const previous = await this.tokenOf(tx, key);
        await tx.execute(
          `INSERT OR REPLACE INTO ${this.tableName} (key, data, size, chunk_count, chunk_token) VALUES (?, ?, ?, ?, ?)`,
          [key, new Uint8Array(0), size, count, token],
        );
        await this.dropChunks(tx, previous);
      });
      published = true;
    } finally {
      if (!published) await this.dropChunks(this.db, token);
    }
  }

  /**
   * Load byte stream by key, one chunk row at a time.
   */
  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    await this.ensureInitialized();
    const row = await this.row(this.db, key);
    if (!row) throw new Error(`Key not found: ${key}`);

    if (!row.chunk_token || row.chunk_count === 0) {
      let data = row.data;
      if (options?.start !== undefined || options?.end !== undefined) {
        data = data.subarray(options?.start ?? 0, options?.end ?? data.length);
      }
      yield data;
      return;
    }

    const start = Math.max(0, options?.start ?? 0);
    const end = Math.min(row.size, options?.end ?? row.size);
    if (start >= end) return;
    const size = await this.chunkSizeOf(row.chunk_token);
    for (let seq = Math.floor(start / size); seq * size < end; seq++) {
      const rows = await this.db.query<{ data: Uint8Array }>(
        `SELECT data FROM ${this.chunkTable} WHERE token = ? AND seq = ?`,
        [row.chunk_token, seq],
      );
      const chunk = rows[0]?.data;
      if (!chunk) throw new Error(`Missing chunk ${seq} of ${key}`);
      const base = seq * size;
      const from = Math.max(0, start - base);
      const to = Math.min(chunk.length, end - base);
      yield from === 0 && to === chunk.length ? chunk : chunk.subarray(from, to);
    }
  }

  /** All chunks but the last are full: the first one's length is the value's chunk size. */
  private async chunkSizeOf(token: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT length(data) AS n FROM ${this.chunkTable} WHERE token = ? AND seq = 0`,
      [token],
    );
    const n = rows[0]?.n;
    if (!n) throw new Error(`Missing first chunk of ${token}`);
    return n;
  }

  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE key = ?`,
      [key],
    );
    return rows[0].count > 0;
  }

  async remove(key: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.db.transaction(async (tx) => {
      const token = await this.tokenOf(tx, key);
      const result = await tx.execute(`DELETE FROM ${this.tableName} WHERE key = ?`, [key]);
      await this.dropChunks(tx, token);
      return result.changes > 0;
    });
  }

  /**
   * Rename a value by updating its row; chunk rows are keyed by token and stay.
   */
  async move(from: string, to: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.db.transaction(async (tx) => {
      const moving = await this.tokenOf(tx, from);
      if (moving === undefined) return false;
      if (from === to) return true;
      const replaced = await this.tokenOf(tx, to);
      await tx.execute(`DELETE FROM ${this.tableName} WHERE key = ?`, [to]);
      await tx.execute(`UPDATE ${this.tableName} SET key = ? WHERE key = ?`, [to, from]);
      if (replaced !== moving) await this.dropChunks(tx, replaced);
      return true;
    });
  }

  async *keys(): AsyncIterable<string> {
    await this.ensureInitialized();
    const rows = await this.db.query<{ key: string }>(`SELECT key FROM ${this.tableName}`);
    for (const row of rows) yield row.key;
  }

  /**
   * @returns Content size in bytes, or -1 if key not found
   */
  async size(key: string): Promise<number> {
    await this.ensureInitialized();
    const rows = await this.db.query<{ size: number }>(
      `SELECT size FROM ${this.tableName} WHERE key = ?`,
      [key],
    );
    return rows.length === 0 ? -1 : rows[0].size;
  }
}

/**
 * Create a new SQL-based raw store
 */
export function createSqlRawStore(
  db: DatabaseClient,
  tableName?: string,
  options?: SqlRawStoreOptions,
): SqlRawStore {
  return new SqlRawStore(db, tableName, options);
}
