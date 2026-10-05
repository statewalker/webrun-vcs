/**
 * Repository state detector.
 *
 * Detects the current repository state by checking for Git state files.
 * Based on JGit's Repository.getRepositoryState() method.
 *
 * State files are checked in order of priority:
 * 1. rebase-merge/ or rebase-apply/ (rebase states)
 * 2. MERGE_HEAD (merge states)
 * 3. CHERRY_PICK_HEAD (cherry-pick states)
 * 4. REVERT_HEAD (revert states)
 * 5. BISECT_LOG (bisect state)
 */

import { RepositoryState, type RepositoryStateValue } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for state detection
 */
export interface StateDetectorFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
  exists(path: string): Promise<boolean>;
}

/**
 * Detect current repository state from Git files.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param hasConflicts Whether the staging area has conflicts
 * @returns The current repository state
 */
export async function detectRepositoryState(
  files: StateDetectorFilesApi,
  gitDir: string,
  hasConflicts: boolean,
): Promise<RepositoryStateValue> {
  // Check rebase states first (highest priority)
  const rebaseState = await detectRebaseState(files, gitDir);
  if (rebaseState) return rebaseState;

  // Check MERGE_HEAD
  if (await files.exists(`${gitDir}/MERGE_HEAD`)) {
    return hasConflicts ? RepositoryState.MERGING : RepositoryState.MERGING_RESOLVED;
  }

  // Check CHERRY_PICK_HEAD
  if (await files.exists(`${gitDir}/CHERRY_PICK_HEAD`)) {
    return hasConflicts ? RepositoryState.CHERRY_PICKING : RepositoryState.CHERRY_PICKING_RESOLVED;
  }

  // Check REVERT_HEAD
  if (await files.exists(`${gitDir}/REVERT_HEAD`)) {
    return hasConflicts ? RepositoryState.REVERTING : RepositoryState.REVERTING_RESOLVED;
  }

  // Check BISECT_LOG
  if (await files.exists(`${gitDir}/BISECT_LOG`)) {
    return RepositoryState.BISECTING;
  }

  // No operation in progress
  return RepositoryState.SAFE;
}

/**
 * Detect rebase state from rebase directories.
 *
 * Checks both rebase-merge/ (interactive/merge rebase) and
 * rebase-apply/ (apply-based rebase, git am style).
 */
async function detectRebaseState(
  files: StateDetectorFilesApi,
  gitDir: string,
): Promise<RepositoryStateValue | undefined> {
  // Check rebase-merge/ first (interactive or merge-based rebase)
  const rebaseMergeDir = `${gitDir}/rebase-merge`;
  if (await files.exists(rebaseMergeDir)) {
    // Check if interactive rebase
    if (await files.exists(`${rebaseMergeDir}/interactive`)) {
      return RepositoryState.REBASING_INTERACTIVE;
    }
    return RepositoryState.REBASING_MERGE;
  }

  // Check rebase-apply/ (apply-based rebase or git am)
  const rebaseApplyDir = `${gitDir}/rebase-apply`;
  if (await files.exists(rebaseApplyDir)) {
    // Check if this is git am (applying patches) or rebase
    if (await files.exists(`${rebaseApplyDir}/applying`)) {
      return RepositoryState.APPLY;
    }
    // rebasing file indicates regular rebase, but both are REBASING state
    return RepositoryState.REBASING;
  }

  return undefined;
}
