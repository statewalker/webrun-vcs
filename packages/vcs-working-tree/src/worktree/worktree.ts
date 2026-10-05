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
  /** File mode (default: 0o100644 for regular files) */
  mode?: number;
  /** Overwrite existing file (default: true) */
  overwrite?: boolean;
  /** Create parent directories (default: true) */
  createParents?: boolean;
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
 * Worktree interface - filesystem abstraction
 *
 * This is the primary interface for working with the working directory.
 */
export interface Worktree {
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
