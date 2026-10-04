/**
 * In-memory Worktree implementation
 *
 * Useful for:
 * - Testing
 * - Virtual filesystems
 * - Temporary worktree operations
 *
 * This implementation stores all files in memory.
 */

import type { Blobs, ObjectId, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type {
  Worktree,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeEntry,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "./worktree.js";

/**
 * In-memory file representation
 */
interface MemoryFile {
  content: Uint8Array;
  mode: number;
  mtime: number;
}

/**
 * Options for creating a MemoryWorktree
 */
export interface MemoryWorktreeOptions {
  /** Root path (virtual) */
  rootPath?: string;
  /** Blobs interface for content access */
  blobs: Blobs;
  /** Trees interface for tree access */
  trees: Trees;
  /** Custom hash function */
  hashFunction?: (data: Uint8Array) => Promise<Uint8Array>;
  /** Ignore patterns */
  ignorePatterns?: string[];
}

/**
 * Text encoder for Git header
 */
const textEncoder = new TextEncoder();

/**
 * Create Git blob header
 */
function createBlobHeader(size: number): Uint8Array {
  return textEncoder.encode(`blob ${size}\0`);
}

/**
 * In-memory Worktree implementation
 */
export class MemoryWorktree implements Worktree {
  private readonly rootPath: string;
  private readonly blobs: Blobs;
  private readonly trees: Trees;
  private readonly hashFunction: (data: Uint8Array) => Promise<Uint8Array>;
  private readonly ignorePatterns: string[];

  /** In-memory file storage */
  private files = new Map<string, MemoryFile>();
  /** Directories (for explicit mkdir) */
  private directories = new Set<string>();

  constructor(options: MemoryWorktreeOptions) {
    this.rootPath = options.rootPath ?? "/";
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.hashFunction = options.hashFunction ?? sha1;
    this.ignorePatterns = options.ignorePatterns ?? [];
  }

  // ========== Reading ==========

  async *walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    const includeIgnored = options?.includeIgnored ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const pathPrefix = options?.pathPrefix ?? "";

    // Collect all paths
    const paths = new Set<string>();

    // Add file paths
    for (const path of this.files.keys()) {
      if (!pathPrefix || path.startsWith(pathPrefix) || path.startsWith(`${pathPrefix}/`)) {
        paths.add(path);
      }
    }

    // Add directory paths
    for (const path of this.directories) {
      if (!pathPrefix || path.startsWith(pathPrefix) || path.startsWith(`${pathPrefix}/`)) {
        paths.add(path);
      }
    }

    // Extract parent directories from files
    for (const filePath of this.files.keys()) {
      const parts = filePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        if (!pathPrefix || dirPath.startsWith(pathPrefix) || dirPath.startsWith(`${pathPrefix}/`)) {
          paths.add(dirPath);
        }
      }
    }

    // Sort paths
    const sortedPaths = Array.from(paths).sort();

    for (const path of sortedPaths) {
      const isFile = this.files.has(path);
      const isDirectory = !isFile;

      const isIgnored = this.isIgnoredPath(path, isDirectory);
      if (isIgnored && !includeIgnored) {
        continue;
      }

      if (isDirectory && !includeDirectories) {
        continue;
      }

      const file = this.files.get(path);

      yield {
        path,
        name: path.split("/").pop() ?? path,
        mode: file?.mode ?? FileMode.TREE,
        size: file?.content.length ?? 0,
        mtime: file?.mtime ?? 0,
        isDirectory,
        isIgnored,
      };
    }
  }

  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const file = this.files.get(path);

    if (file) {
      return {
        path,
        name: path.split("/").pop() ?? path,
        mode: file.mode,
        size: file.content.length,
        mtime: file.mtime,
        isDirectory: false,
        isIgnored: this.isIgnoredPath(path, false),
      };
    }

    // Check if it's a directory
    if (this.directories.has(path) || this.hasFilesUnder(path)) {
      return {
        path,
        name: path.split("/").pop() ?? path,
        mode: FileMode.TREE,
        size: 0,
        mtime: 0,
        isDirectory: true,
        isIgnored: this.isIgnoredPath(path, true),
      };
    }

    return undefined;
  }

  async computeHash(path: string): Promise<ObjectId> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    const header = createBlobHeader(file.content.length);
    const combined = new Uint8Array(header.length + file.content.length);
    combined.set(header, 0);
    combined.set(file.content, header.length);

    const hash = await this.hashFunction(combined);
    return bytesToHex(hash);
  }

  async *readContent(path: string): AsyncIterable<Uint8Array> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    yield file.content;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path) || this.hasFilesUnder(path);
  }

  async isIgnored(path: string): Promise<boolean> {
    const isDirectory = this.directories.has(path) || this.hasFilesUnder(path);
    return this.isIgnoredPath(path, isDirectory);
  }

  // ========== Writing ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    if (options?.overwrite === false && this.files.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }

    // Collect content
    let data: Uint8Array;
    if (content instanceof Uint8Array) {
      data = content;
    } else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }

    // Create parent directories
    if (options?.createParents !== false) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        this.directories.add(dirPath);
      }
    }

    this.files.set(path, {
      content: data,
      mode: options?.mode ?? FileMode.REGULAR_FILE,
      mtime: Date.now(),
    });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<boolean> {
    if (this.files.has(path)) {
      this.files.delete(path);
      return true;
    }

    if (this.directories.has(path) || this.hasFilesUnder(path)) {
      if (options?.recursive) {
        const prefix = `${path}/`;
        for (const filePath of this.files.keys()) {
          if (filePath.startsWith(prefix)) {
            this.files.delete(filePath);
          }
        }
        for (const dirPath of this.directories) {
          if (dirPath === path || dirPath.startsWith(prefix)) {
            this.directories.delete(dirPath);
          }
        }
        return true;
      }
      this.directories.delete(path);
      return true;
    }

    return false;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const dirPath = parts.slice(0, i).join("/");
        this.directories.add(dirPath);
      }
    } else {
      this.directories.add(path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath);
    if (file) {
      this.files.delete(oldPath);
      this.files.set(newPath, file);
      return;
    }

    // Rename directory and its contents
    const oldPrefix = `${oldPath}/`;
    const toRename: Array<[string, MemoryFile]> = [];

    for (const [filePath, fileData] of this.files.entries()) {
      if (filePath.startsWith(oldPrefix)) {
        toRename.push([filePath, fileData]);
      }
    }

    for (const [filePath, fileData] of toRename) {
      const newFilePath = newPath + filePath.substring(oldPath.length);
      this.files.delete(filePath);
      this.files.set(newFilePath, fileData);
    }

    if (this.directories.has(oldPath)) {
      this.directories.delete(oldPath);
      this.directories.add(newPath);
    }
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
    return this.checkoutTree(treeId, { ...options, paths });
  }

  private async checkoutTreeRecursive(
    tree: AsyncIterable<{ name: string; mode: number; id: ObjectId }>,
    prefix: string,
    result: WorktreeCheckoutResult,
    options?: WorktreeCheckoutOptions,
  ): Promise<void> {
    for await (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (options?.paths) {
        const matchesPath = options.paths.some(
          (p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`),
        );
        if (!matchesPath) {
          continue;
        }
      }

      if (entry.mode === FileMode.TREE) {
        const subtree = await this.trees.load(entry.id);
        if (subtree) {
          await this.checkoutTreeRecursive(subtree, path, result, options);
        }
      } else {
        if (options?.dryRun) {
          result.updated.push(path);
          continue;
        }

        try {
          if (!options?.force && this.files.has(path)) {
            const currentHash = await this.computeHash(path);
            if (currentHash !== entry.id) {
              result.conflicts.push(path);
              continue;
            }
          }

          const content = await this.blobs.load(entry.id);
          if (content) {
            const chunks: Uint8Array[] = [];
            for await (const chunk of content) {
              chunks.push(chunk);
            }

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
    // No-op for memory worktree
  }

  // ========== Internal Helpers ==========

  private hasFilesUnder(path: string): boolean {
    const prefix = `${path}/`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private isIgnoredPath(path: string, isDirectory: boolean): boolean {
    for (const pattern of this.ignorePatterns) {
      if (this.matchesPattern(path, pattern, isDirectory)) {
        return true;
      }
    }
    return false;
  }

  private matchesPattern(path: string, pattern: string, isDirectory: boolean): boolean {
    // Simple pattern matching
    if (pattern.startsWith("#") || pattern.trim() === "") {
      return false;
    }

    const negated = pattern.startsWith("!");
    const actualPattern = negated ? pattern.substring(1) : pattern;

    // Directory-only patterns
    if (actualPattern.endsWith("/")) {
      if (!isDirectory) {
        return false;
      }
    }

    // Simple glob matching
    const regex = this.patternToRegex(actualPattern.replace(/\/$/, ""));
    const matches = regex.test(path) || regex.test(path.split("/").pop() ?? "");

    return negated ? !matches : matches;
  }

  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  }

  // ========== Test Helpers ==========

  /**
   * Clear all files (for testing)
   */
  _clear(): void {
    this.files.clear();
    this.directories.clear();
  }

  /**
   * Get all file paths (for testing)
   */
  _getFiles(): string[] {
    return Array.from(this.files.keys());
  }
}

/**
 * Factory function to create a MemoryWorktree
 */
export function createMemoryWorktree(options: MemoryWorktreeOptions): Worktree {
  return new MemoryWorktree(options);
}
