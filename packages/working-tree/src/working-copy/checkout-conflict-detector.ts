/**
 * Checkout conflict detection using three-way comparison.
 *
 * Detects conflicts that would occur during checkout:
 * - Dirty working tree (local modifications would be lost)
 * - Dirty index (staged changes would be lost)
 * - Untracked files (would be overwritten)
 *
 * Uses three-way comparison between HEAD, index, and target tree.
 */

import type { ObjectId, TreeEntry, Trees } from "@statewalker/vcs-core";
import type { Staging } from "../staging/staging.js";
import type { Worktree } from "../worktree/worktree.js";

import {
  CheckoutConflictType,
  collectThreeWayEntries,
  type WorktreeCheckoutConflict,
} from "./checkout-utils.js";

/**
 * Dependencies for checkout conflict detection.
 */
export interface CheckoutConflictDetectorDeps {
  /** Tree storage for loading tree entries */
  trees: Trees;
  /** Staging area (index) */
  staging: Staging;
  /** Working tree iterator for checking file status */
  worktree: Worktree;
}

/**
 * Options for conflict detection.
 */
export interface DetectConflictsOptions {
  /** Skip checking for untracked files (faster but less safe) */
  skipUntracked?: boolean;
  /** Paths to check (if undefined, check all paths) */
  paths?: string[];
}

/**
 * Result of conflict detection.
 */
export interface ConflictDetectionResult {
  /** List of conflicts found */
  conflicts: WorktreeCheckoutConflict[];
  /** True if checkout can proceed safely */
  canCheckout: boolean;
  /** Summary of conflict types */
  summary: {
    dirtyWorktree: number;
    dirtyIndex: number;
    untrackedFiles: number;
  };
}

/**
 * Detect conflicts that would occur during checkout.
 *
 * Compares:
 * - HEAD tree (current state)
 * - Index (staging area)
 * - Target tree (what we're checking out to)
 * - Working tree (actual files)
 *
 * @param deps Required stores and iterators
 * @param headTreeId Current HEAD's tree ID (undefined for empty repo)
 * @param targetTreeId Target tree ID to checkout to
 * @param options Detection options
 * @returns Conflict detection result
 */
export async function detectCheckoutConflicts(
  deps: CheckoutConflictDetectorDeps,
  headTreeId: ObjectId | undefined,
  targetTreeId: ObjectId,
  options: DetectConflictsOptions = {},
): Promise<ConflictDetectionResult> {
  const conflicts: WorktreeCheckoutConflict[] = [];
  const summary = {
    dirtyWorktree: 0,
    dirtyIndex: 0,
    untrackedFiles: 0,
  };

  // Build index map for quick lookup
  const indexEntries = new Map<
    string,
    { objectId: ObjectId; mode: number; size: number; mtime: number }
  >();
  for await (const entry of deps.staging.entries()) {
    // Only consider stage 0 (merged) entries
    if (entry.stage === 0) {
      indexEntries.set(entry.path, {
        objectId: entry.objectId,
        mode: entry.mode,
        size: entry.size,
        mtime: entry.mtime,
      });
    }
  }

  // Collect all paths from HEAD and target trees
  const pathsToCheck = new Set<string>();

  for await (const entry of collectThreeWayEntries(
    deps.trees,
    headTreeId,
    headTreeId, // ours = HEAD for checkout
    targetTreeId,
  )) {
    // Filter by paths if specified
    if (options.paths) {
      if (!matchesPathFilter(entry.path, options.paths)) {
        continue;
      }
    }
    pathsToCheck.add(entry.path);
  }

  // Check each path for conflicts
  for (const path of pathsToCheck) {
    const conflict = await checkPathForConflict(deps, path, indexEntries, headTreeId, targetTreeId);
    if (conflict) {
      conflicts.push(conflict);
      switch (conflict.type) {
        case CheckoutConflictType.DIRTY_WORKTREE:
          summary.dirtyWorktree++;
          break;
        case CheckoutConflictType.DIRTY_INDEX:
          summary.dirtyIndex++;
          break;
        case CheckoutConflictType.UNTRACKED_FILE:
          summary.untrackedFiles++;
          break;
      }
    }
  }

  // Check for untracked files that would be overwritten
  if (!options.skipUntracked) {
    for await (const wtEntry of deps.worktree.walk()) {
      if (wtEntry.isDirectory || wtEntry.isIgnored) continue;

      // Filter by paths if specified
      if (options.paths && !matchesPathFilter(wtEntry.path, options.paths)) {
        continue;
      }

      // Skip if already in index (not untracked)
      if (indexEntries.has(wtEntry.path)) continue;

      // Check if target tree has this path
      const targetEntry = await getTreeEntry(deps.trees, targetTreeId, wtEntry.path);
      if (targetEntry) {
        conflicts.push({
          path: wtEntry.path,
          type: CheckoutConflictType.UNTRACKED_FILE,
          message: `Untracked file '${wtEntry.path}' would be overwritten by checkout`,
        });
        summary.untrackedFiles++;
      }
    }
  }

  return {
    conflicts,
    canCheckout: conflicts.length === 0,
    summary,
  };
}

/**
 * Check a single path for checkout conflicts.
 */
async function checkPathForConflict(
  deps: CheckoutConflictDetectorDeps,
  path: string,
  indexEntries: Map<string, { objectId: ObjectId; mode: number; size: number; mtime: number }>,
  headTreeId: ObjectId | undefined,
  targetTreeId: ObjectId,
): Promise<WorktreeCheckoutConflict | undefined> {
  // Get entry from all three trees
  const headEntry = headTreeId ? await getTreeEntry(deps.trees, headTreeId, path) : undefined;
  const targetEntry = await getTreeEntry(deps.trees, targetTreeId, path);
  const indexEntry = indexEntries.get(path);

  // If target and HEAD are the same, no conflict possible
  if (headEntry && targetEntry && headEntry.id === targetEntry.id) {
    return undefined;
  }

  // Check 1: Index differs from HEAD (staged changes)
  if (indexEntry && headEntry && indexEntry.objectId !== headEntry.id) {
    return {
      path,
      type: CheckoutConflictType.DIRTY_INDEX,
      message: `Staged changes in '${path}' would be lost`,
    };
  }

  // Check 2: File would be deleted but has local modifications
  if (headEntry && !targetEntry && indexEntry) {
    const isModified = await isWorktreeModified(deps.worktree, path, indexEntry);
    if (isModified) {
      return {
        path,
        type: CheckoutConflictType.DIRTY_WORKTREE,
        message: `Modified file '${path}' would be deleted by checkout`,
      };
    }
  }

  // Check 3: Working tree differs from index (local modifications would be overwritten)
  if (indexEntry && targetEntry) {
    const isModified = await isWorktreeModified(deps.worktree, path, indexEntry);
    if (isModified) {
      // Only conflict if target differs from HEAD
      if (!headEntry || headEntry.id !== targetEntry.id) {
        return {
          path,
          type: CheckoutConflictType.DIRTY_WORKTREE,
          message: `Local changes in '${path}' would be overwritten by checkout`,
        };
      }
    }
  }

  return undefined;
}

/**
 * Check if a file in the working tree is modified compared to the index.
 */
async function isWorktreeModified(
  worktree: Worktree,
  path: string,
  indexEntry: { objectId: ObjectId; size: number; mtime: number },
): Promise<boolean> {
  const wtEntry = await worktree.getEntry(path);

  // File deleted in worktree
  if (!wtEntry) {
    return true;
  }

  // Quick check: if size differs and index size is known (>0), definitely modified
  // Note: index size may be 0 when staging was reset from a tree (trees don't store sizes)
  if (indexEntry.size > 0 && wtEntry.size !== indexEntry.size) {
    return true;
  }

  // Compute hash for accurate comparison
  const wtHash = await worktree.computeHash(path);
  return wtHash !== indexEntry.objectId;
}

/**
 * Get a tree entry by path, handling nested directories.
 */
async function getTreeEntry(
  trees: Trees,
  treeId: ObjectId,
  path: string,
): Promise<TreeEntry | undefined> {
  const parts = path.split("/");
  let currentTreeId = treeId;

  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const entry = await trees.getEntry(currentTreeId, name);

    if (!entry) {
      return undefined;
    }

    if (i === parts.length - 1) {
      return entry;
    }

    // Navigate into subtree
    if (entry.mode === 0o040000) {
      currentTreeId = entry.id;
    } else {
      // Path component is not a directory
      return undefined;
    }
  }

  return undefined;
}

/**
 * Check if a path matches any of the filter paths.
 */
function matchesPathFilter(path: string, filters: string[]): boolean {
  for (const filter of filters) {
    if (path === filter || path.startsWith(`${filter}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Create a conflict detection function with dependencies pre-bound.
 */
export function createCheckoutConflictDetector(deps: CheckoutConflictDetectorDeps) {
  return (
    headTreeId: ObjectId | undefined,
    targetTreeId: ObjectId,
    options?: DetectConflictsOptions,
  ) => detectCheckoutConflicts(deps, headTreeId, targetTreeId, options);
}
