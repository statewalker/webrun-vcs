/**
 * Worktree path verification, after git's `verify_path` with `core.protectHFS` and
 * `core.protectNTFS` on (CVE-2014-9390).
 *
 * Paths in trees and in the index come from other people's repositories. Checkout turns them
 * into files under the worktree, which also holds the repository's own `.git`. A path is
 * refused when a component is empty, `.` or `..`, or names `.git` under any spelling a
 * filesystem folds to it:
 * - any letter case (`.GIT`, `.Git`: case-insensitive filesystems);
 * - NTFS: trailing dots and spaces dropped (`.git. .`), the 8.3 short name `git~1`, an
 *   alternate data stream (`.git::$INDEX_ALLOCATION`), and `\` as a separator;
 * - HFS+: code points it ignores when comparing names (`‌.git`).
 */

/** Code points HFS+ ignores when comparing names (git's `next_hfs_char`). */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** A component NTFS resolves to `.git`: `.git` or `git~1`, then only dots and spaces, or a stream. */
const NTFS_DOTGIT = /^(?:\.git|git~1)[. ]*(?::.*)?$/i;

function isDotGit(component: string): boolean {
  if (component.replace(HFS_IGNORABLE, "").toLowerCase() === ".git") return true;
  // NTFS also splits components on a backslash.
  return component.split("\\").some((part) => NTFS_DOTGIT.test(part));
}

/** Whether `path` (relative, `/`-separated, as stored in trees and the index) is safe to check out. */
export function isValidWorktreePath(path: string): boolean {
  if (path === "" || path.includes("\0")) return false;
  for (const component of path.split("/")) {
    if (component === "" || component === "." || component === "..") return false;
    if (isDotGit(component)) return false;
  }
  return true;
}

/** Throws unless {@link isValidWorktreePath} accepts `path`. */
export function assertValidWorktreePath(path: string): void {
  if (!isValidWorktreePath(path)) {
    throw new Error(`Invalid worktree path: ${JSON.stringify(path)}`);
  }
}
