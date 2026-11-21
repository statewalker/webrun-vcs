// Shared types (canonical source)

// Cache-tree (TREE extension)
export * from "./cache-tree.js";
// Utilities
export * from "./conflict-utils.js";
// Staging implementations
export * from "./git-staging.js";
// Index extensions kept or dropped on rewrite
export * from "./index-extensions.js";
// Index file: lock-file protocol for writes
export * from "./index-file.js";
// Index format (DIRC parsing/serialization)
export * from "./index-format.js";
// Sparse index (sdir): expanded on read, collapsed on write
export * from "./sparse-index.js";
// Split index (link): shared index merged on read, split on write
export * from "./split-index.js";
// Staging interface
export * from "./staging.js";
export * from "./staging-edits.js";
// Index refresh: fresh stats, compare-and-set
export * from "./stat-refresh.js";
export * from "./types.js";
// git's is_index_unborn
export * from "./unborn-index.js";
