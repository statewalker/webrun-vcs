/**
 * Patch parsing and application types based on JGit implementation
 *
 * @see https://github.com/eclipse-jgit/jgit/tree/master/org.eclipse.jgit/src/org/eclipse/jgit/patch
 */

/**
 * Options for parsing and applying patches
 */
export interface PatchOptions {
  /** Allow conflicts to be marked in the output */
  allowConflicts?: boolean;
  /** Character encoding for text patches (default: 'utf-8') */
  charset?: string;
}

/**
 * Error encountered during patch parsing or application
 */
export interface FormatError {
  /** Error message */
  message: string;
  /** Byte offset where error occurred */
  offset: number;
  /** Severity level */
  severity: "error" | "warning";
  /** Line number (if known) */
  line?: number;
}

/**
 * Type of patch encoding
 */
export enum PatchType {
  /** Standard unified diff format */
  UNIFIED = "UNIFIED",
  /** Binary files differ marker */
  BINARY = "BINARY",
  /** Git binary patch with delta or literal */
  GIT_BINARY = "GIT_BINARY",
}

/**
 * Type of change in a file
 */
export enum ChangeType {
  /** File was added */
  ADD = "ADD",
  /** File was deleted */
  DELETE = "DELETE",
  /** File was modified */
  MODIFY = "MODIFY",
  /** File was renamed */
  RENAME = "RENAME",
  /** File was copied */
  COPY = "COPY",
}

/**
 * Type of binary hunk encoding
 */
export enum BinaryHunkType {
  /** Literal file content (deflated, base85 encoded) */
  LITERAL_DEFLATED = "LITERAL_DEFLATED",
  /** Delta from old to new (deflated, base85 encoded) */
  DELTA_DEFLATED = "DELTA_DEFLATED",
}

/**
 * Unix file mode
 */
export interface FileMode {
  /** Raw mode value (e.g., 0o100644) */
  mode: number;
  /** True if file has execute permission */
  isExecutable: boolean;
  /** True if file is a symbolic link */
  isSymlink: boolean;
  /** True if file is a regular file */
  isRegular: boolean;
  /** True if file is a directory */
  isDirectory: boolean;
}

/**
 * Git object identifier (SHA-1 hash)
 */
export interface ObjectId {
  /** Hex-encoded hash */
  hash: string;
  /** True if hash is abbreviated (not full 40 characters) */
  abbreviated: boolean;
}

/**
 * Result of applying a patch
 */
export interface ApplyResult {
  /** Git tree ID (if applicable) */
  treeId?: string;
  /** List of modified file paths */
  paths: string[];
  /** Errors encountered during application */
  errors: ApplyError[];
}

/**
 * Error encountered while applying a patch
 */
export interface ApplyError {
  /** Error message */
  message: string;
  /** File path where error occurred */
  path: string;
  /** Hunk that failed to apply (if applicable) */
  hunk?: number;
  /** True if error resulted in a Git conflict marker */
  isGitConflict: boolean;
}

/**
 * Creates a FileMode from a numeric mode
 */
export function createFileMode(mode: number): FileMode {
  const type = mode & 0o170000;
  return {
    mode,
    isExecutable: (mode & 0o111) !== 0,
    isSymlink: type === 0o120000,
    isRegular: type === 0o100000,
    isDirectory: type === 0o040000,
  };
}

/**
 * Creates an ObjectId from a hex string
 */
export function createObjectId(hash: string): ObjectId {
  return {
    hash: hash.toLowerCase(),
    abbreviated: hash.length < 40,
  };
}
