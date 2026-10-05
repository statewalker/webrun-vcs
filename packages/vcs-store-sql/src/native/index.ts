/**
 * Native SQL stores with Git-compatible IDs and query capabilities
 *
 * This module provides SQL-backed stores that:
 * - Store data in normalized SQL tables for efficient queries
 * - Compute Git-compatible SHA-1 object IDs for interoperability
 * - Provide extended query methods beyond the standard interfaces
 */

import type { DatabaseClient } from "../database-client.js";
import { SqlNativeBlobStoreImpl } from "./sql-native-blob-store.js";
import { SqlNativeCommitStoreImpl } from "./sql-native-commit-store.js";
import { SqlNativeTagStoreImpl } from "./sql-native-tag-store.js";
import { SqlNativeTreeStoreImpl } from "./sql-native-tree-store.js";
import type { SqlNativeStores } from "./types.js";

// Re-export implementations
export { SqlNativeBlobStoreImpl } from "./sql-native-blob-store.js";
export { SqlNativeCommitStoreImpl } from "./sql-native-commit-store.js";
export { SqlNativeTagStoreImpl } from "./sql-native-tag-store.js";
export { SqlNativeTreeStoreImpl } from "./sql-native-tree-store.js";
// Re-export types
export * from "./types.js";

/**
 * Create native SQL stores with query capabilities
 *
 * Creates stores that store data in optimized SQL format while still
 * computing Git-compatible object IDs. This enables:
 * - Efficient SQL queries (by author, date, etc.)
 * - Git interoperability (same object IDs as native Git)
 * - Synchronization with streaming stores for transport
 *
 * @param db Database client for SQL operations
 * @returns Collection of native SQL stores
 *
 * @example
 * ```typescript
 * const db = await SqlJsAdapter.create();
 * const stores = createSqlNativeStores(db);
 *
 * // Store commits with Git-compatible IDs
 * const commitId = await stores.commits.store(commit);
 *
 * // Use extended query methods
 * for await (const id of stores.commits.findByAuthor("user@example.com")) {
 *   console.log(id);
 * }
 * ```
 */
export function createSqlNativeStores(db: DatabaseClient): SqlNativeStores {
  return {
    commits: new SqlNativeCommitStoreImpl(db),
    trees: new SqlNativeTreeStoreImpl(db),
    blobs: new SqlNativeBlobStoreImpl(db),
    tags: new SqlNativeTagStoreImpl(db),
  };
}
