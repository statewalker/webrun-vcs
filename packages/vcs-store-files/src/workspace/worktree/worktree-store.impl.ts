/**
 * FileTreeIterator - Worktree implementation using FilesApi.
 *
 * Walks a filesystem directory tree and yields entries compatible with
 * Git's worktree operations. Supports:
 * - Recursive directory traversal
 * - .gitignore pattern matching
 * - Content hashing in Git blob format
 * - Sorted output for consistent results
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/treewalk/FileTreeIterator.java
 */

import type { ObjectId } from "@statewalker/vcs-core";
import {
  basename,
  type FileInfo,
  FileMode,
  type FilesApi,
  joinPath,
  readFile,
} from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import type {
  IgnoreManager,
  NewHasher,
  WorktreeEntry,
  WorktreeStoreOptions,
} from "@statewalker/vcs-working-tree";
import { createIgnoreManager, hashWorktreeFile } from "@statewalker/vcs-working-tree";

/**
 * Simplified file entry information for mode determination.
 */
interface SimplifiedFileInfo {
  kind: "file" | "directory";
}

/**
 * Options for creating a FileTreeIterator.
 */
export interface FileTreeIteratorOptions {
  /** FilesApi instance for filesystem operations */
  files: FilesApi;

  /** Root path of the worktree */
  rootPath: string;

  /** Pre-configured IgnoreManager (if not provided, one will be created) */
  ignoreManager?: IgnoreManager;

  /** Whether to auto-load .gitignore files during traversal (default: true) */
  autoLoadGitignore?: boolean;

  /** Path to .git directory (for loading .git/info/exclude) */
  gitDir?: string;

  /** Path to global excludes file (from core.excludesFile config) */
  globalExcludesFile?: string;

  /**
   * Makes the incremental hasher `computeHash` streams a file through
   * (default: SHA-1, `createSha1`).
   */
  newHasher?: NewHasher;
}

/**
 * Default file mode determination based on file attributes.
 *
 * Follows JGit's DefaultFileModeStrategy.
 */
function getFileMode(info: SimplifiedFileInfo, hasGitDir: boolean): number {
  if (info.kind === "directory") {
    if (hasGitDir) {
      return FileMode.GITLINK;
    }
    return FileMode.TREE;
  }

  // For regular files, check if executable
  // FilesApi doesn't expose executable bit, so default to regular
  return FileMode.REGULAR_FILE;
}

/**
 * FileTreeIterator implementation.
 *
 * Provides worktree iteration functionality using a platform-agnostic
 * FilesApi for filesystem access.
 */
export class FileTreeIterator {
  private readonly files: FilesApi;
  private readonly rootPath: string;
  private readonly ignoreManager: IgnoreManager;
  private readonly autoLoadGitignore: boolean;
  private readonly gitDir?: string;
  private readonly globalExcludesFile?: string;
  private readonly newHasher: NewHasher;
  private repositoryExcludesLoaded = false;

  constructor(options: FileTreeIteratorOptions) {
    this.files = options.files;
    this.rootPath = options.rootPath;
    this.ignoreManager = options.ignoreManager ?? createIgnoreManager();
    this.autoLoadGitignore = options.autoLoadGitignore ?? true;
    this.gitDir = options.gitDir;
    this.globalExcludesFile = options.globalExcludesFile;
    this.newHasher = options.newHasher ?? createSha1;
  }

  /**
   * Iterate all entries in worktree.
   *
   * Entries are yielded in sorted order (by path) for consistent results.
   * Directories are traversed recursively.
   */
  async *walk(options?: WorktreeStoreOptions): AsyncIterable<WorktreeEntry> {
    const includeIgnored = options?.includeIgnored ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const pathPrefix = options?.pathPrefix ?? "";

    // Load repository-level excludes on first walk
    await this.loadRepositoryExcludes();

    // Add custom ignore patterns if provided
    if (options?.ignorePatterns?.length) {
      this.ignoreManager.addGlobalPatterns(options.ignorePatterns);
    }

    // Start recursive walk from root (or path prefix)
    const startPath = pathPrefix ? joinPath(this.rootPath, pathPrefix) : this.rootPath;
    yield* this.walkDirectory(startPath, pathPrefix, includeIgnored, includeDirectories);
  }

  /**
   * Recursively walk a directory.
   */
  private async *walkDirectory(
    dirPath: string,
    relativePath: string,
    includeIgnored: boolean,
    includeDirectories: boolean,
  ): AsyncIterable<WorktreeEntry> {
    // Load .gitignore if auto-loading is enabled
    if (this.autoLoadGitignore) {
      await this.tryLoadGitignore(dirPath, relativePath);
    }

    // List directory entries
    const entries: FileInfo[] = [];
    try {
      for await (const entry of this.files.list(dirPath)) {
        entries.push(entry);
      }
    } catch {
      // Directory doesn't exist or can't be read
      return;
    }

    // Sort entries by name for consistent ordering
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Process each entry
    for (const entry of entries) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const fullPath = joinPath(dirPath, entry.name);
      const isDirectory = entry.kind === "directory";

      // Skip .git directory
      if (entry.name === ".git") {
        continue;
      }

      // Check if this entry is ignored
      const isIgnored = this.ignoreManager.isIgnored(entryPath, isDirectory);

      // Skip ignored entries unless explicitly requested
      if (isIgnored && !includeIgnored) {
        continue;
      }

      // Check for .git inside directory (gitlink detection)
      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      // Get file mode
      const mode = getFileMode(entry, hasGitDir);

      // Get file stats
      const stats = await this.getFileStats(fullPath, isDirectory);

      // Create entry
      const worktreeEntry: WorktreeEntry = {
        path: entryPath,
        name: entry.name,
        mode,
        size: stats.size,
        mtime: stats.mtime,
        isDirectory,
        isIgnored,
      };

      // Yield directory entry if requested
      if (isDirectory && includeDirectories) {
        yield worktreeEntry;
      }

      // For files, yield the entry
      if (!isDirectory) {
        yield worktreeEntry;
      }

      // Recursively process directories (unless gitlink)
      if (isDirectory && !hasGitDir) {
        yield* this.walkDirectory(fullPath, entryPath, includeIgnored, includeDirectories);
      }
    }
  }

  /**
   * Get specific entry by path.
   */
  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const fullPath = joinPath(this.rootPath, path);

    try {
      // Check if path exists and get stats
      const stats = await this.files.stats(fullPath);
      if (!stats) {
        return undefined;
      }

      // Determine if directory by trying to list (stats doesn't have kind)
      let isDirectory = false;
      try {
        for await (const _ of this.files.list(fullPath)) {
          isDirectory = true;
          break;
        }
      } catch {
        // Not a directory or can't be listed
      }

      const isIgnored = this.ignoreManager.isIgnored(path, isDirectory);

      // Check for gitlink
      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      // Create a minimal object for getFileMode
      const fileInfo: SimplifiedFileInfo = {
        kind: isDirectory ? "directory" : "file",
      };
      const mode = getFileMode(fileInfo, hasGitDir);

      return {
        path,
        name: basename(path),
        mode,
        size: stats.size ?? 0,
        mtime: stats.lastModified ?? 0,
        isDirectory,
        isIgnored,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Compute content hash for a file (without storing).
   *
   * Uses Git blob format: "blob <size>\0<content>". The file streams through the
   * hasher with its size from stat; see `hashWorktreeFile` for a file that
   * changes while it is read.
   */
  async computeHash(path: string): Promise<ObjectId> {
    const fullPath = joinPath(this.rootPath, path);
    return hashWorktreeFile(
      path,
      {
        size: async () => {
          const stats = await this.files.stats(fullPath);
          return stats?.kind === "file" ? stats.size : undefined;
        },
        read: () => this.files.read(fullPath),
      },
      this.newHasher,
    );
  }

  /**
   * Read file content as stream.
   */
  async *readContent(path: string): AsyncIterable<Uint8Array> {
    const fullPath = joinPath(this.rootPath, path);

    yield* this.files.read(fullPath);
  }

  /**
   * Try to load a .gitignore file from a directory.
   */
  private async tryLoadGitignore(dirPath: string, relativePath: string): Promise<void> {
    const gitignorePath = joinPath(dirPath, ".gitignore");

    try {
      if (await this.files.exists(gitignorePath)) {
        const content = await readFile(this.files, gitignorePath);
        const text = new TextDecoder().decode(content);
        this.ignoreManager.addIgnoreFile(relativePath, text);
      }
    } catch {
      // Ignore errors reading .gitignore
    }
  }

  /**
   * Load repository-level exclude files.
   *
   * This loads (in order of increasing priority):
   * 1. core.excludesFile (global excludes from git config) - lowest priority
   * 2. .git/info/exclude (repository-specific excludes)
   *
   * Note: .gitignore files have higher priority than both and are loaded
   * during directory traversal.
   *
   * These are loaded once on first walk and cached.
   */
  private async loadRepositoryExcludes(): Promise<void> {
    if (this.repositoryExcludesLoaded) {
      return;
    }
    this.repositoryExcludesLoaded = true;

    // Load global excludes file FIRST (lowest precedence)
    if (this.globalExcludesFile) {
      await this.tryLoadGlobalExcludes(this.globalExcludesFile);
    }

    // Load .git/info/exclude SECOND (higher precedence than global, lower than .gitignore)
    if (this.gitDir) {
      await this.tryLoadInfoExclude(this.gitDir);
    }
  }

  /**
   * Try to load .git/info/exclude file.
   *
   * This file contains repository-specific exclude patterns that are not
   * shared with other repositories. It has lower priority than .gitignore
   * files but higher priority than core.excludesFile.
   */
  private async tryLoadInfoExclude(gitDir: string): Promise<void> {
    const excludePath = joinPath(gitDir, "info", "exclude");

    try {
      if (await this.files.exists(excludePath)) {
        const content = await readFile(this.files, excludePath);
        const text = new TextDecoder().decode(content);
        // Add as global patterns (checked after .gitignore files)
        const patterns = text.split("\n").filter((line) => line.trim() !== "");
        this.ignoreManager.addGlobalPatterns(patterns);
      }
    } catch {
      // Ignore errors reading exclude file
    }
  }

  /**
   * Try to load global excludes file (from core.excludesFile config).
   *
   * This file contains patterns that apply to all repositories for this user.
   * It has the lowest precedence of all ignore sources.
   */
  private async tryLoadGlobalExcludes(excludesFilePath: string): Promise<void> {
    try {
      if (await this.files.exists(excludesFilePath)) {
        const content = await readFile(this.files, excludesFilePath);
        const text = new TextDecoder().decode(content);
        // Add as global patterns (lowest precedence)
        this.ignoreManager.addGlobalPatterns(text.split("\n").filter((line) => line.trim() !== ""));
      }
    } catch {
      // Ignore errors reading global excludes file
    }
  }

  /**
   * Check if a directory contains a .git directory/file (submodule detection).
   */
  private async hasGitDirectory(dirPath: string): Promise<boolean> {
    const gitPath = joinPath(dirPath, ".git");
    try {
      return await this.files.exists(gitPath);
    } catch {
      return false;
    }
  }

  /**
   * Get file statistics (size and mtime).
   */
  private async getFileStats(
    fullPath: string,
    isDirectory: boolean,
  ): Promise<{ size: number; mtime: number }> {
    if (isDirectory) {
      return { size: 0, mtime: 0 };
    }

    try {
      const stats = await this.files.stats(fullPath);
      if (stats) {
        return {
          size: stats.size ?? 0,
          mtime: stats.lastModified ?? 0,
        };
      }
    } catch {
      // Fall through to defaults
    }

    return { size: 0, mtime: 0 };
  }
}

/**
 * Create a FileTreeIterator (Worktree implementation).
 *
 * @param options Iterator options
 * @returns A new FileTreeIterator instance
 */
export function createFileTreeIterator(options: FileTreeIteratorOptions): FileTreeIterator {
  return new FileTreeIterator(options);
}

// Backward compatibility alias
export { createFileTreeIterator as createWorktreeStore };
