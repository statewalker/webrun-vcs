import type { ObjectId } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import type { StashEntry } from "../results/stash-result.js";
import { LogCommand } from "./log-command.js";
import type { LogOutputOptions } from "./log-output.js";

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

    // The index is the reflog position (stash@{n}), even if an entry cannot be parsed.
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
   * `git stash list [<log-options>]` as git prints it: `git log --format="%gd: %gs" -g
   * --first-parent <options> refs/stash --`, so `stash@{0}: WIP on main: ...` by default,
   * and the log's formats, dates and diffs (`-p`, `--stat`: each entry against the commit
   * it was made on) when asked. `walk` sets the walk's options on the log command (`-n`,
   * `--skip`, `--grep`, `--author`...). Nothing is printed without a stash.
   *
   * @example
   * ```typescript
   * await git.stashList().callText(); // "stash@{0}: On main: msg\n"
   * await git.stashList().callText({ stat: true }, (log) => log.setMaxCount(1));
   * ```
   */
  async callText(
    options: LogOutputOptions = {},
    walk?: (log: LogCommand) => void,
  ): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const stashRef = await this.refsStore.get(STASH_REF);
    if (!stashRef) return "";
    const log = new LogCommand(this.workingCopy)
      .shareReadsOf(this)
      .setReflogWalk(STASH_REF)
      .setFirstParent(true);
    walk?.(log);
    // git's own --format comes first: the caller's format options win over it
    const pretty = options.pretty ?? (options.oneline ? undefined : "%gd: %gs");
    return log.callText({ ...options, ...(pretty !== undefined ? { pretty } : {}) });
  }

  /**
   * Get stash entries: the reflog of `refs/stash`, newest first, as `git stash list`
   * reads it. A store without reflogs gives only the current `refs/stash`.
   */
  private async getStashReflog(): Promise<Array<{ commitId: ObjectId; message: string }>> {
    const reflog = await this.refsStore.getReflog?.(STASH_REF);
    if (reflog) {
      return (await reflog.getReverseEntries()).map((e) => ({
        commitId: e.newId,
        message: e.comment,
      }));
    }
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
