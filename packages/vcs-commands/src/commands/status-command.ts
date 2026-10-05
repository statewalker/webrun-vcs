import type { ObjectId } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { MergeStage } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { type Status, StatusImpl } from "../results/status-result.js";

/**
 * Entry with full path for internal use.
 */
interface PathEntry {
  path: string;
  mode: number;
  id: ObjectId;
}

/**
 * Shows the staging area status compared to HEAD.
 *
 * This is a simplified version for repositories without working trees,
 * focusing on staged changes and conflicts.
 *
 * Equivalent to `git status` but only for staged changes.
 *
 * Based on JGit's StatusCommand (staged-only subset).
 *
 * @example
 * ```typescript
 * // Get repository status
 * const status = await git.status().call();
 *
 * // Check if clean
 * if (status.isClean()) {
 *   console.log("Nothing to commit");
 * }
 *
 * // Check for changes
 * console.log("Added:", status.added);
 * console.log("Changed:", status.changed);
 * console.log("Removed:", status.removed);
 * console.log("Conflicting:", status.conflicting);
 *
 * // Filter by path
 * const subStatus = await git.status()
 *   .addPath("src/")
 *   .call();
 * ```
 */
export class StatusCommand extends GitCommand<Status> {
  private paths: string[] = [];

  /**
   * Add a path filter.
   *
   * Only status for paths starting with this prefix will be returned.
   *
   * @param path Path prefix to filter by
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  async call(): Promise<Status> {
    this.checkCallable();
    this.setCallable(false);

    // Get conflicting paths first
    const conflicting = new Set<string>();
    for (const path of await this.staging.getConflictedPaths()) {
      if (this.matchesPath(path)) {
        conflicting.add(path);
      }
    }

    // Get HEAD tree entries
    const headEntries = new Map<string, PathEntry>();
    const headRef = await this.refsStore.resolve("HEAD");
    if (headRef?.objectId) {
      try {
        const headCommit = await this.commits.load(headRef.objectId);
        if (headCommit) {
          await this.collectTreeEntries(headCommit.tree, "", headEntries);
        }
      } catch {
        // No HEAD commit yet - headEntries stays empty
      }
    }

    // Get staging entries (only stage 0 = merged)
    const stagingEntries = new Map<string, PathEntry>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === MergeStage.MERGED) {
        stagingEntries.set(entry.path, {
          path: entry.path,
          mode: entry.mode,
          id: entry.objectId,
        });
      }
    }

    // Compare HEAD vs staging
    const added = new Set<string>();
    const changed = new Set<string>();
    const removed = new Set<string>();

    // Files in staging but not in HEAD = added
    // Files in staging and HEAD with different IDs = changed
    for (const [path, stagingEntry] of stagingEntries) {
      if (!this.matchesPath(path)) continue;

      const headEntry = headEntries.get(path);
      if (!headEntry) {
        added.add(path);
      } else if (headEntry.id !== stagingEntry.id || headEntry.mode !== stagingEntry.mode) {
        changed.add(path);
      }
    }

    // Files in HEAD but not in staging = removed
    for (const [path] of headEntries) {
      if (!this.matchesPath(path)) continue;

      if (!stagingEntries.has(path)) {
        removed.add(path);
      }
    }

    return new StatusImpl(added, changed, removed, conflicting);
  }

  /**
   * Check if a path matches the configured path filters.
   */
  private matchesPath(path: string): boolean {
    if (this.paths.length === 0) {
      return true;
    }

    for (const filterPath of this.paths) {
      if (
        path === filterPath ||
        path.startsWith(`${filterPath}/`) ||
        filterPath.startsWith(`${path}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, PathEntry>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        // Recurse into subtree
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        // Blob entry
        entries.set(path, { path, mode: entry.mode, id: entry.id });
      }
    }
  }
}
