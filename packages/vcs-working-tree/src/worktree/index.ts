// Shared types (canonical source)

// The content filter (git's clean / smudge) a worktree applies
export * from "./content-filter.js";
export * from "./filtered-content.js";
// Stream a worktree file through a hasher (size from stat, one retry)
export * from "./hash-worktree-file.js";
// Worktree implementations (memory only - file-based moved to store-files)
export * from "./memory-worktree.js";
// Store a worktree file as a blob (one pass when the size is known)
export * from "./store-worktree-file.js";
export * from "./types.js";
// Worktree interface
export * from "./worktree.js";
// The mode to stage for a worktree file (git's ce_mode_from_stat)
export * from "./worktree-mode.js";
