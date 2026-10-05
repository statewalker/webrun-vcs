import type { FileModeValue, ObjectId, TreeEntry } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import {
  ChangeType,
  createAddEntry,
  createDeleteEntry,
  createModifyEntry,
  type DiffEntry,
} from "../results/diff-entry.js";

/**
 * Show changes between commits, trees, and staging.
 *
 * Equivalent to `git diff`.
 *
 * Based on JGit's DiffCommand.
 *
 * @example
 * ```typescript
 * // Compare two commits
 * const entries = await git.diff()
 *   .setOldTree(commitA)
 *   .setNewTree(commitB)
 *   .call();
 *
 * // Compare HEAD to staging
 * const staged = await git.diff()
 *   .setCached(true)
 *   .call();
 *
 * // Filter by path prefix
 * const srcChanges = await git.diff()
 *   .setOldTree(commitA)
 *   .setNewTree(commitB)
 *   .setPathFilter("src/")
 *   .call();
 *
 * for (const entry of entries) {
 *   console.log(`${entry.changeType}: ${entry.newPath ?? entry.oldPath}`);
 * }
 * ```
 */
export class DiffCommand extends GitCommand<DiffEntry[]> {
  private oldTree?: string;
  private newTree?: string;
  private cached = false;
  private pathFilter?: string;

  /**
   * Set the old (base) tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set, defaults to HEAD.
   *
   * @param refOrId Commit-ish or tree ID
   */
  setOldTree(refOrId: string): this {
    this.checkCallable();
    this.oldTree = refOrId;
    return this;
  }

  /**
   * Set the new tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set and cached=true, compares to staging.
   * If not set and cached=false, compares to HEAD.
   *
   * @param refOrId Commit-ish or tree ID
   */
  setNewTree(refOrId: string): this {
    this.checkCallable();
    this.newTree = refOrId;
    return this;
  }

  /**
   * Compare HEAD to staging area instead of working tree.
   *
   * Equivalent to `git diff --cached` or `git diff --staged`.
   *
   * @param cached Whether to compare to staging
   */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /**
   * Filter results to only paths starting with this prefix.
   *
   * @param path Path prefix to filter by
   */
  setPathFilter(path: string): this {
    this.checkCallable();
    this.pathFilter = path;
    return this;
  }

  /**
   * Execute the diff.
   *
   * @returns List of diff entries representing changes
   */
  async call(): Promise<DiffEntry[]> {
    this.checkCallable();
    this.setCallable(false);

    // Resolve old tree
    const oldTreeId = await this.resolveTreeId(this.oldTree ?? "HEAD");

    // Resolve new tree
    let newTreeId: ObjectId;
    if (this.newTree) {
      newTreeId = await this.resolveTreeId(this.newTree);
    } else if (this.cached) {
      // Compare to staging area
      newTreeId = await this.staging.writeTree(this.trees);
    } else {
      // Default: compare HEAD to HEAD (no changes)
      // In a real implementation with working tree, this would compare to working tree
      const headRef = await this.refsStore.resolve("HEAD");
      if (!headRef?.objectId) {
        return [];
      }
      const headCommit = await this.commits.load(headRef.objectId);
      if (!headCommit) {
        return [];
      }
      newTreeId = headCommit.tree;
    }

    // Perform tree comparison
    return this.diffTrees(oldTreeId, newTreeId);
  }

  /**
   * Resolve a ref to its tree ID.
   */
  private async resolveTreeId(refOrId: string): Promise<ObjectId> {
    // Try to resolve as a commit ref first
    try {
      const commitId = await this.resolveRef(refOrId);
      const commit = await this.commits.load(commitId);
      if (!commit) {
        // Assume it's a tree ID directly
        return refOrId;
      }
      return commit.tree;
    } catch {
      // Assume it's a tree ID directly
      return refOrId;
    }
  }

  /**
   * Compare two trees and return list of differences.
   */
  private async diffTrees(oldTreeId: ObjectId, newTreeId: ObjectId): Promise<DiffEntry[]> {
    const entries: DiffEntry[] = [];

    // Collect entries from both trees
    const oldPaths = new Map<string, TreeEntry>();
    const newPaths = new Map<string, TreeEntry>();

    await this.collectTreeEntries(oldTreeId, "", oldPaths);
    await this.collectTreeEntries(newTreeId, "", newPaths);

    // Find deleted and modified files
    for (const [path, oldEntry] of oldPaths) {
      if (this.pathFilter && !path.startsWith(this.pathFilter)) {
        continue;
      }

      const newEntry = newPaths.get(path);
      if (!newEntry) {
        // File was deleted
        entries.push(createDeleteEntry(path, oldEntry.id, oldEntry.mode as FileModeValue));
      } else if (oldEntry.id !== newEntry.id || oldEntry.mode !== newEntry.mode) {
        // File was modified
        entries.push(
          createModifyEntry(
            path,
            oldEntry.id,
            newEntry.id,
            oldEntry.mode as FileModeValue,
            newEntry.mode as FileModeValue,
          ),
        );
      }
    }

    // Find added files
    for (const [path, newEntry] of newPaths) {
      if (this.pathFilter && !path.startsWith(this.pathFilter)) {
        continue;
      }

      if (!oldPaths.has(path)) {
        entries.push(createAddEntry(path, newEntry.id, newEntry.mode as FileModeValue));
      }
    }

    // Sort entries by path for consistent output
    entries.sort((a, b) => {
      const pathA = a.newPath ?? a.oldPath ?? "";
      const pathB = b.newPath ?? b.oldPath ?? "";
      return pathA.localeCompare(pathB);
    });

    return entries;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, TreeEntry>,
  ): Promise<void> {
    const TREE_MODE = 0o40000;

    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === TREE_MODE) {
        // Recurse into subtree
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        // Blob entry
        entries.set(path, entry);
      }
    }
  }
}

/**
 * Format a DiffEntry for display.
 */
export function formatDiffEntry(entry: DiffEntry): string {
  switch (entry.changeType) {
    case ChangeType.ADD:
      return `A\t${entry.newPath}`;
    case ChangeType.DELETE:
      return `D\t${entry.oldPath}`;
    case ChangeType.MODIFY:
      return `M\t${entry.newPath}`;
    case ChangeType.RENAME:
      return `R${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
    case ChangeType.COPY:
      return `C${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
  }
}
