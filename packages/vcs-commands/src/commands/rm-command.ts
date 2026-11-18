import type { IndexEntry } from "@statewalker/vcs-working-tree";

import { NoFilepatternError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";

/**
 * Result of RmCommand execution.
 */
export interface RmResult {
  /** Paths that were removed from the index */
  removedPaths: string[];
}

/**
 * Remove files from the index (and optionally from working tree).
 *
 * Equivalent to `git rm`.
 *
 * Based on JGit's RmCommand.
 *
 * @example
 * ```typescript
 * // Remove file from index and working tree
 * await git.rm()
 *   .addFilepattern("file.txt")
 *   .call();
 *
 * // Remove from index only (keep in working tree)
 * await git.rm()
 *   .addFilepattern("file.txt")
 *   .setCached(true)
 *   .call();
 *
 * // Remove directory recursively
 * await git.rm()
 *   .addFilepattern("src/old/")
 *   .call();
 * ```
 */
export class RmCommand extends GitCommand<RmResult> {
  private filepatterns: string[] = [];
  private cached = false;

  /**
   * Add a file pattern to remove.
   *
   * @param filepattern Path pattern to remove (with `/` as separator)
   */
  addFilepattern(filepattern: string): this {
    this.checkCallable();
    this.filepatterns.push(filepattern);
    return this;
  }

  /**
   * Set whether to only remove from index (keep in working tree).
   *
   * When true, files are only removed from the staging area
   * but remain in the working directory (like `git rm --cached`).
   *
   * @param cached true to only remove from index
   */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /**
   * Get whether cached mode is enabled.
   */
  getCached(): boolean {
    return this.cached;
  }

  /**
   * Execute the rm command.
   *
   * @returns Result with list of removed paths
   */
  async call(): Promise<RmResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    if (this.filepatterns.length === 0) {
      throw new NoFilepatternError("At least one file pattern is required");
    }

    const removedPaths: string[] = [];

    // Read current staging area
    await this.staging.read();

    // the kept entries go on as they are: flags (intent-to-add, skip-worktree,
    // assume-unchanged) and stat data included (git's remove_file_from_index)
    const entriesToKeep: IndexEntry[] = [];

    for await (const entry of this.staging.entries()) {
      if (this.matchesPattern(entry.path)) {
        removedPaths.push(entry.path);
      } else {
        entriesToKeep.push(entry);
      }
    }

    // Rebuild staging with entries that weren't removed
    const builder = this.staging.createBuilder();
    for (const entry of entriesToKeep) {
      builder.add(entry);
    }
    await builder.finish();
    await this.staging.write();

    // Note: Working tree removal is not implemented here since
    // WorkingCopy may not have worktree access for file deletion.
    // The cached flag controls whether working tree should be modified,
    // but actual deletion requires filesystem access which is
    // implementation-specific.

    return { removedPaths };
  }

  /**
   * Check if a path matches any of the configured patterns.
   */
  private matchesPattern(path: string): boolean {
    for (const pattern of this.filepatterns) {
      // Exact match
      if (path === pattern) {
        return true;
      }

      // Directory pattern (ends with /)
      if (pattern.endsWith("/")) {
        const dirPrefix = pattern;
        if (path.startsWith(dirPrefix)) {
          return true;
        }
      }

      // Prefix match for directories without trailing slash
      if (path.startsWith(`${pattern}/`)) {
        return true;
      }

      // Simple glob matching for * patterns
      if (pattern.includes("*")) {
        const regex = this.patternToRegex(pattern);
        if (regex.test(path)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Convert a simple glob pattern to regex.
   */
  private patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    // Convert * to .*
    const regexStr = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${regexStr}$`);
  }
}
