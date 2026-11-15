/**
 * Which tree paths may reach a folder: git's `verify_path` rules, with its NTFS and HFS+
 * spellings of `.git` (`is_ntfs_dotgit`, `is_hfs_dotgit`). A path from a fetched tree is data
 * from another machine; one that names `.git`, climbs out with `..` or is not a plain relative
 * path is refused before anything is written.
 */

/**
 * The prefix of the temporary files a checkout writes before moving them in place. Reserved:
 * folder files named so are never committed, and fetched trees holding such names are refused.
 */
export const SYNC_TEMP_MARK = ".vcs-sync-tmp-";

/** A fetched tree holds a path no folder may receive. */
export class UnsafePathError extends Error {
  constructor(readonly path: string) {
    super(`refusing unsafe path in tree: ${JSON.stringify(path)}`);
    this.name = "UnsafePathError";
  }
}

/** Code points HFS+ ignores in names (git's `next_hfs_char`): `.g‌it` is `.git` there. */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * `.git` as NTFS or HFS+ may spell it: any letter case, trailing dots and spaces, the 8.3 short
 * name `git~1`, and an alternate data stream (`.git::$INDEX_ALLOCATION`).
 */
const DOTGIT = /^(\.git|git~1)[. ]*(:|$)/;

/**
 * Whether `path` (`dir/file.txt`) is safe to write into a folder: relative, no empty, `.` or
 * `..` component, no component that a filesystem may take for `.git` (see above), no
 * backslash, no NUL, and no component with the reserved temporary-file prefix.
 */
export function isSafePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return false;
    const name = part.replace(HFS_IGNORABLE, "").toLowerCase();
    if (DOTGIT.test(name)) return false;
    if (part.startsWith(SYNC_TEMP_MARK)) return false;
  }
  return true;
}

/** Throws {@link UnsafePathError} for the first unsafe path. */
export function assertSafePaths(paths: Iterable<string>): void {
  for (const path of paths) if (!isSafePath(path)) throw new UnsafePathError(path);
}
