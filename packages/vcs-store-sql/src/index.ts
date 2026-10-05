/**
 * SQL-based storage for StateWalker VCS
 *
 * Provides persistent object storage using SQL databases (primarily SQLite).
 * Implements the repository pattern with delta compression support.
 *
 * @example Basic usage with sql.js
 * ```typescript
 * import { createSQLStorage } from "@statewalker/vcs-store-sql";
 * import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
 *
 * // Create in-memory SQLite database
 * const db = await SqlJsAdapter.create();
 * const { storage, close } = await createSQLStorage(db);
 *
 * // Store content
 * async function* chunks() {
 *   yield new TextEncoder().encode("Hello, World!");
 * }
 * const id = await storage.store(chunks());
 *
 * // Load content
 * for await (const chunk of storage.load(id)) {
 *   console.log(new TextDecoder().decode(chunk));
 * }
 *
 * // Don't forget to close when done
 * await close();
 * ```
 */

// Binary storage (new architecture)
export * from "./binary-storage/index.js";
// High-level store implementations
export * from "./commit-store.js";
// Database client interface
export * from "./database-client.js";
// GC strategy for SQL storage
export * from "./gc-strategy.js";
// Migrations
export * from "./migrations/index.js";
// Native SQL stores with query capabilities
export * from "./native/index.js";
// Object storage (new architecture)
export * from "./object-storage/index.js";
export * from "./ref-store.js";
// Storage backend (unified interface)
export * from "./register-backend.js";
export * from "./sql-delta-api.js";
export * from "./sql-storage-backend.js";
export * from "./sql-tree-delta-api.js";
export * from "./staging-store.js";
// Synchronization utilities
export * from "./sync.js";
export * from "./tag-store.js";
export * from "./tree-store.js";
