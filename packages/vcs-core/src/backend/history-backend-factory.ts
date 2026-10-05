/**
 * HistoryBackendFactory - Factory pattern for creating HistoryWithOperations
 *
 * This module provides the new factory pattern that creates HistoryWithOperations
 * directly, replacing the deprecated StorageBackend pattern.
 *
 * The factory pattern:
 * 1. Hides backend implementation details
 * 2. Returns HistoryWithOperations directly for unified API
 * 3. Supports different backend configurations
 *
 * @example
 * ```typescript
 * // Create Git-files backed history
 * const history = await createGitFilesHistory({
 *   path: "/path/to/.git",
 *   create: true,
 * });
 * await history.initialize();
 *
 * // Use history for normal operations
 * const commit = await history.commits.load(commitId);
 *
 * // Use operations APIs
 * history.delta.startBatch();
 * await history.delta.endBatch();
 * ```
 */

import type { HistoryWithOperations } from "../history/history.js";
import type { StorageOperations } from "./storage-backend.js";

/**
 * Base configuration for all backend types
 *
 * Extended by specific backend configs.
 */
export interface BaseBackendConfig {
  /** Whether to create storage if it doesn't exist */
  create?: boolean;
  /** Read-only mode */
  readOnly?: boolean;
}

/**
 * Configuration for Git-files backend
 *
 * Used with createGitFilesHistory() factory.
 */
export interface GitFilesBackendConfig extends BaseBackendConfig {
  /** Path to .git directory */
  path: string;
  /** Create repository if it doesn't exist (default: false) */
  create?: boolean;
}

/**
 * Configuration for in-memory backend
 *
 * Used with createMemoryHistoryWithOperations() factory.
 */
export interface MemoryBackendConfig extends BaseBackendConfig {
  /** Enable delta tracking (for testing delta operations) */
  enableDeltaTracking?: boolean;
}

/**
 * Configuration for SQL backend
 *
 * Used with createSQLHistory() factory (in store-sql package).
 */
export interface SQLBackendConfig extends BaseBackendConfig {
  /** Database connection string or path */
  connectionString: string;
  /** Create database/tables if they don't exist */
  create?: boolean;
}

/**
 * HistoryBackendFactory interface
 *
 * Factory pattern for creating HistoryWithOperations instances.
 * Each backend type implements this interface to provide its factory.
 *
 * @example
 * ```typescript
 * class GitFilesHistoryFactory implements HistoryBackendFactory<GitFilesBackendConfig> {
 *   async createHistory(config: GitFilesBackendConfig): Promise<HistoryWithOperations> {
 *     // Create and return HistoryWithOperations backed by Git files
 *   }
 *
 *   async createOperations(config: GitFilesBackendConfig): Promise<StorageOperations> {
 *     // Create and return only delta/serialization APIs
 *   }
 * }
 * ```
 */
export interface HistoryBackendFactory<TConfig extends BaseBackendConfig = BaseBackendConfig> {
  /**
   * Create a full HistoryWithOperations instance
   *
   * Returns an uninitialized instance. Call initialize() before use.
   *
   * @param config Backend-specific configuration
   * @returns HistoryWithOperations instance (not yet initialized)
   */
  createHistory(config: TConfig): Promise<HistoryWithOperations>;

  /**
   * Create only storage operations (delta and serialization APIs)
   *
   * Use this when you only need delta compression or pack file operations
   * without the full History interface.
   *
   * @param config Backend-specific configuration
   * @returns StorageOperations instance (not yet initialized)
   */
  createOperations?(config: TConfig): Promise<StorageOperations>;
}

/**
 * Union type for all backend configurations
 */
export type BackendConfigType = GitFilesBackendConfig | MemoryBackendConfig | SQLBackendConfig;

/**
 * Backend type identifiers for the registry
 */
export type HistoryBackendType = "git-files" | "memory" | "sql" | "kv";

/**
 * Registry of history backend factories
 *
 * Maps backend types to their factory functions.
 * New backends can be registered at runtime.
 */
const historyBackendFactories = new Map<
  HistoryBackendType,
  (config: BaseBackendConfig) => Promise<HistoryWithOperations>
>();

/**
 * Create a history instance from a backend type
 *
 * Factory function for creating HistoryWithOperations instances.
 * The instance is NOT initialized - call initialize() before use.
 *
 * @param type Backend type: "git-files" | "memory" | "sql" | "kv"
 * @param config Backend-specific configuration
 * @returns HistoryWithOperations instance (not yet initialized)
 * @throws Error if backend type is not registered
 *
 * @example
 * ```typescript
 * const history = await createHistory("git-files", { path: ".git" });
 * await history.initialize();
 *
 * const commit = await history.commits.load(commitId);
 *
 * await history.close();
 * ```
 */
export async function createHistory(
  type: HistoryBackendType,
  config: BaseBackendConfig,
): Promise<HistoryWithOperations> {
  const factory = historyBackendFactories.get(type);
  if (!factory) {
    throw new Error(
      `Unknown history backend type: ${type}. ` +
        `Available types: ${[...historyBackendFactories.keys()].join(", ") || "(none registered)"}`,
    );
  }
  return factory(config);
}

/**
 * Register a history backend factory
 *
 * Allows adding custom backend types at runtime.
 *
 * @param type Backend type identifier
 * @param factory Factory function that creates the history instance
 *
 * @example
 * ```typescript
 * registerHistoryBackendFactory("custom", async (config) => {
 *   return createCustomHistory(config);
 * });
 * ```
 */
export function registerHistoryBackendFactory(
  type: HistoryBackendType,
  factory: (config: BaseBackendConfig) => Promise<HistoryWithOperations>,
): void {
  historyBackendFactories.set(type, factory);
}

/**
 * Check if a history backend type is registered
 */
export function hasHistoryBackendFactory(type: HistoryBackendType): boolean {
  return historyBackendFactories.has(type);
}

/**
 * Get all registered history backend types
 */
export function getRegisteredHistoryBackendTypes(): HistoryBackendType[] {
  return [...historyBackendFactories.keys()];
}
