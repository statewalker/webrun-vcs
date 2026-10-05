/**
 * AddCommand - Stages files from working tree to index.
 *
 * Implements `git add` functionality:
 * - Adds new files to index
 * - Updates modified files in index
 * - Optionally removes deleted files (--all mode)
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/AddCommand.java
 */

import { type Blobs, FileMode } from "@statewalker/vcs-core";
import {
  DeleteStagingEntry,
  type Staging,
  UpdateStagingEntry,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import type { Add, AddOptions, AddResult } from "./add.command.js";

/**
 * Options for creating an AddCommand.
 */
export interface AddCommandOptions {
  /** Working tree iterator */
  worktree: Worktree;

  /** Blob storage for file content */
  blobs: Blobs;

  /** Staging area (index) */
  staging: Staging;
}

/**
 * Check if a path matches any pattern.
 *
 * Supports simple glob patterns:
 * - * matches any string (including path separators for extension patterns like *.ts)
 * - ** matches any path segments
 * - ? matches single character
 */
function matchesPattern(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(path, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Simple glob matching.
 */
function matchGlob(path: string, pattern: string): boolean {
  // Exact match
  if (path === pattern) {
    return true;
  }

  // Directory prefix (add "dir" matches "dir/file")
  if (path.startsWith(`${pattern}/`)) {
    return true;
  }

  // Handle extension patterns like "*.ts" - should match any .ts file anywhere
  if (pattern.startsWith("*.") && !pattern.includes("/")) {
    const extension = pattern.slice(1); // e.g., ".ts"
    return path.endsWith(extension);
  }

  // Handle **/* pattern (matches all files)
  if (pattern === "**/*") {
    return true;
  }

  // Simple * glob (e.g., "src/*" or "**/*.ts")
  if (pattern.includes("*")) {
    // Escape special regex characters except * and ?
    const escapedPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

    // ** matches anything including path separators
    // * matches anything except path separators
    const regexPattern = escapedPattern
      .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<DOUBLESTAR>>>/g, ".*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }

  return false;
}

/**
 * AddCommand implementation.
 */
export class AddCommand implements Add {
  private readonly worktree: Worktree;
  private readonly blobs: Blobs;
  private readonly staging: Staging;

  constructor(options: AddCommandOptions) {
    this.worktree = options.worktree;
    this.blobs = options.blobs;
    this.staging = options.staging;
  }

  /**
   * Add files matching patterns to staging area.
   */
  async add(filePatterns: string[], options: AddOptions = {}): Promise<AddResult> {
    const { update = false, all = false, intentToAdd = false, force = false, onProgress } = options;

    const added: string[] = [];
    const skipped: string[] = [];
    const removed: string[] = [];

    // Collect files to process
    const filesToProcess: Array<{ path: string; exists: boolean; isIgnored: boolean }> = [];

    // Walk worktree to find matching files
    for await (const entry of this.worktree.walk({ includeIgnored: true })) {
      if (entry.isDirectory) continue;

      // Check if file matches any pattern
      if (!matchesPattern(entry.path, filePatterns)) {
        continue;
      }

      // Skip ignored files unless force
      if (entry.isIgnored && !force) {
        skipped.push(entry.path);
        continue;
      }

      filesToProcess.push({
        path: entry.path,
        exists: true,
        isIgnored: entry.isIgnored,
      });
    }

    // If update or all mode, check for deleted files in index
    if (update || all) {
      const indexedPaths = new Set<string>();
      for await (const entry of this.staging.entries()) {
        if (entry.stage === 0) {
          indexedPaths.add(entry.path);
        }
      }

      // Find paths in index that match patterns but not in worktree
      for (const indexPath of Array.from(indexedPaths)) {
        if (!matchesPattern(indexPath, filePatterns)) {
          continue;
        }

        const worktreeEntry = await this.worktree.getEntry(indexPath);
        if (!worktreeEntry) {
          // File was deleted from worktree
          filesToProcess.push({
            path: indexPath,
            exists: false,
            isIgnored: false,
          });
        }
      }
    }

    // If update mode, filter to only tracked files
    if (update) {
      const trackedPaths = new Set<string>();
      for await (const entry of this.staging.entries()) {
        if (entry.stage === 0) {
          trackedPaths.add(entry.path);
        }
      }

      const filteredFiles = filesToProcess.filter((f) => trackedPaths.has(f.path));
      filesToProcess.length = 0;
      filesToProcess.push(...filteredFiles);
    }

    // Process files
    const editor = this.staging.createEditor();
    const total = filesToProcess.length;
    let current = 0;

    for (const file of filesToProcess) {
      current++;
      onProgress?.(file.path, current, total);

      if (!file.exists) {
        // File deleted from worktree - remove from index
        editor.add(new DeleteStagingEntry(file.path));
        removed.push(file.path);
        continue;
      }

      if (intentToAdd) {
        // Just mark as intent-to-add (placeholder)
        const worktreeEntry = await this.worktree.getEntry(file.path);
        const mode = worktreeEntry?.mode ?? FileMode.REGULAR_FILE;
        editor.add(
          new UpdateStagingEntry(file.path, "", mode, {
            size: 0,
            mtime: Date.now(),
          }),
        );
        added.push(file.path);
        continue;
      }

      // Get file info
      const worktreeEntry = await this.worktree.getEntry(file.path);
      if (!worktreeEntry) {
        // File disappeared during processing
        continue;
      }

      // Hash and store content
      const objectId = await this.storeFileContent(file.path);

      // Add to staging
      editor.add(
        new UpdateStagingEntry(file.path, objectId, worktreeEntry.mode, {
          size: worktreeEntry.size,
          mtime: worktreeEntry.mtime,
        }),
      );
      added.push(file.path);
    }

    // Apply changes
    await editor.finish();

    return {
      added,
      skipped,
      removed,
      totalProcessed: added.length + removed.length,
    };
  }

  /**
   * Add all files in working tree to staging area.
   */
  async addAll(options: AddOptions = {}): Promise<AddResult> {
    return this.add(["**/*"], { ...options, all: true });
  }

  /**
   * Store file content as blob and return object ID.
   */
  private async storeFileContent(path: string): Promise<string> {
    // Read content from working tree
    const content = this.worktree.readContent(path);
    // Store using BlobStore which handles Git header automatically
    return await this.blobs.store(content);
  }
}

/**
 * Create an AddCommand.
 *
 * @param options Command options
 * @returns New AddCommand instance
 */
export function createAddCommand(options: AddCommandOptions): Add {
  return new AddCommand(options);
}
