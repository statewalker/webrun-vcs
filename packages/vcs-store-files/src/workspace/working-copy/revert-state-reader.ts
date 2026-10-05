/**
 * Revert state reader for parsing Git revert-in-progress state.
 *
 * Reads revert state from Git files:
 * - .git/REVERT_HEAD: Commit being reverted
 * - .git/MERGE_MSG: Revert commit message
 */

import type { RevertState } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for revert state reading
 */
export interface RevertStateFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * Read revert state from Git repository.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @returns Revert state if revert in progress, undefined otherwise
 */
export async function readRevertState(
  files: RevertStateFilesApi,
  gitDir: string,
): Promise<RevertState | undefined> {
  // Check if REVERT_HEAD exists
  const revertHeadPath = `${gitDir}/REVERT_HEAD`;
  const revertHeadContent = await files.read(revertHeadPath);
  if (!revertHeadContent) return undefined;

  const revertHead = new TextDecoder().decode(revertHeadContent).trim();
  if (!revertHead) return undefined;

  // Read MERGE_MSG (optional - contains the revert message)
  const mergeMsgPath = `${gitDir}/MERGE_MSG`;
  const mergeMsgContent = await files.read(mergeMsgPath);
  const message = mergeMsgContent ? new TextDecoder().decode(mergeMsgContent) : undefined;

  return {
    revertHead,
    message,
  };
}
