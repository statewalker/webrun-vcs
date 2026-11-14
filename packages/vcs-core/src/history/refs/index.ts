/**
 * Reference handling
 *
 * Manages Git refs (branches, tags, HEAD) stored in .git/refs/
 * and .git/packed-refs.
 */

export * from "./ref-batch.js";
export * from "./ref-directory.js";
export * from "./ref-name.js";
export * from "./ref-types.js";
export * from "./reflog-lines.js";
export * from "./reflog-types.js";
// New implementations (Phase C2)
export * from "./refs.impl.js";
// New interfaces (Phase C) - primary source for RefUpdateResult, Refs
export * from "./refs.js";
