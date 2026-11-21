/**
 * File-backed storage backend for StateWalker VCS
 *
 * Provides file-dependent implementations of storage interfaces:
 * - Storage: filesStagingStore (object kernel), FileRawStorage (gc, repack)
 * - Objects: withPacks (packs first, then loose objects)
 * - Factories: createGitFilesBackend(), createGitFilesHistoryFromFiles()
 * - Maintenance: repack(), gc(), FileGcStrategy
 */

// Alternate object directories (objects/info/alternates)
export * from "./alternates/index.js";
// The commit-graph: settings, provider, writeCommitGraph
export * from "./commit-graph.js";
// Factory functions
export * from "./create-git-files-backend.js";
export * from "./create-git-files-history-with-ops.js";
// GC
export * from "./gc.js";
export * from "./gc-strategy.js";
// Pack file management (file-dependent)
export * from "./pack/index.js";
// Quarantine for received packs (receive-pack)
export * from "./quarantine/index.js";
// Reachability roots (refs, reflogs, index) for repack and gc
export * from "./reachable-objects.js";
// Refs (file-dependent)
export * from "./refs/index.js";
// Repack
export * from "./repack.js";
// core.repositoryformatversion and extensions.*, checked as git does
export * from "./repository-format.js";
// A `.git` or `.git/objects` linked elsewhere, resolved through the FilesApi
export * from "./resolve-linked-git-dir.js";
// Storage implementations (file-dependent)
export * from "./storage/index.js";
// Workspace implementations (file-dependent)
export * from "./workspace/index.js";
