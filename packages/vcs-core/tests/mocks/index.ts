/**
 * Shared mock implementations for testing
 */

// Re-export the actual MemoryRawStorage as it works well for tests
export { MemoryRawStorage } from "../../src/storage/raw/index.js";
export * from "./mock-commit-store.js";
