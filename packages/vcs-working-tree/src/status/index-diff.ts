/**
 * IndexDiff - Three-way diff between HEAD, index, and working tree.
 *
 * Provides detailed diff results for status calculation, computing
 * all changes between the last commit (HEAD), staging area (index),
 * and filesystem (working tree).
 *
 * Based on JGit's IndexDiff class.
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/IndexDiff.java
 *
 * @example Computing status from IndexDiff
 * ```typescript
 * const diff = await indexDiffCalculator.calculate();
 *
 * // Staged changes (what would be committed)
 * console.log("Staged:");
 * for (const path of diff.added) console.log(`  new file: ${path}`);
 * for (const path of diff.changed) console.log(`  modified: ${path}`);
 * for (const path of diff.removed) console.log(`  deleted: ${path}`);
 *
 * // Unstaged changes (not yet added to index)
 * console.log("Not staged:");
 * for (const path of diff.modified) console.log(`  modified: ${path}`);
 * for (const path of diff.missing) console.log(`  deleted: ${path}`);
 *
 * // Conflicts
 * if (diff.conflicting.size > 0) {
 *   console.log("Conflicts:");
 *   for (const path of diff.conflicting) {
 *     const state = diff.conflictingStageStates.get(path);
 *     console.log(`  ${path}: ${state}`);
 *   }
 * }
 * ```
 */

import type { StageStateValue } from "./status-calculator.js";

/**
 * Three-way diff result between HEAD, index, and working tree.
 *
 * Each set contains file paths relative to the repository root.
 * Paths in the staged category (added/changed/removed) differ from HEAD.
 * Paths in the unstaged category (modified/missing) differ from index.
 */
export interface IndexDiff {
  /**
   * Files added to index (exist in index but not in HEAD).
   * These are new files staged for commit.
   */
  readonly added: Set<string>;

  /**
   * Files changed in index (content/mode differs from HEAD).
   * These are modified files staged for commit.
   */
  readonly changed: Set<string>;

  /**
   * Files removed from index (exist in HEAD but not in index).
   * These are deletions staged for commit.
   */
  readonly removed: Set<string>;

  /**
   * Files missing from working tree (exist in index but not on disk).
   * These are uncommitted deletions not yet staged.
   */
  readonly missing: Set<string>;

  /**
   * Files modified in working tree (content differs from index).
   * These are local changes not yet staged.
   */
  readonly modified: Set<string>;

  /**
   * Files not tracked by Git (exist on disk, not in index or HEAD).
   * New files that haven't been added with `git add`.
   */
  readonly untracked: Set<string>;

  /**
   * Untracked directories (optimization to skip traversal).
   * Directories containing only untracked files.
   */
  readonly untrackedFolders: Set<string>;

  /**
   * Files with merge conflicts (have multi-stage entries in index).
   * Stage 1=base, Stage 2=ours, Stage 3=theirs.
   */
  readonly conflicting: Set<string>;

  /**
   * Detailed conflict stage states by path.
   * Describes what type of conflict occurred (both-modified, delete/modify, etc.).
   */
  readonly conflictingStageStates: Map<string, StageStateValue>;

  /**
   * Ignored files not in index.
   * Only populated if `includeIgnored: true` in options.
   */
  readonly ignoredNotInIndex: Set<string>;

  /**
   * Files with the assume-unchanged flag set in the index.
   * Git skips checking these files for modifications.
   */
  readonly assumeUnchanged: Set<string>;
}

/**
 * Options for IndexDiff calculation.
 */
export interface IndexDiffOptions {
  /** Include ignored files in the diff (default: false) */
  includeIgnored?: boolean;

  /** Include untracked files in the diff (default: true) */
  includeUntracked?: boolean;

  /** Path filter - only consider files under this prefix */
  pathPrefix?: string;

  /** Respect assume-unchanged flag (default: true) */
  respectAssumeUnchanged?: boolean;
}

/**
 * Create an empty IndexDiff result.
 */
export function createEmptyIndexDiff(): IndexDiff {
  return {
    added: new Set(),
    changed: new Set(),
    removed: new Set(),
    missing: new Set(),
    modified: new Set(),
    untracked: new Set(),
    untrackedFolders: new Set(),
    conflicting: new Set(),
    conflictingStageStates: new Map(),
    ignoredNotInIndex: new Set(),
    assumeUnchanged: new Set(),
  };
}

/**
 * IndexDiff calculator interface.
 *
 * Implementations walk HEAD tree, index, and working tree simultaneously
 * to compute the three-way diff.
 */
export interface IndexDiffCalculator {
  /**
   * Calculate diff between HEAD, index, and working tree.
   *
   * @param options Calculation options
   * @returns The complete IndexDiff result
   */
  calculate(options?: IndexDiffOptions): Promise<IndexDiff>;
}
