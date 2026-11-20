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

import type { History, ObjectId } from "@statewalker/vcs-core";
import type { LinkedWorktrees } from "../linked-worktrees/index.js";
import type { UntrackedScanHost } from "../status/untracked-scan.js";
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
   * Called with the path of each directory whose listing failed (unreadable), and the
   * error the listing failed with: the walk goes on without its content, so a caller
   * removing what it lists keeps that directory (git warns "could not open directory").
   */
  onUnreadable?: (path: string, error?: unknown) => void;
  /**
   * Files (anything but a directory) for which this answers true are passed over: not
   * yielded, and neither stat'ed nor matched against the ignore rules where the worktree can
   * tell a file from a directory without a stat. An untracked-file scan passes the index's
   * paths, as git's directory walk asks the index first (`treat_path`). Optional to honour:
   * a worktree may still yield such files, so a caller checks them again.
   */
  skipFile?: (path: string) => boolean;
}

/** Whether a directory holds a repository of its own, as far as the worktree can tell. */
export type NestedRepositoryState = "repository" | "none" | "unknown";

/**
 * The commit checked out in a nested repository (git's `resolve_gitlink_ref` of its HEAD):
 * `"none"` when there is no repository or no commit there (git's `check_removed` then takes
 * a tracked file's directory for its removal), `"unknown"` when it cannot be read here.
 */
export type GitlinkHeadState =
  | { state: "commit"; head: ObjectId }
  | { state: "none" }
  | { state: "unknown" };

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
   * With `replaceInTheWay`: a directory standing where the file goes is removed with
   * whatever it holds (git's `UNPACK_RESET_OVERWRITE_UNTRACKED`: `reset --hard`,
   * `checkout -f`). Without it only a directory holding nothing but ignored files and empty
   * directories is removed; an untracked file or a nested repository in it refuses the
   * write (thrown), so nothing a caller did not verify as expendable is lost.
   */
  discardUntracked?: boolean;
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
   * Whether the storage folds case (`README` and `readme` one file), looked at without
   * writing anything; undefined when there is nothing to tell by. A restore with
   * `core.ignorecase` guards against case variants unless this is false.
   */
  foldsCase?(): Promise<boolean | undefined>;

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

  /**
   * Sets how `core.ignoreCase` is read for the ignore rules: with it, rules match ASCII
   * letters in either case, as in git (`*.TXT` ignores `a.txt`; `É` never matches `é`).
   * Working copies set it from their configuration.
   */
  setIgnoreCaseReader?(read: (() => boolean) | undefined): void;

  /**
   * Sets how a `.gitignore` absent from the worktree is read from the index: the function
   * gets the file's path (`.gitignore`, `dir/.gitignore`) and returns the text of its index
   * entry when that entry is skip-worktree, else undefined. git reads such a file's patterns
   * from the index (dir.c `read_skip_worktree_file_from_index`), so a sparse checkout that
   * removed a directory still ignores, and un-ignores, what its `.gitignore` says. Working
   * copies set it from their staging area.
   */
  setSkipWorktreeIgnoreReader?(
    read: ((path: string) => Promise<string | undefined>) | undefined,
  ): void;

  // ========== Reading ==========

  walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry>;
  /**
   * What `scanUntracked` (git's directory walk with the untracked cache) reads of this
   * worktree, the repository's exclude files loaded: directories in readdir order, stats,
   * `.gitignore` files with their bytes. Call it within a `batch` (the ignore rules it
   * loads serve the rest of the batch). Optional: without it untracked files are found
   * through `walk`, and no untracked cache is used.
   */
  untrackedScanHost?(): Promise<UntrackedScanHost>;
  getEntry(path: string): Promise<WorktreeEntry | undefined>;
  /**
   * {@link getEntry} of many paths at once, the answers in the order of `paths`: the stat
   * pass of status, diff, `add -u` and `commit -a` over every index entry (git's
   * `refresh_index`). Optional: callers fall back to `getEntry` per path
   * (`getWorktreeEntries`).
   */
  getEntries?(paths: readonly string[]): Promise<Array<WorktreeEntry | undefined>>;
  /**
   * The blob id of the file at `path`: of its content as the content filter cleans it (what
   * `git add` would store), a symbolic link's target as it is.
   */
  computeHash(path: string): Promise<ObjectId>;
  /** The file's content as it is on disk (never converted). */
  readContent(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  /**
   * Whether the ignore rules exclude `path`, judged as a directory when one is there, or
   * with `asDirectory` whatever is there (a pathspec element ending in "/", as git's
   * `is_excluded` judges it).
   */
  isIgnored(path: string, asDirectory?: boolean): Promise<boolean>;

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
   * The commit checked out in the repository at `path`, or whether there is none
   * (`"none"`: no repository, or no commit) or it cannot be read here (`"unknown"`).
   */
  gitlinkHeadState?(path: string): Promise<GitlinkHeadState>;

  /**
   * The repository checked out in the submodule at `path`, opened as a working copy (its
   * own HEAD, index, config and worktree), so its status can be read as git's
   * `is_submodule_modified` reads it; undefined when it is not populated or its repository
   * cannot be read here (beyond the storage's root).
   *
   * With `options.name`, a path that holds no repository (a submodule not checked out, or
   * one whose directory is gone) falls back to the repository git keeps for the submodule
   * of that name, `<gitdir>/modules/<name>` (git's `submodule_to_gitdir`); its worktree is
   * still rooted at `path`.
   */
  openGitlink?(path: string, options?: { name?: string }): Promise<WorkingCopy | undefined>;

  /**
   * The repository a local remote names (`../other`, `/srv/repo.git`, the path of a
   * `file://` URL), opened over this worktree's storage, as git's upload-pack and
   * receive-pack find it (`enter_repo`): `<path>/.git`, `<path>`, `<path>.git/.git`, then
   * `<path>.git`, a gitfile followed. A relative location is read from the worktree top
   * (where git runs a fetch), an absolute one in the real directory the storage is rooted
   * at (from its root when that is unknown). Undefined when no repository is there or it
   * lies beyond the storage's root.
   */
  openRepository?(location: string): Promise<OpenedRepository | undefined>;

  /**
   * The repository directory of the submodule at `path`, in this worktree's FilesApi: its
   * `.git` directory, or the place its gitfile names (resolved as git resolves it, whether a
   * repository is there or not). Null when the gitfile names a place this FilesApi cannot
   * reach (above its root, or an absolute path outside it); undefined without a `.git`.
   */
  gitlinkRepository?(path: string): Promise<string | null | undefined>;

  /**
   * git's `connect_work_tree_and_git_dir` after a submodule moved to `path`: its gitfile
   * written to name `gitDir` (as {@link gitlinkRepository} gave it before the move)
   * relative to the new place, and the repository's `core.worktree` set to the new place
   * relative to it.
   */
  connectGitlink?(path: string, gitDir: string): Promise<void>;

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

  /**
   * Whether the entry at `path` is a FIFO, socket or device: there, but nothing git can add
   * ("can only add regular files, symbolic links or git-directories"). `getEntry` gives
   * undefined for it, as for a missing path; this tells the two apart.
   */
  isSpecialFile?(path: string): Promise<boolean>;
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

/** A repository {@link Worktree.openRepository} opened. */
export interface OpenedRepository {
  /** Its objects and refs (HEAD the one of the git directory opened) */
  history: History;
  /** Its git directory, in the storage's paths */
  gitDir: string;
  /**
   * Its repository directory: the one a linked worktree's git directory names in
   * `commondir`, else `gitDir`
   */
  commonDir?: string;
  /**
   * Whether it has no working tree (`core.bare`, else no `.git` directory name; a linked
   * worktree's git directory never is)
   */
  bare: boolean;
  /** Its configuration, as git reads it there (system, global, then the repository's) */
  config?: OpenedRepositoryConfig;
  /** Its worktrees: the main one and the linked ones (git's `get_worktrees`) */
  worktrees?: LinkedWorktrees;
}

/** The configuration of an {@link OpenedRepository}, values as written. */
export interface OpenedRepositoryConfig {
  /** Every value of `key` in the order git reads them; null for a key without `=` */
  getAll(key: string): Array<string | null>;
  /** Every entry in the order git reads them */
  list(): Array<{ key: string; value: string | null }>;
}
