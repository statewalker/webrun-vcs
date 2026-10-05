import { GitCommand } from "../git-command.js";

/**
 * Result of a clean operation
 */
export interface CleanResult {
  /** Files that were (or would be) removed */
  cleaned: Set<string>;
  /** Whether this was a dry run (no files actually removed) */
  dryRun: boolean;
}

/**
 * Remove untracked files from working tree.
 *
 * Equivalent to `git clean`.
 *
 * Based on JGit's CleanCommand.
 *
 * This command DELETES files from the working tree when dry-run is disabled.
 * Dry-run is the default for exactly that reason: a caller must opt in to
 * destruction with `setDryRun(false)`. The returned `dryRun` flag always
 * reports what the caller asked for, so a `false` there means files were
 * really removed.
 *
 * @example
 * ```typescript
 * // Preview what would be cleaned (dry run - the default)
 * const result = await git.clean()
 *   .setDryRun(true)
 *   .call();
 * for (const file of result.cleaned) {
 *   console.log(`Would remove: ${file}`);
 * }
 *
 * // Actually delete the untracked files
 * const result = await git.clean()
 *   .setDryRun(false)
 *   .call();
 *
 * // Include directories
 * const result = await git.clean()
 *   .setCleanDirectories(true)
 *   .call();
 * ```
 */
export class CleanCommand extends GitCommand<CleanResult> {
  private paths = new Set<string>();
  private dryRun = true; // Default to dry-run for safety
  private directories = false;
  private ignore = true; // Respect .gitignore

  /**
   * Limit clean to specific paths.
   *
   * @param paths Set of paths to clean
   */
  setPaths(paths: Set<string>): this {
    this.checkCallable();
    this.paths = paths;
    return this;
  }

  /**
   * Set dry run mode.
   *
   * When true (default), no files are actually deleted.
   * The result will still contain the list of files that would be cleaned.
   *
   * @param dryRun Whether to run in dry-run mode
   */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /**
   * Set whether to also clean directories.
   *
   * @param directories Whether to clean directories
   */
  setCleanDirectories(directories: boolean): this {
    this.checkCallable();
    this.directories = directories;
    return this;
  }

  /**
   * Set whether to respect .gitignore patterns.
   *
   * When true (default), ignored files are not cleaned.
   * When false, ignored files are also cleaned.
   *
   * @param ignore Whether to respect .gitignore
   */
  setIgnore(ignore: boolean): this {
    this.checkCallable();
    this.ignore = ignore;
    return this;
  }

  /**
   * Execute the clean command.
   *
   * @returns CleanResult with set of cleaned files
   */
  async call(): Promise<CleanResult> {
    this.checkCallable();
    this.setCallable(false);

    const cleaned = new Set<string>();
    const toRemove: Array<{ path: string; isDirectory: boolean }> = [];

    // Check if worktree is available
    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new Error("CleanCommand requires a WorkingCopy with worktree");
    }

    // Get entries from staging to compare
    const stagedPaths = new Set<string>();
    for await (const entry of this.staging.entries()) {
      stagedPaths.add(entry.path);
    }

    // Get entries from HEAD commit (if any) to compare
    const headPaths = new Set<string>();
    try {
      const head = await this.refsStore.resolve("HEAD");
      if (head?.objectId) {
        const commit = await this.commits.load(head.objectId);
        if (commit) {
          await this.collectTreePaths(commit.tree, "", headPaths);
        }
      }
    } catch {
      // No HEAD yet, all files are "new"
    }

    // Walk worktree and find untracked files
    const options = {
      includeIgnored: !this.ignore,
      includeDirectories: this.directories,
    };

    for await (const entry of worktree.walk(options)) {
      const entryTyped = entry as { path: string; isDirectory: boolean; isIgnored?: boolean };

      // Skip if in specific paths and not matching
      if (this.paths.size > 0) {
        let matches = false;
        for (const p of this.paths) {
          if (entryTyped.path === p || entryTyped.path.startsWith(`${p}/`)) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      // Skip if ignored and respecting .gitignore
      if (this.ignore && entryTyped.isIgnored) {
        continue;
      }

      // Skip if tracked (in staging or HEAD)
      if (stagedPaths.has(entryTyped.path) || headPaths.has(entryTyped.path)) {
        continue;
      }

      // Skip directories unless specified
      if (entryTyped.isDirectory && !this.directories) {
        continue;
      }

      // This file is untracked and should be cleaned
      const displayPath = entryTyped.isDirectory ? `${entryTyped.path}/` : entryTyped.path;
      cleaned.add(displayPath);

      // Collect rather than delete inline: removing entries while the walk is
      // still iterating the same directories is not safe for all Worktree
      // implementations.
      if (!this.dryRun) {
        toRemove.push({ path: entryTyped.path, isDirectory: entryTyped.isDirectory });
      }
    }

    for (const { path, isDirectory } of toRemove) {
      await worktree.remove(path, { recursive: isDirectory });
    }

    return {
      cleaned,
      dryRun: this.dryRun,
    };
  }

  /**
   * Collect all paths from a tree recursively.
   */
  private async collectTreePaths(
    treeId: string,
    prefix: string,
    paths: Set<string>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Check if directory mode (0o040000)
      if ((entry.mode & 0o170000) === 0o040000) {
        await this.collectTreePaths(entry.id, fullPath, paths);
      } else {
        paths.add(fullPath);
      }
    }
  }
}
