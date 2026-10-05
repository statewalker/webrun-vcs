/**
 * WorkingCopy implementations
 *
 * Provides implementations of the WorkingCopy interface.
 * File-based implementations moved to @statewalker/vcs-store-files.
 */

// Checkout utilities
export * from "./checkout-conflict-detector.js";
export * from "./checkout-utils.js";
// Repository state
export * from "./repository-state.js";
// Stash (memory only - file-based moved to store-files)
export * from "./stash-store.memory.js";
// Memory implementation
export * from "./working-copy.memory.js";
