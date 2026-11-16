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
import type { WorkingCopy } from "../working-copy.js";
import type { ContentAttributesContext, WorktreeContentFilter } from "./content-filter.js";
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
  /**
   * Also list and enter a `.git` inside a directory that holds no repository (an empty or
   * fake `.git` directory, a dangling `.git` link, a gitfile naming no repository), and the
   * directory itself: what `git clean` removes there. Nested repositories are still not
   * entered. Off by default (a `.git` is never listed).
   */
  enterNonRepositoryGitDirs?: boolean;
  /**
   * Called with the path of each directory whose listing failed (unreadable): the walk goes
   * on without its content, so a caller removing what it lists keeps that directory.
   */
  onUnreadable?: (path: string) => void;
}

/** Whether a directory holds a repository of its own, as far as the worktree can tell. */
export type NestedRepositoryState = "repository" | "none" | "unknown";

/** Options for removing a worktree entry. */
export interface WorktreeRemoveOptions {
  /** Remove a directory with everything in it */
  recursive?: boolean;
  /**
   * Accept `.git` components that name no repository (what
   * {@link WorktreeWalkOptions.enterNonRepositoryGitDirs} lists); a real repository's
   * `.git` is still refused
   */
  nonRepositoryGitDirs?: boolean;
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
  /**
   * Write the content as it is, without the worktree's content filter (git's smudge:
   * end-of-line conversion, `ident`, `working-tree-encoding`, filter drivers). By default a
   * regular file is smudged where a filter is installed ({@link Worktree.setContentFilter}).
   */
  raw?: boolean;
  /**
   * Where the smudge reads the file's attributes: a checkout of a tree passes the index it
   * leaves behind (`direction: "checkout"`, git's unpack-trees). Default: the worktree's
   * `.gitattributes`, then the current index's (git's `checkout -- <path>`).
   */
  attributes?: ContentAttributesContext;
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
  /**
   * Top-level names the worktree's storage reserves (a simulated-links table at its root):
   * restore plans refuse a tree entry of such a name, in any case.
   */
  reservedNames?: string[];
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

  /**
   * Runs `fn` as one batch of operations (a checkout's checks and writes), which may share
   * a cache of directories verified not to be links and one reading of the ignore rules
   * (`.gitignore` files, exclude files), both dropped when the batch ends. Outside a batch,
   * every walk and ignore check reads the rules afresh.
   */
  batch?<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * The content filter (git's clean and smudge conversions) this worktree applies, when one
   * is installed: {@link computeHash} hashes a regular file as its filter cleans it, and
   * {@link writeContent} smudges what it writes. {@link readContent} always gives the file
   * as it is on disk.
   */
  readonly contentFilter?: WorktreeContentFilter;

  /**
   * Installs (or, with undefined, removes) the content filter. Working copies install git's
   * (`createGitContentFilter`) unless one is installed already.
   */
  setContentFilter?(filter: WorktreeContentFilter | undefined): void;

  /**
   * Reads a file of the repository's git directory (`info/attributes`), where the worktree
   * knows it; undefined when absent.
   */
  readGitDirFile?(path: string): Promise<Uint8Array | undefined>;

  /**
   * Sets how the global excludes file (`core.excludesFile`, by default
   * `$XDG_CONFIG_HOME/git/ignore`) is read when the worktree was given none: the function
   * returns its text, or undefined when there is none. Working copies set it from their
   * configuration chain and the host's environment.
   */
  setExcludesFileReader?(read: (() => Promise<string | undefined>) | undefined): void;

  // ========== Reading ==========

  walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry>;
  getEntry(path: string): Promise<WorktreeEntry | undefined>;
  /**
   * The blob id of the file at `path`: of its content as the content filter cleans it (what
   * `git add` would store), a symbolic link's target as it is.
   */
  computeHash(path: string): Promise<ObjectId>;
  /** The file's content as it is on disk (never converted). */
  readContent(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  isIgnored(path: string): Promise<boolean>;

  // ========== Writing ==========

  /**
   * Writes a file; a regular file's content is smudged by the content filter unless
   * `options.raw` is set.
   */
  writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void>;
  remove(path: string, options?: WorktreeRemoveOptions): Promise<boolean>;
  /**
   * Removes the directory at `path` only if it holds nothing at all (git's `rmdir`): no
   * file, link, directory, `.git`, FIFO or ignored file. Returns whether it was removed.
   * Absent: callers fall back to a check through `walk`.
   */
  removeEmptyDirectory?(
    path: string,
    options?: Pick<WorktreeRemoveOptions, "nonRepositoryGitDirs">,
  ): Promise<boolean>;

  /**
   * The commit checked out in the submodule at `path` (its `HEAD`), read from its `.git`
   * directory or `gitdir:` file; undefined when it is not populated or cannot be read.
   */
  readGitlinkHead?(path: string): Promise<ObjectId | undefined>;

  /**
   * The repository checked out in the submodule at `path`, opened as a working copy (its
   * own HEAD, index, config and worktree), so its status can be read as git's
   * `is_submodule_modified` reads it; undefined when it is not populated or its repository
   * cannot be read here (beyond the storage's root).
   */
  openGitlink?(path: string): Promise<WorkingCopy | undefined>;

  /**
   * Whether the directory at `path` holds a repository of its own: a `.git` directory with
   * `HEAD`, `objects` and `refs` (or a `gitdir:` file), as git's `is_nonbare_repository_dir`.
   * An empty `.git` directory is none.
   */
  isRepository?(path: string): Promise<boolean>;

  /**
   * Whether the directory at `path` holds a repository of its own: `"unknown"` when that
   * cannot be checked here (its `.git` names a place beyond the storage's root, or cannot be
   * read). `isRepository` takes an unknown as a repository.
   */
  repositoryState?(path: string): Promise<NestedRepositoryState>;
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
