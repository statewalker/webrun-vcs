/**
 * Rebase state reader for parsing Git rebase-in-progress state.
 *
 * Git stores rebase state in two possible locations:
 * - .git/rebase-merge/: For interactive/merge-based rebase
 * - .git/rebase-apply/: For apply-based rebase (git am)
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { RebaseState } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for rebase state reading
 */
export interface RebaseStateFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
  stats(path: string): Promise<{ isDirectory: boolean } | undefined>;
}

/**
 * Read rebase state from Git repository.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @returns Rebase state if rebase in progress, undefined otherwise
 */
export async function readRebaseState(
  files: RebaseStateFilesApi,
  gitDir: string,
): Promise<RebaseState | undefined> {
  // Check rebase-merge first (interactive rebase)
  const rebaseMergeDir = `${gitDir}/rebase-merge`;
  const rebaseMergeStats = await files.stats(rebaseMergeDir);
  if (rebaseMergeStats?.isDirectory) {
    return readRebaseMergeState(files, rebaseMergeDir);
  }

  // Check rebase-apply (git am style)
  const rebaseApplyDir = `${gitDir}/rebase-apply`;
  const rebaseApplyStats = await files.stats(rebaseApplyDir);
  if (rebaseApplyStats?.isDirectory) {
    return readRebaseApplyState(files, rebaseApplyDir);
  }

  return undefined;
}

/**
 * Read state from rebase-merge directory (interactive rebase).
 *
 * Contents:
 * - head-name: Branch being rebased
 * - onto: Commit being rebased onto
 * - orig-head: Original HEAD
 * - msgnum: Current step number
 * - end: Total steps
 */
async function readRebaseMergeState(
  files: RebaseStateFilesApi,
  rebaseDir: string,
): Promise<RebaseState | undefined> {
  const onto = await readRefFile(files, `${rebaseDir}/onto`);
  const head = await readRefFile(files, `${rebaseDir}/orig-head`);
  const current = await readNumberFile(files, `${rebaseDir}/msgnum`);
  const total = await readNumberFile(files, `${rebaseDir}/end`);

  if (!onto || !head) return undefined;

  return {
    type: "rebase-merge",
    onto,
    head,
    current: current ?? 0,
    total: total ?? 0,
  };
}

/**
 * Read state from rebase-apply directory (git am style).
 *
 * Contents:
 * - head-name: Branch being rebased
 * - onto: Commit being rebased onto
 * - orig-head: Original HEAD
 * - next: Next patch number
 * - last: Total patches
 */
async function readRebaseApplyState(
  files: RebaseStateFilesApi,
  rebaseDir: string,
): Promise<RebaseState | undefined> {
  const onto = await readRefFile(files, `${rebaseDir}/onto`);
  const head = await readRefFile(files, `${rebaseDir}/orig-head`);
  const current = await readNumberFile(files, `${rebaseDir}/next`);
  const total = await readNumberFile(files, `${rebaseDir}/last`);

  // Determine type based on rebasing flag
  const rebasingPath = `${rebaseDir}/rebasing`;
  const rebasingContent = await files.read(rebasingPath);
  const type = rebasingContent ? "rebase-apply" : "rebase";

  if (!onto || !head) return undefined;

  return {
    type,
    onto,
    head,
    current: current ?? 0,
    total: total ?? 0,
  };
}

/**
 * Read a ref file (contains object ID)
 */
async function readRefFile(
  files: RebaseStateFilesApi,
  path: string,
): Promise<ObjectId | undefined> {
  const content = await files.read(path);
  if (!content) return undefined;
  return new TextDecoder().decode(content).trim();
}

/**
 * Read a number file
 */
async function readNumberFile(
  files: RebaseStateFilesApi,
  path: string,
): Promise<number | undefined> {
  const content = await files.read(path);
  if (!content) return undefined;
  const str = new TextDecoder().decode(content).trim();
  const num = parseInt(str, 10);
  return Number.isNaN(num) ? undefined : num;
}
