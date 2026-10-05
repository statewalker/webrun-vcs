/**
 * File-backed storage backend for StateWalker VCS
 *
 * Provides file-dependent implementations of storage interfaces:
 * - Storage: FileRawStorage, PackDirectoryAdapter, FileVolatileStore
 * - Pack: PackDirectory, PackReader, PackDeltaStore, GitPackStoreImpl
 * - Factories: createGitFilesBackend(), createGitFilesHistoryFromFiles()
 * - GC: gc(), FileGcStrategy, repack()
 */

// Factory functions
export * from "./create-git-files-backend.js";
export * from "./create-git-files-history-with-ops.js";
// GC
export * from "./gc.js";
export * from "./gc-strategy.js";
// Pack file management (file-dependent)
export * from "./pack/index.js";
// Refs (file-dependent)
export * from "./refs/index.js";
// Repack
export * from "./repack.js";
// Storage implementations (file-dependent)
export * from "./storage/index.js";
// Workspace implementations (file-dependent)
export * from "./workspace/index.js";
