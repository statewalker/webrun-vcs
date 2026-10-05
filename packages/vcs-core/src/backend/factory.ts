/**
 * Storage backend factory
 *
 * Creates HistoryWithOperations instances from registered backend factories.
 *
 * ## Usage
 *
 * Use the HistoryBackendFactory pattern for creating storage:
 * - `createHistory()` - Create HistoryWithOperations from registered backend type
 * - `createMemoryHistoryWithOperations()` - In-memory with full operations
 * - `createGitFilesHistory()` - Git-files backed with full operations
 *
 * @example
 * ```typescript
 * // Using registered factory
 * const history = await createHistory("git-files", { path: ".git" });
 *
 * // Using specific factory functions
 * const history = createGitFilesHistory(stores);
 * const history = createMemoryHistoryWithOperations();
 * ```
 */

export type {
  BaseBackendConfig,
  GitFilesBackendConfig,
  HistoryBackendFactory,
  HistoryBackendType,
  MemoryBackendConfig,
  SQLBackendConfig,
} from "./history-backend-factory.js";

export {
  createHistory,
  getRegisteredHistoryBackendTypes,
  hasHistoryBackendFactory,
  registerHistoryBackendFactory,
} from "./history-backend-factory.js";
