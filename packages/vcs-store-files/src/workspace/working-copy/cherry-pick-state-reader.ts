/**
 * Cherry-pick state reader for parsing Git cherry-pick-in-progress state.
 *
 * Reads cherry-pick state from Git files:
 * - .git/CHERRY_PICK_HEAD: Commit being cherry-picked
 * - .git/MERGE_MSG: Cherry-pick commit message
 */

import type { CherryPickState } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for cherry-pick state reading
 */
export interface CherryPickStateFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * Read cherry-pick state from Git repository.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @returns Cherry-pick state if cherry-pick in progress, undefined otherwise
 */
export async function readCherryPickState(
  files: CherryPickStateFilesApi,
  gitDir: string,
): Promise<CherryPickState | undefined> {
  // Check if CHERRY_PICK_HEAD exists
  const cherryPickHeadPath = `${gitDir}/CHERRY_PICK_HEAD`;
  const cherryPickHeadContent = await files.read(cherryPickHeadPath);
  if (!cherryPickHeadContent) return undefined;

  const cherryPickHead = new TextDecoder().decode(cherryPickHeadContent).trim();
  if (!cherryPickHead) return undefined;

  // Read MERGE_MSG (optional - contains the cherry-pick message)
  const mergeMsgPath = `${gitDir}/MERGE_MSG`;
  const mergeMsgContent = await files.read(mergeMsgPath);
  const message = mergeMsgContent ? new TextDecoder().decode(mergeMsgContent) : undefined;

  return {
    cherryPickHead,
    message,
  };
}
