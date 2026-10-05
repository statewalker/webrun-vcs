/**
 * Reference handling
 *
 * Manages Git refs (branches, tags, HEAD) stored in .git/refs/
 * and .git/packed-refs.
 */

export * from "./ref-directory.js";
// Legacy interface - export only RefStore and RefStoreLocation (RefUpdateResult from new interface)
export type { RefStore } from "./ref-store.js";
export { RefStoreLocation } from "./ref-store.js";
export * from "./ref-store.memory.js";
export * from "./ref-types.js";
export * from "./reflog-types.js";
// New implementations (Phase C2)
export * from "./refs.impl.js";
// New interfaces (Phase C) - primary source for RefUpdateResult, Refs
export * from "./refs.js";
