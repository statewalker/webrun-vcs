/**
 * Merge state reader for parsing Git merge-in-progress state.
 *
 * Reads merge state from Git files:
 * - .git/MERGE_HEAD: Commit being merged
 * - .git/ORIG_HEAD: Original HEAD before merge
 * - .git/MERGE_MSG: Merge commit message
 * - .git/MERGE_MODE: Merge mode (empty for normal, 'no-ff' for no-fast-forward)
 */

import type { MergeState } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for merge state reading
 */
export interface MergeStateFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * Read merge state from Git repository.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @returns Merge state if merge in progress, undefined otherwise
 */
export async function readMergeState(
  files: MergeStateFilesApi,
  gitDir: string,
): Promise<MergeState | undefined> {
  // Check if MERGE_HEAD exists
  const mergeHeadPath = `${gitDir}/MERGE_HEAD`;
  const mergeHeadContent = await files.read(mergeHeadPath);
  if (!mergeHeadContent) return undefined;

  const mergeHead = new TextDecoder().decode(mergeHeadContent).trim();
  if (!mergeHead) return undefined;

  // Read ORIG_HEAD
  const origHeadPath = `${gitDir}/ORIG_HEAD`;
  const origHeadContent = await files.read(origHeadPath);
  const origHead = origHeadContent ? new TextDecoder().decode(origHeadContent).trim() : mergeHead; // Fallback to mergeHead if ORIG_HEAD missing

  // Read MERGE_MSG (optional)
  const mergeMsgPath = `${gitDir}/MERGE_MSG`;
  const mergeMsgContent = await files.read(mergeMsgPath);
  const message = mergeMsgContent ? new TextDecoder().decode(mergeMsgContent) : undefined;

  // Read MERGE_MODE (optional)
  const mergeModePath = `${gitDir}/MERGE_MODE`;
  const mergeModeContent = await files.read(mergeModePath);
  const mode = mergeModeContent ? new TextDecoder().decode(mergeModeContent) : undefined;

  return {
    mergeHead,
    origHead,
    message,
    squash: mode?.includes("squash") ?? false,
  };
}
