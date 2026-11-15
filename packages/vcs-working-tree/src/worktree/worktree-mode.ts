/**
 * The mode to stage for a worktree file, as git's `ce_mode_from_stat`.
 */

import { FileMode } from "@statewalker/vcs-core";

/** What the worktree's modes can be trusted for (`core.filemode`, `core.symlinks`). */
export interface WorktreeModeTrust {
  /** The executable bit read from the worktree is real (`core.filemode`). */
  executable: boolean;
  /** Symbolic links read from the worktree are real (`core.symlinks`). */
  symlinks: boolean;
  /**
   * The change time (ctime) is compared with the index's (`core.trustctime`, and not
   * `core.checkStat=minimal`). Absent: compared, as git's default.
   */
  ctime?: boolean;
}

/**
 * The mode to stage for a file the worktree reports with `worktreeMode`, given the mode the
 * index has for it (if any), as git's `ce_mode_from_stat`:
 * - without trusted symlinks, a regular file where the index has a symlink stays a symlink
 *   (the file holds the link target, as checkout wrote it);
 * - without a trusted executable bit, a regular file keeps the index's regular or executable
 *   mode, and a new one is `100644`.
 *
 * @example
 * ```typescript
 * // core.filemode=false: the worktree cannot show the bit, the index keeps it
 * modeFromWorktree(FileMode.REGULAR_FILE, FileMode.EXECUTABLE_FILE, {
 *   executable: false,
 *   symlinks: true,
 * }); // FileMode.EXECUTABLE_FILE
 * ```
 */
export function modeFromWorktree(
  worktreeMode: number,
  indexMode: number | undefined,
  trust: WorktreeModeTrust,
): number {
  const regular =
    worktreeMode === FileMode.REGULAR_FILE || worktreeMode === FileMode.EXECUTABLE_FILE;
  if (!regular) return worktreeMode;
  if (!trust.symlinks && indexMode === FileMode.SYMLINK) return FileMode.SYMLINK;
  if (!trust.executable) {
    if (indexMode === FileMode.REGULAR_FILE || indexMode === FileMode.EXECUTABLE_FILE) {
      return indexMode;
    }
    return FileMode.REGULAR_FILE;
  }
  return worktreeMode;
}
