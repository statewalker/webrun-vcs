/**
 * Database client abstraction
 *
 * Minimal interface for SQL database access, inspired by ObservableHQ's
 * Database Client Specification. Works with any SQL database (SQLite,
 * PostgreSQL, etc.) through adapter implementations.
 */

/**
 * Result of an execute operation (INSERT, UPDATE, DELETE)
 */
export interface ExecuteResult {
  /** Last inserted row ID (for auto-increment columns) */
  lastInsertRowId: number;
  /** Number of rows affected by the statement */
  changes: number;
}

/**
 * Minimal database client interface
 *
 * Implementations wrap specific database drivers (sql.js, better-sqlite3, etc.)
 * to provide a consistent async interface for SQL operations.
 */
export interface DatabaseClient {
  /**
   * Execute a SQL query that returns rows
   *
   * @param sql SQL query string with ? placeholders
   * @param params Parameter values (positional)
   * @returns Array of row objects with column names as keys
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a SQL statement that doesn't return rows
   *
   * Use for INSERT, UPDATE, DELETE, and DDL statements.
   *
   * @param sql SQL statement with ? placeholders
   * @param params Parameter values (positional)
   * @returns Result with lastInsertRowId and changes count
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /**
   * Execute multiple statements within a transaction
   *
   * Automatically commits on success, rolls back on error.
   * The provided client should be used for all operations within
   * the transaction function.
   *
   * @param fn Function that performs database operations
   * @returns Result of the transaction function
   */
  transaction<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T>;

  /**
   * Close the database connection
   *
   * After calling close(), the client should not be used.
   */
  close(): Promise<void>;
}
