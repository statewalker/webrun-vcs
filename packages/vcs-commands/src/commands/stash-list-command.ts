import type { ObjectId } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import type { StashEntry } from "../results/stash-result.js";

/**
 * Reference name for stash.
 */
export const STASH_REF = "refs/stash";

/**
 * Command to list stashed commits.
 *
 * Equivalent to `git stash list`.
 *
 * Based on JGit's StashListCommand.
 *
 * @example
 * ```typescript
 * // List all stashes
 * const stashes = await git.stashList().call();
 * for (const stash of stashes) {
 *   console.log(`stash@{${stash.index}}: ${stash.message}`);
 * }
 * ```
 */
export class StashListCommand extends GitCommand<StashEntry[]> {
  /**
   * Execute the stash list command.
   *
   * @returns Array of stash entries, most recent first
   */
  async call(): Promise<StashEntry[]> {
    this.checkCallable();
    this.setCallable(false);

    // Check if stash ref exists
    const stashRef = await this.refsStore.get(STASH_REF);
    if (!stashRef || !("objectId" in stashRef) || !stashRef.objectId) {
      return [];
    }

    // Get reflog for stash ref
    const stashes: StashEntry[] = [];
    const reflog = await this.getStashReflog();

    let index = 0;
    for (const entry of reflog) {
      const stashEntry = await this.parseStashEntry(entry.commitId, entry.message, index);
      if (stashEntry) {
        stashes.push(stashEntry);
      }
      index++;
    }

    return stashes;
  }

  /**
   * Get stash entries.
   *
   * Note: Without reflog support in the core RefStore interface,
   * this returns only the most recent stash (if any).
   */
  private async getStashReflog(): Promise<Array<{ commitId: ObjectId; message: string }>> {
    // Without reflog support, we can only return the current stash ref
    const stashRef = await this.refsStore.resolve(STASH_REF);
    if (stashRef?.objectId) {
      // Get the commit message from the stash commit
      const commit = await this.commits.load(stashRef.objectId);
      if (commit) {
        return [
          {
            commitId: stashRef.objectId,
            message: commit.message.split("\n")[0],
          },
        ];
      }
    }

    return [];
  }

  /**
   * Parse a stash commit into a StashEntry.
   */
  private async parseStashEntry(
    commitId: ObjectId,
    message: string,
    index: number,
  ): Promise<StashEntry | undefined> {
    try {
      const commit = await this.commits.load(commitId);
      if (!commit) {
        return undefined;
      }

      // Stash commits should have 2 or 3 parents
      if (commit.parents.length < 2) {
        return undefined;
      }

      return {
        commitId,
        headCommit: commit.parents[0],
        indexCommit: commit.parents[1],
        untrackedCommit: commit.parents[2], // Optional
        message: message || commit.message.split("\n")[0],
        index,
        timestamp: commit.committer.timestamp,
      };
    } catch {
      return undefined;
    }
  }
}
