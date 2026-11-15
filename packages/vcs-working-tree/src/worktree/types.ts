/**
 * Worktree types - Shared types for worktree operations
 */

import type { FileModeValue } from "@statewalker/vcs-core";

/**
 * Represents a file or directory in the worktree (Part 2 of Three-Part Architecture).
 */
export interface WorktreeEntry {
  /** Relative path from repository root */
  path: string;
  /** Entry name (last path component) */
  name: string;
  /** File mode (regular, executable, symlink, directory) */
  mode: FileModeValue | number;
  /** File size in bytes (0 for directories) */
  size: number;
  /** Last modified time (milliseconds since epoch) */
  mtime: number;
  /** Status change time (milliseconds since epoch), where the worktree knows it */
  ctime?: number;
  /** Nanoseconds of `mtime` within its second, where the worktree knows them */
  mtimeNs?: number;
  /** Nanoseconds of `ctime` within its second */
  ctimeNs?: number;
  /** Device, inode, owner and group, where the worktree knows them (git's stat data) */
  dev?: number;
  ino?: number;
  uid?: number;
  gid?: number;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Whether file is ignored by .gitignore */
  isIgnored: boolean;
}

/**
 * Options for worktree iteration.
 */
export interface WorktreeStoreOptions {
  /** Include ignored files (default: false) */
  includeIgnored?: boolean;
  /** Include directories in output (default: false) */
  includeDirectories?: boolean;
  /** Path prefix to filter (default: "" for all) */
  pathPrefix?: string;
  /** Custom ignore patterns (in addition to .gitignore) */
  ignorePatterns?: string[];
}
