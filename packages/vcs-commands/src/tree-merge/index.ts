/**
 * Path-level three-way tree merge shared by the commands that replay one
 * tree's changes onto another (`rebase`, `stash apply`).
 *
 * Internal: not re-exported from `src/index.ts`.
 */

export { mergeTreesThreeWay, type TreeMergeResult } from "./tree-merge.js";
