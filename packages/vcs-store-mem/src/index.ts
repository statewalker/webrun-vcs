/**
 * In-memory storage implementations for StateWalker VCS
 *
 * Provides in-memory implementations of all storage interfaces
 * for testing and development purposes.
 */

// Binary storage (new architecture)
export * from "./binary-storage/index.js";
// High-level store implementations
export * from "./commit-store.js";
// Object storage (new architecture)
export * from "./object-storage/index.js";
export * from "./ref-store.js";
export * from "./staging-store.js";
export * from "./tag-store.js";
export * from "./tree-store.js";
