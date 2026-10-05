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
