/**
 * Which tree paths may reach a folder: git's `verify_path` rules. A path from a fetched tree is
 * data from another machine; one that names `.git`, climbs out with `..` or is not a plain
 * relative path is refused before anything is written.
 */

/** A fetched tree holds a path no folder may receive. */
export class UnsafePathError extends Error {
  constructor(readonly path: string) {
    super(`refusing unsafe path in tree: ${JSON.stringify(path)}`);
    this.name = "UnsafePathError";
  }
}

/**
 * Whether `path` (`dir/file.txt`) is safe to write into a folder: relative, no empty, `.` or
 * `..` component, no `.git` component in any letter case (nor its NTFS/HFS spellings `.git.`,
 * `.git `, `git~1`), no backslash and no NUL.
 */
export function isSafePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return false;
    const name = part.toLowerCase().replace(/[. ]+$/, "");
    if (name === ".git" || name === "git~1") return false;
  }
  return true;
}

/** Throws {@link UnsafePathError} for the first unsafe path. */
export function assertSafePaths(paths: Iterable<string>): void {
  for (const path of paths) if (!isSafePath(path)) throw new UnsafePathError(path);
}
