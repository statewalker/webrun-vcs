/**
 * Abstract file system interface for VCS operations.
 *
 * All library code should depend only on this interface, not on specific
 * implementations. This allows seamless switching between in-memory storage
 * (for tests), Node.js filesystem, and cloud storage backends.
 */

/**
 * Options for reading file content with optional range support.
 */
export interface ReadOptions {
  /** Start offset in bytes */
  start?: number;
  /** Number of bytes to read */
  length?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Options for listing directory entries.
 *
 * Declared here rather than re-exported from `@statewalker/webrun-files` on
 * purpose: `FilesApi` is the abstraction that keeps vcs independent of any
 * particular backend, and re-exporting webrun's type would reintroduce exactly
 * the coupling it exists to avoid. The two are kept key-for-key identical by a
 * conformance assertion in `tests/files/list-options.test.ts`.
 */
export interface ListOptions {
  /** If true, lists all descendants recursively. Defaults to false. */
  recursive?: boolean;
  /**
   * Yield only entries whose path sorts strictly after this one (webrun-files
   * 0.10 `ListOptions.after`). The implementations come from webrun-files,
   * which honour it; this declaration only keeps the key sets in step.
   */
  after?: string;
}

/**
 * Metadata about a file or directory.
 */
export interface FileStats {
  /** Whether this is a file or directory */
  kind: "file" | "directory";
  /** Size in bytes (meaningful for files) */
  size?: number;
  /** Last modification timestamp in milliseconds since Unix epoch */
  lastModified?: number;
}

/**
 * Abstract file system interface for VCS operations.
 *
 * NOTE: No readFile() method - use utility functions instead:
 * - readFile(files, path) - read entire file as Uint8Array
 * - readText(files, path) - read entire file as string
 * - tryReadFile(files, path) - read or return undefined
 * - tryReadText(files, path) - read text or return undefined
 */
export interface FilesApi {
  /**
   * Stream read file content with optional range support.
   * @param path - File path
   * @param options - Read options (start, len, signal)
   */
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>;

  /** Write content to file (creates parent dirs) */
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  /** Create directory (recursive) */
  mkdir(path: string): Promise<void>;

  /** Remove file or directory */
  remove(path: string): Promise<boolean>;

  /** Get file/directory stats */
  stats(path: string): Promise<FileStats | undefined>;

  /**
   * List directory entries.
   * @param path - Directory path
   * @param options - List options (recursive)
   */
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;

  /** Check if path exists */
  exists(path: string): Promise<boolean>;

  /** Move file or directory */
  move(source: string, target: string): Promise<boolean>;

  /** Copy file or directory */
  copy(source: string, target: string): Promise<boolean>;

  /**
   * Create `path` with `content` only if nothing exists there (creating parent
   * directories); `false` if it already exists. Optional, as in webrun-files: a real
   * exclusive create (`open "wx"` on Node, Web Locks in the browser, a transaction in
   * sqlite, a synchronous reservation in memory) where the backend has one.
   */
  createExclusive?(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<boolean>;

  /**
   * Append `content` to the file at `path`, creating it (and its parent directories) when
   * missing, as `open(O_WRONLY | O_APPEND | O_CREAT)` does: the file is never rewritten,
   * so its cost does not grow with its size (git appends reflogs, `rebase-merge/done` and
   * `rewritten-list` so). Optional: without it a caller reads and rewrites the file. Fails
   * with `code` "EISDIR" when a directory is at `path`.
   */
  append?(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
}

/**
 * Metadata about a file or directory entry returned from list().
 */
export interface FileInfo {
  /** The base name of the entry (without path) */
  name: string;
  /** The full path to the entry */
  path: string;
  /** Whether this entry is a file or directory */
  kind: "file" | "directory";
  /** Size in bytes (meaningful for files) */
  size?: number;
  /** Last modification timestamp in milliseconds since Unix epoch */
  lastModified?: number;
}

/**
 * What {@link PosixFilesApi.lstat} reports of one entry: the entry itself, a symbolic link
 * is not followed (POSIX `lstat`).
 */
export interface LinkStats {
  /** A file, a directory, a symbolic link, or anything else (a FIFO, socket, device) */
  kind: "file" | "directory" | "symlink" | "other";
  /** Length in bytes: of the file, or of the link target; 0 for a directory */
  size: number;
  /** Modification time in milliseconds since the epoch */
  lastModified: number;
  /** Status change time in milliseconds since the epoch, where the storage keeps one */
  ctime?: number;
  /** POSIX permission bits (`0o755`), where the storage keeps them */
  mode?: number;
  /** Nanoseconds of the modification time within its second, where the storage keeps them */
  mtimeNs?: number;
  /** Nanoseconds of the status change time within its second */
  ctimeNs?: number;
  /** Device and inode (their low 32 bits), owner and group, where the storage has them */
  dev?: number;
  ino?: number;
  uid?: number;
  gid?: number;
}

/**
 * A FilesApi over storage that holds symbolic links (and, optionally, POSIX modes): a local
 * filesystem (`createNodeFilesApi`), or any FilesApi wrapped to simulate links
 * (`createSymlinkFilesApi`). Every member is optional and feature-detected; worktrees,
 * checkout and workspace sync rely on this contract only, never on a real filesystem.
 *
 * **Links.** A symbolic link is an entry of its own, holding a target (bytes). It is never
 * followed by any operation of this API:
 * - *Beneath a link.* A path one of whose leading components is a link lies wherever the
 *   link points; it is neither present nor absent. `lstat`, `read`, `write`,
 *   `createExclusive`, `mkdir`, `list`, `stats`, `remove`, `move`, `copy`, `chmod`,
 *   `symlink` and `readlink` reject it with `BeyondSymlinkError`; `exists` answers false.
 * - *At a link.* `lstat` reports `kind: "symlink"` with the target's length as `size`;
 *   `stats` and `list` report a file of that size; `read` yields nothing; `list` of the link
 *   yields nothing (it is no directory); `write` replaces the link by a regular file, never
 *   writing into its target; `remove` unlinks it (a dangling one too); `move` and `copy`
 *   carry the link itself; `exists` is true (dangling too); `chmod` refuses it.
 * - Recursive `list` never descends into a link.
 *
 * **Modes.** With `chmod` and a `mode` in `lstat`, permission bits are kept; `write` of an
 * existing regular file keeps its bits, a new file gets the storage's default.
 *
 * **Paths.** `pathSeparators` names the characters the storage splits names on: `"/\\"` on
 * Windows, where `a\b` would be `a` / `b` (worktrees then apply git's Windows path rules);
 * `"/"` or absent elsewhere, where `\` is part of a name.
 *
 * **Case.** A storage that folds case (or Unicode composition) resolves `A` and `a` (or
 * NFC and NFD spellings) to one entry; nothing in the API announces it: a repository probes
 * for it once (`probeCaseFolding`), as `git init` does.
 *
 * @example
 * ```typescript
 * const files: PosixFilesApi = createNodeFilesApi({ rootDir: "/repo" });
 * const stats = await files.lstat?.("/link");
 * if (stats?.kind === "symlink") console.log(await files.readlink?.("/link"));
 * ```
 */
export interface PosixFilesApi extends FilesApi {
  /**
   * The characters the storage reads as path separators: `"/\\"` on Windows, where a `\` in
   * a name would split it; `"/"` (or absent) elsewhere.
   */
  readonly pathSeparators?: string;
  /**
   * True when every operation refuses a path beneath a link by itself, as this contract
   * requires of an implementation with `lstat`: a caller need not check leading components
   * again (doing so costs an `lstat` per component per call).
   */
  readonly refusesBeyondLinks?: boolean;
  /**
   * Names the storage keeps for itself at its root (`createSymlinkFilesApi`'s table): a
   * worktree rooted there must not check out a tree entry of that name (in any case).
   */
  readonly reservedNames?: string[];
  /**
   * The real (absolute, platform) directory the storage is rooted at, when it is one (a
   * local filesystem): an absolute path a repository recorded (a submodule's `gitdir:
   * /abs/.git/modules/sub`) names a path of this FilesApi when it lies inside it. Absent
   * where the storage has no such directory (memory, browsers): such paths stay unreadable.
   */
  readonly rootDirectory?: string;
  /** Set the permission bits (`mode & 0o777`) of a file; refuses a link */
  chmod?(path: string, mode: number): Promise<void>;
  /**
   * Create a symbolic link at `path` pointing to `target` (bytes, as stored in a tree).
   * Parent directories are created as needed; an existing entry at `path` is an error.
   */
  symlink?(target: Uint8Array, path: string): Promise<void>;
  /**
   * The entry at `path` itself, a symbolic link not followed; undefined if nothing is there.
   * A path beneath a symbolic link is neither: it throws `BeyondSymlinkError`.
   */
  lstat?(path: string): Promise<LinkStats | undefined>;
  /** The target of the symbolic link at `path` (bytes); undefined if it is not a link */
  readlink?(path: string): Promise<Uint8Array | undefined>;
  /**
   * Removes the directory at `path` only if it is empty, as `rmdir(2)`: never recursively,
   * so an entry created meanwhile makes it fail rather than vanish. False when nothing is
   * there, it is no directory (a link to one included) or it is not empty.
   */
  rmdir?(path: string): Promise<boolean>;
  /**
   * A FilesApi rooted at the directory the link at `path` points to, for a link the caller
   * chose to follow (a `.git` linked to a repository elsewhere, which git follows), when the
   * target lies beyond what this FilesApi can name (outside its root). Undefined when `path`
   * is no link to a directory, or the storage cannot reach the target.
   */
  openLinkTarget?(path: string): Promise<PosixFilesApi | undefined>;
  /**
   * A view of the same storage for one batch of operations (a worktree walk, a checkout's
   * writes) that may cache which directories it verified not to be links, as git's
   * per-command lstat cache; the caller drops it when the batch ends. The instance itself
   * never caches across calls, so a change made outside is always seen.
   */
  withLstatCache?(): PosixFilesApi;
}
