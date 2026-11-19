/**
 * WorkingCopy implementations
 *
 * Provides implementations of the WorkingCopy interface.
 * File-based implementations moved to @statewalker/vcs-store-files.
 */

// Checkout utilities
export * from "./checkout-conflict-detector.js";
export * from "./checkout-utils.js";
// Skip-worktree entries present in the worktree (git's clear_skip_worktree_from_present_files)
export * from "./present-skip-worktree.js";
// Repository state
export * from "./repository-state.js";
// The sparse-checkout patterns (git's path_in_sparse_checkout)
export * from "./sparse-checkout-patterns.js";
// Stash (memory only - file-based moved to store-files)
export * from "./stash-store.memory.js";
// The trees of a stash (index, worktree, untracked), as git stash push builds them
export * from "./stash-trees.js";
// Memory implementation
export * from "./working-copy.memory.js";
