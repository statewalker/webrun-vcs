/**
 * IndexDiff calculator implementation.
 *
 * Computes three-way diff between HEAD tree, staging area (index),
 * and working tree. Based on JGit's IndexDiff class.
 *
 * The algorithm walks all three sources and categorizes each path:
 * - added: in index, not in HEAD
 * - changed: in index with different content from HEAD
 * - removed: in HEAD, not in index
 * - missing: in index, not on disk
 * - modified: on disk with different content from index
 * - untracked: on disk, not in index
 * - conflicting: multi-stage entries in index
 */

import type { ObjectId, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { MergeStageValue, StagingEntry } from "../staging/index.js";
import type { Staging } from "../staging/staging.js";
import type { WorktreeEntry } from "../worktree/index.js";
import type { Worktree } from "../worktree/worktree.js";
import type { IndexDiff, IndexDiffCalculator, IndexDiffOptions } from "./index-diff.js";
import { createEmptyIndexDiff } from "./index-diff.js";
import { getStageState, type StageStateValue } from "./status-calculator.js";

/**
 * Dependencies for IndexDiff calculation.
 */
export interface IndexDiffDependencies {
  /** Tree storage for accessing HEAD tree */
  readonly trees: Trees;
  /** Staging area (index) */
  readonly staging: Staging;
  /** Worktree interface */
  readonly worktree: Worktree;
}

/**
 * Create an IndexDiff calculator.
 *
 * @param deps Dependencies for calculation
 * @param headTreeId HEAD tree ObjectId (undefined for empty repository)
 * @returns IndexDiffCalculator instance
 */
export function createIndexDiffCalculator(
  deps: IndexDiffDependencies,
  headTreeId: ObjectId | undefined,
): IndexDiffCalculator {
  return new IndexDiffCalculatorImpl(deps, headTreeId);
}

/**
 * IndexDiff calculator implementation.
 */
class IndexDiffCalculatorImpl implements IndexDiffCalculator {
  constructor(
    private readonly deps: IndexDiffDependencies,
    private readonly headTreeId: ObjectId | undefined,
  ) {}

  async calculate(options?: IndexDiffOptions): Promise<IndexDiff> {
    const result = createEmptyIndexDiff();
    const opts = normalizeOptions(options);

    // Step 1: Build HEAD tree map (path -> objectId)
    const headMap = await this.buildHeadMap(opts.pathPrefix);

    // Step 2: Build index maps
    const { indexMap, conflictMap } = await this.buildIndexMaps(opts.pathPrefix);

    // Step 3: Process conflicts first
    for (const [path, stages] of conflictMap) {
      (result.conflicting as Set<string>).add(path);
      const stageState = getStageStateFromMap(stages);
      (result.conflictingStageStates as Map<string, StageStateValue>).set(path, stageState);
    }

    // Step 4: Compare HEAD vs index (staged changes)
    for (const [path, headObjectId] of headMap) {
      const indexEntry = indexMap.get(path);
      if (!indexEntry) {
        // In HEAD but not in index (stage 0) - check if conflicting
        if (!conflictMap.has(path)) {
          (result.removed as Set<string>).add(path);
        }
      } else if (indexEntry.objectId !== headObjectId) {
        (result.changed as Set<string>).add(path);
      }
    }

    for (const [path, entry] of indexMap) {
      if (!headMap.has(path)) {
        (result.added as Set<string>).add(path);
      }

      // Track assume-unchanged files
      if (opts.respectAssumeUnchanged && entry.assumeValid) {
        (result.assumeUnchanged as Set<string>).add(path);
      }
    }

    // Step 5: Walk working tree and compare with index
    if (opts.includeUntracked) {
      await this.processWorkingTree(result, indexMap, conflictMap, opts);
    } else {
      // Only check indexed files for modifications
      await this.checkIndexedFilesForModifications(result, indexMap, opts);
    }

    return result;
  }

  /**
   * Build map of HEAD tree entries (path -> objectId).
   */
  private async buildHeadMap(pathPrefix?: string): Promise<Map<string, ObjectId>> {
    const map = new Map<string, ObjectId>();

    if (!this.headTreeId) {
      return map;
    }

    await this.walkTreeRecursive(this.headTreeId, "", map, pathPrefix);
    return map;
  }

  /**
   * Recursively walk a tree and add entries to the map.
   */
  private async walkTreeRecursive(
    treeId: ObjectId,
    prefix: string,
    map: Map<string, ObjectId>,
    pathPrefix?: string,
  ): Promise<void> {
    const treeEntries = await this.deps.trees.load(treeId);
    if (!treeEntries) {
      return;
    }
    for await (const entry of treeEntries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Check path prefix filter
      if (pathPrefix && !path.startsWith(pathPrefix) && !pathPrefix.startsWith(path)) {
        continue;
      }

      if (entry.mode === FileMode.TREE) {
        // Recurse into subdirectory
        await this.walkTreeRecursive(entry.id, path, map, pathPrefix);
      } else {
        // Add file entry
        if (!pathPrefix || path.startsWith(pathPrefix)) {
          map.set(path, entry.id);
        }
      }
    }
  }

  /**
   * Build maps from staging area.
   */
  private async buildIndexMaps(pathPrefix?: string): Promise<{
    indexMap: Map<string, StagingEntry>;
    conflictMap: Map<string, Map<MergeStageValue, StagingEntry>>;
  }> {
    const indexMap = new Map<string, StagingEntry>();
    const conflictMap = new Map<string, Map<MergeStageValue, StagingEntry>>();

    for await (const entry of this.deps.staging.entries()) {
      // Check path prefix filter
      if (pathPrefix && !entry.path.startsWith(pathPrefix)) {
        continue;
      }

      if (entry.stage === 0) {
        // Normal entry (stage 0)
        indexMap.set(entry.path, entry);
      } else {
        // Conflict entry (stage 1-3)
        let stages = conflictMap.get(entry.path);
        if (!stages) {
          stages = new Map();
          conflictMap.set(entry.path, stages);
        }
        stages.set(entry.stage, entry);
      }
    }

    return { indexMap, conflictMap };
  }

  /**
   * Process working tree for untracked, modified, and missing files.
   */
  private async processWorkingTree(
    result: IndexDiff,
    indexMap: Map<string, StagingEntry>,
    conflictMap: Map<string, Map<MergeStageValue, StagingEntry>>,
    opts: NormalizedOptions,
  ): Promise<void> {
    const seenPaths = new Set<string>();
    const untrackedDirs = new Set<string>();

    for await (const wtEntry of this.deps.worktree.walk({
      includeIgnored: opts.includeIgnored,
      pathPrefix: opts.pathPrefix,
    })) {
      if (wtEntry.isDirectory) {
        continue;
      }

      seenPaths.add(wtEntry.path);
      const indexEntry = indexMap.get(wtEntry.path);
      const hasConflict = conflictMap.has(wtEntry.path);

      if (!indexEntry && !hasConflict) {
        // Not in index - untracked or ignored
        if (wtEntry.isIgnored) {
          if (opts.includeIgnored) {
            (result.ignoredNotInIndex as Set<string>).add(wtEntry.path);
          }
        } else {
          (result.untracked as Set<string>).add(wtEntry.path);
          // Track parent as untracked folder
          const parent = getParentPath(wtEntry.path);
          if (parent) {
            untrackedDirs.add(parent);
          }
        }
      } else if (indexEntry) {
        // In index - check for modification
        if (opts.respectAssumeUnchanged && indexEntry.assumeValid) {
          // Skip assume-unchanged files
          continue;
        }

        const isModified = await this.isFileModified(wtEntry, indexEntry);
        if (isModified) {
          (result.modified as Set<string>).add(wtEntry.path);
        }
      }
    }

    // Find missing files (in index but not on disk)
    for (const [path, _entry] of indexMap) {
      if (!seenPaths.has(path)) {
        (result.missing as Set<string>).add(path);
      }
    }

    // Add untracked folders
    for (const dir of untrackedDirs) {
      (result.untrackedFolders as Set<string>).add(dir);
    }
  }

  /**
   * Check only indexed files for modifications (when not including untracked).
   */
  private async checkIndexedFilesForModifications(
    result: IndexDiff,
    indexMap: Map<string, StagingEntry>,
    opts: NormalizedOptions,
  ): Promise<void> {
    for (const [path, indexEntry] of indexMap) {
      if (opts.respectAssumeUnchanged && indexEntry.assumeValid) {
        continue;
      }

      const wtEntry = await this.deps.worktree.getEntry(path);
      if (!wtEntry) {
        (result.missing as Set<string>).add(path);
      } else {
        const isModified = await this.isFileModified(wtEntry, indexEntry);
        if (isModified) {
          (result.modified as Set<string>).add(path);
        }
      }
    }
  }

  /**
   * Check if a working tree file differs from index entry.
   */
  private async isFileModified(wtEntry: WorktreeEntry, indexEntry: StagingEntry): Promise<boolean> {
    // Quick check: size mismatch
    if (wtEntry.size !== indexEntry.size) {
      return true;
    }

    // Quick check: mtime unchanged and within safe threshold
    // If mtime is older than index update time, file is probably unchanged
    // (This is the "racily clean" optimization - we trust mtime for older files)
    const mtimeDelta = wtEntry.mtime - indexEntry.mtime;
    if (Math.abs(mtimeDelta) < 1000 && wtEntry.size === indexEntry.size) {
      // mtime within 1 second and same size - need hash check
      // Fall through to content comparison
    } else if (wtEntry.mtime === indexEntry.mtime && wtEntry.size === indexEntry.size) {
      // Exact match - assume unchanged
      return false;
    }

    // Full check: compute content hash
    const wtHash = await this.deps.worktree.computeHash(wtEntry.path);
    return wtHash !== indexEntry.objectId;
  }
}

/**
 * Normalized options with defaults applied.
 */
interface NormalizedOptions {
  includeIgnored: boolean;
  includeUntracked: boolean;
  pathPrefix?: string;
  respectAssumeUnchanged: boolean;
}

/**
 * Normalize options with defaults.
 */
function normalizeOptions(options?: IndexDiffOptions): NormalizedOptions {
  return {
    includeIgnored: options?.includeIgnored ?? false,
    includeUntracked: options?.includeUntracked ?? true,
    pathPrefix: options?.pathPrefix,
    respectAssumeUnchanged: options?.respectAssumeUnchanged ?? true,
  };
}

/**
 * Get StageState from conflict stage map.
 */
function getStageStateFromMap(stages: Map<MergeStageValue, StagingEntry>): StageStateValue {
  const hasBase = stages.has(1);
  const hasOurs = stages.has(2);
  const hasTheirs = stages.has(3);
  return getStageState(hasBase, hasOurs, hasTheirs);
}

/**
 * Get parent path from a file path.
 */
function getParentPath(path: string): string | undefined {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.substring(0, lastSlash) : undefined;
}
