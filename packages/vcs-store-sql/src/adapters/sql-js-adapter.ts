/**
 * sql.js adapter for DatabaseClient interface
 *
 * Provides SQLite database access in browsers and Node.js using
 * WebAssembly-based sql.js library.
 */

import type { Database, SqlJsStatic } from "sql.js";
import type { DatabaseClient, ExecuteResult } from "../database-client.js";

/**
 * Options for creating a SqlJsAdapter
 */
export interface SqlJsAdapterOptions {
  /** URL to load sql.js WASM file from (optional, uses default if not specified) */
  wasmUrl?: string;
  /** Pre-loaded sql.js module (optional, loads dynamically if not provided) */
  sqlJs?: SqlJsStatic;
}

/**
 * sql.js implementation of DatabaseClient
 *
 * Wraps the synchronous sql.js Database with an async interface.
 * Suitable for browser and Node.js environments.
 */
export class SqlJsAdapter implements DatabaseClient {
  private inTransaction = false;

  private constructor(private db: Database) {}

  /**
   * Create a new in-memory database
   *
   * @param options Configuration options
   * @returns New SqlJsAdapter instance
   */
  static async create(options?: SqlJsAdapterOptions): Promise<SqlJsAdapter> {
    const SQL = await SqlJsAdapter.loadSqlJs(options);
    const db = new SQL.Database();
    return new SqlJsAdapter(db);
  }

  /**
   * Open a database from existing data
   *
   * @param data SQLite database file as Uint8Array
   * @param options Configuration options
   * @returns SqlJsAdapter with loaded database
   */
  static async open(data: Uint8Array, options?: SqlJsAdapterOptions): Promise<SqlJsAdapter> {
    const SQL = await SqlJsAdapter.loadSqlJs(options);
    const db = new SQL.Database(data);
    return new SqlJsAdapter(db);
  }

  /**
   * Load sql.js module
   */
  private static async loadSqlJs(options?: SqlJsAdapterOptions): Promise<SqlJsStatic> {
    if (options?.sqlJs) {
      return options.sqlJs;
    }

    // Dynamic import of sql.js
    const initSqlJs = (await import("sql.js")).default;
    const config: { locateFile?: (file: string) => string } = {};

    if (options?.wasmUrl) {
      const wasmUrl = options.wasmUrl;
      config.locateFile = () => wasmUrl;
    }

    return initSqlJs(config);
  }

  /**
   * Execute a query that returns rows
   */
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(this.convertParams(params));
    }

    const results: T[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as T;
      results.push(row);
    }
    stmt.free();

    return results;
  }

  /**
   * Execute a statement that doesn't return rows
   */
  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    if (params && params.length > 0) {
      this.db.run(sql, this.convertParams(params));
    } else {
      this.db.run(sql);
    }

    // Get last insert rowid and changes count
    const lastInsertRowId = this.getLastInsertRowId();
    const changes = this.getChanges();

    return { lastInsertRowId, changes };
  }

  /**
   * Execute operations within a transaction
   */
  async transaction<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      // Already in a transaction, just run the function
      return fn(this);
    }

    this.inTransaction = true;
    try {
      this.db.run("BEGIN TRANSACTION");
      const result = await fn(this);
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Export database as Uint8Array
   *
   * Useful for persisting the in-memory database to storage.
   *
   * @returns SQLite database file as Uint8Array
   */
  export(): Uint8Array {
    return this.db.export();
  }

  /**
   * Get the underlying sql.js Database object
   *
   * Use with caution - direct access bypasses the adapter's
   * transaction management.
   */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Convert JavaScript values to sql.js parameter format
   */
  private convertParams(params: unknown[]): (number | string | Uint8Array | null)[] {
    return params.map((p) => {
      if (p === null || p === undefined) {
        return null;
      }
      if (typeof p === "boolean") {
        return p ? 1 : 0;
      }
      if (p instanceof Uint8Array) {
        return p;
      }
      if (typeof p === "number" || typeof p === "string") {
        return p;
      }
      // Convert other types to string
      return String(p);
    });
  }

  /**
   * Get last inserted row ID using SQLite function
   */
  private getLastInsertRowId(): number {
    const stmt = this.db.prepare("SELECT last_insert_rowid() as id");
    if (stmt.step()) {
      const result = stmt.getAsObject() as { id: number };
      stmt.free();
      return result.id;
    }
    stmt.free();
    return 0;
  }

  /**
   * Get number of changed rows using SQLite function
   */
  private getChanges(): number {
    const stmt = this.db.prepare("SELECT changes() as cnt");
    if (stmt.step()) {
      const result = stmt.getAsObject() as { cnt: number };
      stmt.free();
      return result.cnt;
    }
    stmt.free();
    return 0;
  }
}
