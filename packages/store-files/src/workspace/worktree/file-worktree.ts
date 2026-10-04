/**
 * File-based Worktree implementation
 *
 * Implements the new Worktree interface using FilesApi.
 * Extends FileTreeIterator's read capabilities with:
 * - Write operations (writeContent, remove, mkdir, rename)
 * - Checkout operations (checkoutTree, checkoutPaths)
 *
 * This is the primary Worktree implementation for file-based repositories.
 */

import type { Blobs, ObjectId, Trees } from "@statewalker/vcs-core";
import {
  basename,
  type FileInfo,
  FileMode,
  type FilesApi,
  joinPath,
  readFile,
} from "@statewalker/vcs-core";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type {
  IgnoreManager,
  Worktree,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeEntry,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";
import { createIgnoreManager } from "@statewalker/vcs-working-tree";

/**
 * Extended FilesApi with additional operations for worktree
 *
 * Note: FilesApi already has mkdir, remove, move. We add chmod here.
 */
export interface WorktreeFilesApi extends FilesApi {
  /** Set file permissions (optional) */
  chmod?(path: string, mode: number): Promise<void>;
}

/**
 * Options for creating a FileWorktree
 */
export interface FileWorktreeOptions {
  /** FilesApi for filesystem operations */
  files: WorktreeFilesApi;
  /** Root path of the worktree */
  rootPath: string;
  /** Blobs interface for content access (needed for checkout) */
  blobs: Blobs;
  /** Trees interface for tree access (needed for checkout) */
  trees: Trees;
  /** Pre-configured IgnoreManager */
  ignoreManager?: IgnoreManager;
  /** Auto-load .gitignore files (default: true) */
  autoLoadGitignore?: boolean;
  /** Path to .git directory */
  gitDir?: string;
  /** Path to global excludes file */
  globalExcludesFile?: string;
  /** Custom hash function */
  hashFunction?: (data: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Text encoder for Git header construction
 */
const textEncoder = new TextEncoder();

/**
 * Create a Git blob header for hashing
 */
function createBlobHeader(size: number): Uint8Array {
  return textEncoder.encode(`blob ${size}\0`);
}

/**
 * File-based Worktree implementation
 */
export class FileWorktree implements Worktree {
  private readonly files: WorktreeFilesApi;
  private readonly rootPath: string;
  private readonly blobs: Blobs;
  private readonly trees: Trees;
  private readonly ignoreManager: IgnoreManager;
  private readonly autoLoadGitignore: boolean;
  private readonly gitDir?: string;
  private readonly globalExcludesFile?: string;
  private readonly hashFunction: (data: Uint8Array) => Promise<Uint8Array>;
  private repositoryExcludesLoaded = false;

  constructor(options: FileWorktreeOptions) {
    this.files = options.files;
    this.rootPath = options.rootPath;
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.ignoreManager = options.ignoreManager ?? createIgnoreManager();
    this.autoLoadGitignore = options.autoLoadGitignore ?? true;
    this.gitDir = options.gitDir;
    this.globalExcludesFile = options.globalExcludesFile;
    this.hashFunction = options.hashFunction ?? sha1;
  }

  // ========== Reading ==========

  async *walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    const includeIgnored = options?.includeIgnored ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const pathPrefix = options?.pathPrefix ?? "";

    await this.loadRepositoryExcludes();

    if (options?.ignorePatterns?.length) {
      this.ignoreManager.addGlobalPatterns(options.ignorePatterns);
    }

    const startPath = pathPrefix ? joinPath(this.rootPath, pathPrefix) : this.rootPath;
    yield* this.walkDirectory(
      startPath,
      pathPrefix,
      includeIgnored,
      includeDirectories,
      options?.maxDepth,
    );
  }

  private async *walkDirectory(
    dirPath: string,
    relativePath: string,
    includeIgnored: boolean,
    includeDirectories: boolean,
    maxDepth?: number,
    currentDepth = 0,
  ): AsyncIterable<WorktreeEntry> {
    if (maxDepth !== undefined && currentDepth > maxDepth) {
      return;
    }

    if (this.autoLoadGitignore) {
      await this.tryLoadGitignore(dirPath, relativePath);
    }

    const entries: FileInfo[] = [];
    try {
      for await (const entry of this.files.list(dirPath)) {
        entries.push(entry);
      }
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const fullPath = joinPath(dirPath, entry.name);
      const isDirectory = entry.kind === "directory";

      if (entry.name === ".git") {
        continue;
      }

      const isIgnored = this.ignoreManager.isIgnored(entryPath, isDirectory);

      if (isIgnored && !includeIgnored) {
        continue;
      }

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      const mode = this.getFileMode(entry, hasGitDir);
      const stats = await this.getFileStats(fullPath, isDirectory);

      const worktreeEntry: WorktreeEntry = {
        path: entryPath,
        name: entry.name,
        mode,
        size: stats.size,
        mtime: stats.mtime,
        isDirectory,
        isIgnored,
      };

      if (isDirectory && includeDirectories) {
        yield worktreeEntry;
      }

      if (!isDirectory) {
        yield worktreeEntry;
      }

      if (isDirectory && !hasGitDir) {
        yield* this.walkDirectory(
          fullPath,
          entryPath,
          includeIgnored,
          includeDirectories,
          maxDepth,
          currentDepth + 1,
        );
      }
    }
  }

  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const fullPath = joinPath(this.rootPath, path);

    try {
      const stats = await this.files.stats(fullPath);
      if (!stats) {
        return undefined;
      }

      let isDirectory = false;
      try {
        for await (const _ of this.files.list(fullPath)) {
          isDirectory = true;
          break;
        }
      } catch {
        // Not a directory
      }

      const isIgnored = this.ignoreManager.isIgnored(path, isDirectory);

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      const mode = this.getFileMode({ kind: isDirectory ? "directory" : "file" }, hasGitDir);

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

  async computeHash(path: string): Promise<ObjectId> {
    const fullPath = joinPath(this.rootPath, path);
    const content = await readFile(this.files, fullPath);
    const header = createBlobHeader(content.length);

    const combined = new Uint8Array(header.length + content.length);
    combined.set(header, 0);
    combined.set(content, header.length);

    const hash = await this.hashFunction(combined);
    return bytesToHex(hash);
  }

  async *readContent(path: string): AsyncIterable<Uint8Array> {
    const fullPath = joinPath(this.rootPath, path);

    if (this.files.read) {
      yield* this.files.read(fullPath);
    } else {
      yield await readFile(this.files, fullPath);
    }
  }

  async exists(path: string): Promise<boolean> {
    const fullPath = joinPath(this.rootPath, path);
    try {
      return await this.files.exists(fullPath);
    } catch {
      return false;
    }
  }

  async isIgnored(path: string): Promise<boolean> {
    await this.loadRepositoryExcludes();

    // Check if it's a directory
    let isDir = false;
    try {
      const fullPath = joinPath(this.rootPath, path);
      for await (const _ of this.files.list(fullPath)) {
        isDir = true;
        break;
      }
    } catch {
      // Not a directory
    }

    return this.ignoreManager.isIgnored(path, isDir);
  }

  // ========== Writing ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    const fullPath = joinPath(this.rootPath, path);

    // Check if file exists and overwrite is false
    if (options?.overwrite === false) {
      if (await this.files.exists(fullPath)) {
        throw new Error(`File already exists: ${path}`);
      }
    }

    // Create parent directories if needed
    if (options?.createParents !== false) {
      const parentPath = this.getParentPath(fullPath);
      if (parentPath) {
        try {
          await this.files.mkdir(parentPath);
        } catch {
          // Directory may already exist
        }
      }
    }

    // Convert content to iterable if it's a Uint8Array
    const iterable = content instanceof Uint8Array ? [content] : content;

    // Write content
    await this.files.write(fullPath, iterable);

    // Set mode if specified
    if (options?.mode !== undefined && this.files.chmod) {
      await this.files.chmod(fullPath, options.mode);
    }
  }

  async remove(path: string, _options?: { recursive?: boolean }): Promise<boolean> {
    const fullPath = joinPath(this.rootPath, path);
    return this.files.remove(fullPath);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    const fullPath = joinPath(this.rootPath, path);
    await this.files.mkdir(fullPath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOldPath = joinPath(this.rootPath, oldPath);
    const fullNewPath = joinPath(this.rootPath, newPath);
    await this.files.move(fullOldPath, fullNewPath);
  }

  // ========== Checkout Operations ==========

  async checkoutTree(
    treeId: ObjectId,
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    const result: WorktreeCheckoutResult = {
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    };

    const treeEntries = await this.trees.load(treeId);
    if (!treeEntries) {
      throw new Error(`Tree not found: ${treeId}`);
    }

    await this.checkoutTreeRecursive(treeEntries, "", result, options);

    return result;
  }

  async checkoutPaths(
    treeId: ObjectId,
    paths: string[],
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    const result: WorktreeCheckoutResult = {
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    };

    const treeEntries = await this.trees.load(treeId);
    if (!treeEntries) {
      throw new Error(`Tree not found: ${treeId}`);
    }

    await this.checkoutTreeRecursive(treeEntries, "", result, { ...options, paths });

    return result;
  }

  private async checkoutTreeRecursive(
    tree: AsyncIterable<{ name: string; mode: number; id: ObjectId }>,
    prefix: string,
    result: WorktreeCheckoutResult,
    options?: WorktreeCheckoutOptions,
  ): Promise<void> {
    for await (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Filter by paths if specified
      if (options?.paths) {
        const matchesPath = options.paths.some(
          (p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`),
        );
        if (!matchesPath) {
          continue;
        }
      }

      if (entry.mode === FileMode.TREE) {
        // Directory - recurse
        const subtree = await this.trees.load(entry.id);
        if (subtree) {
          await this.checkoutTreeRecursive(subtree, path, result, options);
        }
      } else {
        // File - checkout content
        if (options?.dryRun) {
          result.updated.push(path);
          continue;
        }

        try {
          // Check for conflicts (file modified but not force)
          if (!options?.force && (await this.exists(path))) {
            const currentHash = await this.computeHash(path);
            if (currentHash !== entry.id) {
              result.conflicts.push(path);
              continue;
            }
          }

          // Load blob content
          const content = await this.blobs.load(entry.id);
          if (content) {
            // Collect content into array
            const chunks: Uint8Array[] = [];
            for await (const chunk of content) {
              chunks.push(chunk);
            }

            // Write to worktree
            await this.writeContent(path, chunks, {
              mode: entry.mode,
              createParents: true,
            });
            result.updated.push(path);
          } else {
            result.failed.push({ path, error: "Blob not found" });
          }
        } catch (error) {
          result.failed.push({ path, error: String(error) });
        }
      }
    }
  }

  // ========== Metadata ==========

  getRoot(): string {
    return this.rootPath;
  }

  async refreshIgnore(): Promise<void> {
    this.repositoryExcludesLoaded = false;
    await this.loadRepositoryExcludes();
  }

  // ========== Internal Helpers ==========

  private getFileMode(info: { kind: "file" | "directory" }, hasGitDir: boolean): number {
    if (info.kind === "directory") {
      if (hasGitDir) {
        return FileMode.GITLINK;
      }
      return FileMode.TREE;
    }
    return FileMode.REGULAR_FILE;
  }

  private async hasGitDirectory(dirPath: string): Promise<boolean> {
    const gitPath = joinPath(dirPath, ".git");
    try {
      return await this.files.exists(gitPath);
    } catch {
      return false;
    }
  }

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

  private async loadRepositoryExcludes(): Promise<void> {
    if (this.repositoryExcludesLoaded) {
      return;
    }
    this.repositoryExcludesLoaded = true;

    if (this.globalExcludesFile) {
      await this.tryLoadGlobalExcludes(this.globalExcludesFile);
    }

    if (this.gitDir) {
      await this.tryLoadInfoExclude(this.gitDir);
    }
  }

  private async tryLoadGitignore(dirPath: string, relativePath: string): Promise<void> {
    const gitignorePath = joinPath(dirPath, ".gitignore");

    try {
      if (await this.files.exists(gitignorePath)) {
        const content = await readFile(this.files, gitignorePath);
        const text = new TextDecoder().decode(content);
        this.ignoreManager.addIgnoreFile(relativePath, text);
      }
    } catch {
      // Ignore errors
    }
  }

  private async tryLoadInfoExclude(gitDir: string): Promise<void> {
    const excludePath = joinPath(gitDir, "info", "exclude");

    try {
      if (await this.files.exists(excludePath)) {
        const content = await readFile(this.files, excludePath);
        const text = new TextDecoder().decode(content);
        const patterns = text.split("\n").filter((line) => line.trim() !== "");
        this.ignoreManager.addGlobalPatterns(patterns);
      }
    } catch {
      // Ignore errors
    }
  }

  private async tryLoadGlobalExcludes(excludesFilePath: string): Promise<void> {
    try {
      if (await this.files.exists(excludesFilePath)) {
        const content = await readFile(this.files, excludesFilePath);
        const text = new TextDecoder().decode(content);
        this.ignoreManager.addGlobalPatterns(text.split("\n").filter((line) => line.trim() !== ""));
      }
    } catch {
      // Ignore errors
    }
  }

  private getParentPath(path: string): string | undefined {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      return path.substring(0, lastSlash);
    }
    return undefined;
  }
}

/**
 * Factory function to create a FileWorktree
 */
export function createFileWorktree(options: FileWorktreeOptions): Worktree {
  return new FileWorktree(options);
}
