/**
 * Checkout utilities with three-way comparison helpers.
 *
 * Provides reusable utilities for operations that need three-way comparison:
 * - Checkout conflict detection
 * - Merge tree operations
 * - Cherry-pick and rebase
 * - Stash apply
 *
 * Reference: JGit's CheckoutConflictException and TreeWalk
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";

/**
 * Represents a single entry in a three-way comparison.
 * Each field is undefined if the path doesn't exist in that tree.
 */
export interface ThreeWayEntry {
  /** Full path from repository root */
  path: string;
  /** Entry in base (common ancestor) */
  base?: TreeEntry;
  /** Entry in "ours" (current HEAD/branch) */
  ours?: TreeEntry;
  /** Entry in "theirs" (merge source/target) */
  theirs?: TreeEntry;
}

/**
 * Classification of what happened to a path in a three-way comparison.
 */
export const ThreeWayChange = {
  /** Path unchanged across all three trees */
  UNCHANGED: "UNCHANGED",
  /** Added only in ours (not in base or theirs) */
  ADDED_BY_US: "ADDED_BY_US",
  /** Added only in theirs (not in base or ours) */
  ADDED_BY_THEM: "ADDED_BY_THEM",
  /** Added identically in both ours and theirs (not in base) */
  ADDED_BOTH_SAME: "ADDED_BOTH_SAME",
  /** Added differently in ours and theirs - conflict */
  ADDED_BOTH_DIFFER: "ADDED_BOTH_DIFFER",
  /** Deleted only in ours (exists in base and theirs) */
  DELETED_BY_US: "DELETED_BY_US",
  /** Deleted only in theirs (exists in base and ours) */
  DELETED_BY_THEM: "DELETED_BY_THEM",
  /** Deleted in both ours and theirs */
  DELETED_BOTH: "DELETED_BOTH",
  /** Modified only in ours (base and theirs same) */
  MODIFIED_BY_US: "MODIFIED_BY_US",
  /** Modified only in theirs (base and ours same) */
  MODIFIED_BY_THEM: "MODIFIED_BY_THEM",
  /** Modified identically in both ours and theirs */
  MODIFIED_BOTH_SAME: "MODIFIED_BOTH_SAME",
  /** Modified differently in ours and theirs - conflict */
  MODIFIED_BOTH_DIFFER: "MODIFIED_BOTH_DIFFER",
  /** Deleted in ours, modified in theirs - conflict */
  DELETE_MODIFY_CONFLICT: "DELETE_MODIFY_CONFLICT",
  /** Modified in ours, deleted in theirs - conflict */
  MODIFY_DELETE_CONFLICT: "MODIFY_DELETE_CONFLICT",
} as const;

export type ThreeWayChange = (typeof ThreeWayChange)[keyof typeof ThreeWayChange];

/**
 * Result of classifying a three-way entry.
 */
export interface ThreeWayClassification {
  /** Path being classified */
  path: string;
  /** Type of change */
  change: ThreeWayChange;
  /** True if this is a conflict that needs resolution */
  isConflict: boolean;
  /** The entry to use for resolution (if not a conflict) */
  resolvedEntry?: TreeEntry;
}

/**
 * Conflict reason for checkout operations.
 */
export const CheckoutConflictType = {
  /** Local modifications in working tree would be lost */
  DIRTY_WORKTREE: "DIRTY_WORKTREE",
  /** Staged changes would be lost */
  DIRTY_INDEX: "DIRTY_INDEX",
  /** Untracked file would be overwritten */
  UNTRACKED_FILE: "UNTRACKED_FILE",
  /** Cannot delete non-empty directory */
  NOT_DELETED_DIR: "NOT_DELETED_DIR",
} as const;

export type CheckoutConflictType = (typeof CheckoutConflictType)[keyof typeof CheckoutConflictType];

/**
 * Detailed worktree checkout conflict information.
 *
 * Internal type used by checkout conflict detection.
 * Different from the public CheckoutConflict in commands/.
 */
export interface WorktreeCheckoutConflict {
  /** Path with conflict */
  path: string;
  /** Type of conflict */
  type: CheckoutConflictType;
  /** Human-readable message */
  message: string;
}

/**
 * Classify a three-way entry to determine what happened to the path.
 *
 * This implements standard three-way merge classification logic:
 * - If all three are identical: UNCHANGED
 * - If only one differs: that side made the change
 * - If two differ from base identically: both made same change
 * - If two differ from base differently: conflict
 */
export function classifyThreeWayEntry(entry: ThreeWayEntry): ThreeWayClassification {
  const { path, base, ours, theirs } = entry;

  const _baseId = base?.id;
  const _oursId = ours?.id;
  const _theirsId = theirs?.id;

  // Helper to check if entries are equal (same id and mode)
  const equal = (a?: TreeEntry, b?: TreeEntry): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.id === b.id && a.mode === b.mode;
  };

  // All three exist
  if (base && ours && theirs) {
    if (equal(base, ours) && equal(base, theirs)) {
      return { path, change: ThreeWayChange.UNCHANGED, isConflict: false, resolvedEntry: ours };
    }
    if (equal(base, ours)) {
      // Only theirs changed
      return {
        path,
        change: ThreeWayChange.MODIFIED_BY_THEM,
        isConflict: false,
        resolvedEntry: theirs,
      };
    }
    if (equal(base, theirs)) {
      // Only ours changed
      return {
        path,
        change: ThreeWayChange.MODIFIED_BY_US,
        isConflict: false,
        resolvedEntry: ours,
      };
    }
    if (equal(ours, theirs)) {
      // Both changed identically
      return {
        path,
        change: ThreeWayChange.MODIFIED_BOTH_SAME,
        isConflict: false,
        resolvedEntry: ours,
      };
    }
    // Both changed differently - conflict
    return { path, change: ThreeWayChange.MODIFIED_BOTH_DIFFER, isConflict: true };
  }

  // Base exists, but one or both deleted
  if (base && !ours && !theirs) {
    return { path, change: ThreeWayChange.DELETED_BOTH, isConflict: false };
  }
  if (base && !ours && theirs) {
    if (equal(base, theirs)) {
      return { path, change: ThreeWayChange.DELETED_BY_US, isConflict: false };
    }
    // Deleted by us, modified by them - conflict
    return { path, change: ThreeWayChange.DELETE_MODIFY_CONFLICT, isConflict: true };
  }
  if (base && ours && !theirs) {
    if (equal(base, ours)) {
      return { path, change: ThreeWayChange.DELETED_BY_THEM, isConflict: false };
    }
    // Modified by us, deleted by them - conflict
    return { path, change: ThreeWayChange.MODIFY_DELETE_CONFLICT, isConflict: true };
  }

  // No base - additions
  if (!base && ours && !theirs) {
    return { path, change: ThreeWayChange.ADDED_BY_US, isConflict: false, resolvedEntry: ours };
  }
  if (!base && !ours && theirs) {
    return { path, change: ThreeWayChange.ADDED_BY_THEM, isConflict: false, resolvedEntry: theirs };
  }
  if (!base && ours && theirs) {
    if (equal(ours, theirs)) {
      return {
        path,
        change: ThreeWayChange.ADDED_BOTH_SAME,
        isConflict: false,
        resolvedEntry: ours,
      };
    }
    // Added differently - conflict
    return { path, change: ThreeWayChange.ADDED_BOTH_DIFFER, isConflict: true };
  }

  // Should not reach here, but handle gracefully
  return { path, change: ThreeWayChange.UNCHANGED, isConflict: false };
}

/**
 * Flatten a tree into a map of path -> TreeEntry.
 * Recursively traverses subdirectories.
 */
export async function flattenTree(
  trees: Trees,
  treeId: ObjectId | undefined,
  prefix = "",
): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>();

  if (!treeId) {
    return result;
  }

  const treeEntries = await trees.load(treeId);
  if (!treeEntries) {
    return result;
  }

  for await (const entry of treeEntries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    // Check if this is a tree/directory (mode 0o040000)
    if (entry.mode === 0o040000) {
      // Recurse into subdirectory
      const subEntries = await flattenTree(trees, entry.id, path);
      for (const [subPath, subEntry] of subEntries) {
        result.set(subPath, subEntry);
      }
    } else {
      result.set(path, entry);
    }
  }

  return result;
}

/**
 * Collect three-way entries by comparing three trees.
 *
 * Returns an async iterable of ThreeWayEntry for each unique path
 * across all three trees.
 */
export async function* collectThreeWayEntries(
  trees: Trees,
  baseTreeId: ObjectId | undefined,
  oursTreeId: ObjectId | undefined,
  theirsTreeId: ObjectId | undefined,
): AsyncIterable<ThreeWayEntry> {
  // Flatten all three trees
  const [baseEntries, oursEntries, theirsEntries] = await Promise.all([
    flattenTree(trees, baseTreeId),
    flattenTree(trees, oursTreeId),
    flattenTree(trees, theirsTreeId),
  ]);

  // Collect all unique paths
  const allPaths = new Set<string>();
  for (const path of baseEntries.keys()) allPaths.add(path);
  for (const path of oursEntries.keys()) allPaths.add(path);
  for (const path of theirsEntries.keys()) allPaths.add(path);

  // Sort paths for consistent ordering
  const sortedPaths = [...allPaths].sort();

  // Yield three-way entries
  for (const path of sortedPaths) {
    yield {
      path,
      base: baseEntries.get(path),
      ours: oursEntries.get(path),
      theirs: theirsEntries.get(path),
    };
  }
}

/**
 * Perform three-way tree comparison and classify all changes.
 *
 * Returns arrays of classified entries, separated into clean resolutions
 * and conflicts.
 */
export async function compareThreeWayTrees(
  trees: Trees,
  baseTreeId: ObjectId | undefined,
  oursTreeId: ObjectId | undefined,
  theirsTreeId: ObjectId | undefined,
): Promise<{
  resolved: ThreeWayClassification[];
  conflicts: ThreeWayClassification[];
}> {
  const resolved: ThreeWayClassification[] = [];
  const conflicts: ThreeWayClassification[] = [];

  for await (const entry of collectThreeWayEntries(trees, baseTreeId, oursTreeId, theirsTreeId)) {
    const classification = classifyThreeWayEntry(entry);
    if (classification.isConflict) {
      conflicts.push(classification);
    } else {
      resolved.push(classification);
    }
  }

  return { resolved, conflicts };
}

/**
 * Check if a three-way change indicates the file should be taken from "theirs".
 */
export function shouldTakeTheirs(change: ThreeWayChange): boolean {
  return (
    change === ThreeWayChange.ADDED_BY_THEM ||
    change === ThreeWayChange.MODIFIED_BY_THEM ||
    change === ThreeWayChange.DELETED_BY_US
  );
}

/**
 * Check if a three-way change indicates the file should be taken from "ours".
 */
export function shouldTakeOurs(change: ThreeWayChange): boolean {
  return (
    change === ThreeWayChange.ADDED_BY_US ||
    change === ThreeWayChange.MODIFIED_BY_US ||
    change === ThreeWayChange.DELETED_BY_THEM ||
    change === ThreeWayChange.UNCHANGED
  );
}

/**
 * Check if a three-way change indicates the file should be deleted.
 */
export function shouldDelete(change: ThreeWayChange): boolean {
  return change === ThreeWayChange.DELETED_BOTH;
}

/**
 * Check if a three-way change is a conflict.
 */
export function isConflictChange(change: ThreeWayChange): boolean {
  return (
    change === ThreeWayChange.ADDED_BOTH_DIFFER ||
    change === ThreeWayChange.MODIFIED_BOTH_DIFFER ||
    change === ThreeWayChange.DELETE_MODIFY_CONFLICT ||
    change === ThreeWayChange.MODIFY_DELETE_CONFLICT
  );
}

/**
 * Result of an operation that may have conflicts.
 */
export interface MergeTreeResult {
  /** Successfully merged entries with their resolved content */
  merged: Array<{ path: string; entry: TreeEntry }>;
  /** Paths that have conflicts */
  conflicts: Array<{
    path: string;
    change: ThreeWayChange;
    base?: TreeEntry;
    ours?: TreeEntry;
    theirs?: TreeEntry;
  }>;
}

/**
 * Merge two trees using three-way comparison.
 *
 * For non-conflicting changes, determines the correct resolution.
 * For conflicts, includes information about all three versions.
 */
export async function mergeTreesThreeWay(
  trees: Trees,
  baseTreeId: ObjectId | undefined,
  oursTreeId: ObjectId | undefined,
  theirsTreeId: ObjectId | undefined,
): Promise<MergeTreeResult> {
  const result: MergeTreeResult = {
    merged: [],
    conflicts: [],
  };

  for await (const entry of collectThreeWayEntries(trees, baseTreeId, oursTreeId, theirsTreeId)) {
    const classification = classifyThreeWayEntry(entry);

    if (classification.isConflict) {
      result.conflicts.push({
        path: entry.path,
        change: classification.change,
        base: entry.base,
        ours: entry.ours,
        theirs: entry.theirs,
      });
    } else if (classification.resolvedEntry) {
      result.merged.push({
        path: entry.path,
        entry: classification.resolvedEntry,
      });
    }
    // If no resolved entry and not a conflict, the file was deleted
  }

  return result;
}
