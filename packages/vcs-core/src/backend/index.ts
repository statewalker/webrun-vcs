/**
 * Backend module - Storage interfaces and factories
 *
 * Exports storage-related types and factory functions.
 *
 * ## Factory Functions
 *
 * Use HistoryBackendFactory pattern for creating storage:
 * - `createHistory()` - Create HistoryWithOperations from registered backend type
 * - `createMemoryHistoryWithOperations()` - In-memory with full operations
 * - `createGitFilesHistory()` - Git-files backed with full operations
 *
 * ## Key Types
 *
 * - `StorageOperations` - Low-level delta and serialization APIs
 * - `BackendCapabilities` - Feature flags for backend optimization
 * - `HistoryBackendFactory` - Factory interface for backend registration
 */

// Pack file handling (previously re-exported via ./git/)
export * from "../pack/index.js";
// Export serialization API for backend implementations
export { DefaultSerializationApi } from "../serialization/serialization-api.impl.js";
export * from "./factory.js";
export * from "./git-files-storage-backend.js";
export * from "./history-backend-factory.js";
export * from "./memory-storage-backend.js";
export * from "./storage-backend.js";
