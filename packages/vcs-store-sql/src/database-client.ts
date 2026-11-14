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
   *
   * Implementations must isolate concurrent callers: on a single connection a
   * transaction waits for the one in flight, and plain `query` / `execute` calls
   * wait too, so nothing runs inside someone else's transaction.
   *
   * Use the client handed to `fn` for every statement inside it, nested
   * transactions included (they join). Calling the outer client from inside
   * `fn` waits for the transaction to end, so it never runs (a hang).
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
