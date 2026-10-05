/**
 * SQL-based BinStore implementation
 *
 * Composite storage that combines SqlRawStore and SqlDeltaStore.
 * Implements the BinStore interface from binary-storage.
 */

import type { BinStore, DeltaStore, RawStorage } from "@statewalker/vcs-core";
import type { DatabaseClient } from "../database-client.js";
import { SqlDeltaStore } from "./sql-delta-store.js";
import { SqlRawStore } from "./sql-raw-store.js";

/**
 * SQL-based composite binary storage
 *
 * Provides both raw and delta-compressed storage using SQL database.
 */
export class SqlBinStore implements BinStore {
  readonly name = "sql";
  readonly raw: RawStorage;
  readonly delta: DeltaStore;

  private readonly _rawStore: SqlRawStore;
  private readonly _deltaStore: SqlDeltaStore;

  /**
   * Create SQL-based binary store
   *
   * @param db Database client for SQL operations
   * @param rawTableName Table name for raw storage (default: "raw_store")
   * @param deltaTableName Table name for delta storage (default: "delta_store")
   */
  constructor(
    private readonly db: DatabaseClient,
    rawTableName?: string,
    deltaTableName?: string,
  ) {
    this._rawStore = new SqlRawStore(db, rawTableName);
    this._deltaStore = new SqlDeltaStore(db, deltaTableName);
    this.raw = this._rawStore;
    this.delta = this._deltaStore;
  }

  /**
   * Flush pending writes
   *
   * For SQL storage with proper transaction support, this is typically a no-op.
   */
  async flush(): Promise<void> {
    // No-op: SQL writes are typically immediate within transactions
  }

  /**
   * Close backend and release resources
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Refresh backend state
   *
   * For SQL storage, this could be used to clear any caches.
   */
  async refresh(): Promise<void> {
    // No-op: SQL storage has no caches to refresh
  }
}

/**
 * Create a new SQL-based binary store
 */
export function createSqlBinStore(
  db: DatabaseClient,
  rawTableName?: string,
  deltaTableName?: string,
): SqlBinStore {
  return new SqlBinStore(db, rawTableName, deltaTableName);
}
