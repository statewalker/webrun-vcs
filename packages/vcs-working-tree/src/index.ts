export * from "./checkout/index.js";
export * from "./ignore/index.js";
export * from "./staging/index.js";
export * from "./status/index.js";
export * from "./working-copy/index.js";
export * from "./working-copy.js";
export * from "./worktree/index.js";

// Note: transformation/ is NOT re-exported here due to type name conflicts
// with staging/ (ConflictInfo, ConflictType, ResolutionStrategy) and
// working-copy.ts (MergeState, RebaseState, etc.).
// Import transformation types directly:
// import { ... } from "@statewalker/vcs-working-tree/transformation";
