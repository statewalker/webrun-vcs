/**
 * Git ignore manager implementation.
 *
 * Manages ignore rules from multiple sources:
 * - Per-directory .gitignore files
 * - Repository .git/info/exclude
 * - Global patterns
 *
 * Rules are evaluated in order, with later rules taking precedence.
 */

import type { IgnoreManager, IgnoreNode, MatchResultValue } from "./ignore-manager.js";
import { MatchResult } from "./ignore-manager.js";
import { createIgnoreNode } from "./ignore-node.js";

/**
 * Options for creating a GitIgnoreManager.
 */
export interface GitIgnoreManagerOptions {
  /** Global patterns that apply to all paths */
  globalPatterns?: string[];
}

/**
 * Create a GitIgnoreManager.
 */
export function createIgnoreManager(options?: GitIgnoreManagerOptions): IgnoreManager {
  return new GitIgnoreManagerImpl(options);
}

/**
 * Node tracking ignore rules for a specific directory.
 */
interface DirectoryIgnoreNode {
  /** Directory path (relative to root, no trailing slash) */
  path: string;
  /** Ignore rules for this directory */
  node: IgnoreNode;
}

class GitIgnoreManagerImpl implements IgnoreManager {
  /** Global patterns (from git config, etc.) */
  private globalNode: IgnoreNode;

  /** Per-directory ignore nodes, sorted by path depth (deepest first) */
  private directoryNodes: DirectoryIgnoreNode[] = [];

  constructor(options?: GitIgnoreManagerOptions) {
    this.globalNode = createIgnoreNode();
    if (options?.globalPatterns) {
      this.globalNode.parse(options.globalPatterns.join("\n"));
    }
  }

  isIgnored(path: string, isDirectory: boolean): boolean {
    const status = this.getStatus(path, isDirectory);
    return status === MatchResult.IGNORED;
  }

  getStatus(path: string, isDirectory: boolean): MatchResultValue {
    // Normalize path (remove leading/trailing slashes)
    const normalizedPath = this.normalizePath(path);

    // Check directory-specific nodes first (most specific to least)
    for (const dirNode of this.directoryNodes) {
      // Only check if this path is under this directory
      if (this.isUnderDirectory(normalizedPath, dirNode.path)) {
        const relativePath = this.getRelativePath(normalizedPath, dirNode.path);
        const result = dirNode.node.checkIgnored(relativePath, isDirectory);

        if (result !== undefined) {
          return result ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
        }
      }
    }

    // Check global patterns
    const globalResult = this.globalNode.checkIgnored(normalizedPath, isDirectory);
    if (globalResult !== undefined) {
      return globalResult ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
    }

    return MatchResult.CHECK_PARENT;
  }

  addIgnoreFile(dirPath: string, content: string): void {
    const normalizedDir = this.normalizePath(dirPath);
    const node = createIgnoreNode();
    node.parse(content);

    // Insert sorted by path depth (deepest first)
    const depth = this.getPathDepth(normalizedDir);
    let insertIdx = 0;
    for (let i = 0; i < this.directoryNodes.length; i++) {
      const existingDepth = this.getPathDepth(this.directoryNodes[i].path);
      if (depth > existingDepth) {
        break;
      }
      insertIdx = i + 1;
    }

    this.directoryNodes.splice(insertIdx, 0, {
      path: normalizedDir,
      node,
    });
  }

  addGlobalPatterns(patterns: string[]): void {
    this.globalNode.parse(patterns.join("\n"));
  }

  clear(): void {
    this.globalNode = createIgnoreNode();
    this.directoryNodes = [];
  }

  /**
   * Normalize a path by removing leading/trailing slashes.
   */
  private normalizePath(path: string): string {
    let result = path;
    while (result.startsWith("/")) {
      result = result.substring(1);
    }
    while (result.endsWith("/")) {
      result = result.substring(0, result.length - 1);
    }
    return result;
  }

  /**
   * Check if a path is under a directory.
   */
  private isUnderDirectory(path: string, dirPath: string): boolean {
    if (dirPath === "" || dirPath === ".") {
      return true;
    }
    return path === dirPath || path.startsWith(`${dirPath}/`);
  }

  /**
   * Get path relative to a directory.
   */
  private getRelativePath(path: string, dirPath: string): string {
    if (dirPath === "" || dirPath === ".") {
      return path;
    }
    if (path === dirPath) {
      return "";
    }
    return path.substring(dirPath.length + 1);
  }

  /**
   * Get the depth of a path (number of segments).
   */
  private getPathDepth(path: string): number {
    if (path === "" || path === ".") {
      return 0;
    }
    let count = 1;
    for (let i = 0; i < path.length; i++) {
      if (path.charAt(i) === "/") {
        count++;
      }
    }
    return count;
  }
}
