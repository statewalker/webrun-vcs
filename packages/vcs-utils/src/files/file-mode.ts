/**
 * File mode constants (following Git/JGit patterns)
 *
 * These are octal values stored in tree entries:
 * - Trees (directories) use 040000
 * - Regular files use 100644 (non-executable) or 100755 (executable)
 * - Symbolic links use 120000
 * - Gitlinks (submodules) use 160000
 */
export const FileMode = {
  /** Directory (tree) */
  TREE: 0o040000,
  /** Regular file (non-executable) */
  REGULAR_FILE: 0o100644,
  /** Executable file */
  EXECUTABLE_FILE: 0o100755,
  /** Symbolic link */
  SYMLINK: 0o120000,
  /** Submodule (gitlink) */
  GITLINK: 0o160000,
} as const;

export type FileModeValue = (typeof FileMode)[keyof typeof FileMode];
