/**
 * Worktree - Filesystem abstraction (Part 2 of Three-Part Architecture)
 *
 * Worktree provides access to the user's working directory.
 * It abstracts the filesystem to support:
 * - File-based repositories (normal Git)
 * - In-memory worktrees (testing, virtual filesystems)
 *
 * Worktree is:
 * - User-facing: The files the user edits
 * - Mutable: Changes as user edits files
 * - Separate from staging: Changes must be explicitly staged
 *
 * @see History for immutable repository history (Part 1)
 * @see Checkout for mutable local state (Part 3)
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { WorktreeEntry } from "./types.js";

// Re-export types for consumers
export type { WorktreeEntry, WorktreeStoreOptions } from "./types.js";

/**
 * Options for walking the worktree.
 * Named differently to avoid conflict with history's WalkOptions.
 */
export interface WorktreeWalkOptions {
  /** Include ignored files (default: false) */
  includeIgnored?: boolean;
  /** Include directories in output (default: false) */
  includeDirectories?: boolean;
  /** Path prefix to filter */
  pathPrefix?: string;
  /** Custom ignore patterns (in addition to .gitignore) */
  ignorePatterns?: string[];
  /** Maximum depth to traverse (undefined = unlimited) */
  maxDepth?: number;
}

/**
 * Options for writing content.
 */
export interface WorktreeWriteOptions {
  /**
   * File mode (default: 0o100644 for regular files). `0o100755` sets the
   * executable bit where the worktree can; `0o120000` (symlink) makes the
   * content the link target, written as a symbolic link where the worktree can
   * create one and as a plain file holding the target otherwise (git with
   * `core.symlinks=false`). See {@link Worktree.capabilities}.
   */
  mode?: number;
  /** Overwrite existing file (default: true) */
  overwrite?: boolean;
  /** Create parent directories (default: true) */
  createParents?: boolean;
  /**
   * A forced checkout (`reset --hard`): a file or symbolic link standing where a parent
   * directory must go is unlinked (never followed), as git does with `state->force`.
   * Without it such a path is refused.
   */
  replaceInTheWay?: boolean;
}

/**
 * Options for checkout operations.
 */
export interface WorktreeCheckoutOptions {
  /** Force overwrite even if working tree has modifications */
  force?: boolean;
  /** Paths to checkout (undefined = all) */
  paths?: string[];
  /** Dry run - report what would be done without making changes */
  dryRun?: boolean;
}

/**
 * Result of a checkout operation.
 */
export interface WorktreeCheckoutResult {
  /** Paths that were updated */
  updated: string[];
  /** Paths that were removed */
  removed: string[];
  /** Paths with conflicts */
  conflicts: string[];
  /** Paths that failed to checkout */
  failed: Array<{ path: string; error: string }>;
}

/**
 * What a worktree can represent of git's file modes: what `git init` probes
 * the filesystem for and records as `core.filemode` and `core.symlinks`.
 */
export interface WorktreeCapabilities {
  /** Files written with mode `0o100755` are executable. */
  executable: boolean;
  /** Files written with mode `0o120000` become symbolic links. */
  symlinks: boolean;
  /**
   * The worktree is on Windows: `\` is a path separator there, and checkout applies git's
   * Windows path rules (`isValidWorktreePath(path, mode, { windows: true })`).
   */
  windowsPaths?: boolean;
}

/**
 * Worktree interface - filesystem abstraction
 *
 * This is the primary interface for working with the working directory.
 */
export interface Worktree {
  /**
   * What the worktree can represent. Undefined means both executables and
   * symlinks (an in-memory worktree keeps the mode it is given).
   */
  readonly capabilities?: WorktreeCapabilities;

  /**
   * Probes whether the storage folds case (`core.ignorecase`) and Unicode composition
   * (`core.precomposeunicode`), as `git init` does. Absent, or both false, for storage that
   * folds neither (memory).
   */
  probeCaseFolding?(): Promise<{ ignoreCase: boolean; precomposeUnicode: boolean }>;

  // ========== Reading ==========

  walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry>;
  getEntry(path: string): Promise<WorktreeEntry | undefined>;
  computeHash(path: string): Promise<ObjectId>;
  readContent(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  isIgnored(path: string): Promise<boolean>;

  // ========== Writing ==========

  writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;

  // ========== Checkout Operations ==========

  checkoutTree(
    treeId: ObjectId,
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult>;
  checkoutPaths(
    treeId: ObjectId,
    paths: string[],
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult>;

  // ========== Metadata ==========

  getRoot(): string;
  refreshIgnore(): Promise<void>;
}

/**
 * Extended Worktree interface with additional capabilities.
 */
export interface WorktreeExtended extends Worktree {
  pathsEqual?(path1: string, path2: string): boolean;
  getAttributes?(path: string): Promise<{ executable?: boolean; symlinkTarget?: string }>;
  setAttributes?(
    path: string,
    attrs: { executable?: boolean; symlinkTarget?: string },
  ): Promise<void>;
  watch?(
    callback: (events: Array<{ path: string; type: "add" | "change" | "remove" }>) => void,
  ): () => void;
}
