import type { ObjectId } from "@statewalker/vcs-core";

import { InvalidStashIndexError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { STASH_REF } from "./stash-list-command.js";

/**
 * Command to drop (delete) a stashed commit.
 *
 * Equivalent to `git stash drop`.
 *
 * Based on JGit's StashDropCommand.
 *
 * Note: Without reflog support in RefStore, only the most recent stash (index 0)
 * can be dropped. Dropping by index > 0 requires reflog support.
 *
 * @example
 * ```typescript
 * // Drop most recent stash
 * const result = await git.stashDrop().call();
 *
 * // Drop specific stash (requires reflog support)
 * const result = await git.stashDrop()
 *   .setStashRef(2)
 *   .call();
 *
 * // Drop all stashes
 * const result = await git.stashDrop()
 *   .setAll(true)
 *   .call();
 * ```
 */
export class StashDropCommand extends GitCommand<ObjectId | undefined> {
  private stashRefEntry = 0;
  private dropAll = false;

  /**
   * Set the stash reference to drop (0-based index).
   *
   * Defaults to 0 (most recent) if not specified.
   *
   * Note: Without reflog support, only index 0 is valid.
   *
   * @param stashRef The 0-based index of the stash to drop
   */
  setStashRef(stashRef: number): this {
    this.checkCallable();
    if (stashRef < 0) {
      throw new InvalidStashIndexError(stashRef, "Stash index must be >= 0");
    }
    this.stashRefEntry = stashRef;
    return this;
  }

  /**
   * Get the stash index to drop.
   */
  getStashRef(): number {
    return this.stashRefEntry;
  }

  /**
   * Set whether to drop all stashed commits.
   *
   * @param all true to drop all stashes
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.dropAll = all;
    return this;
  }

  /**
   * Get whether all stashes will be dropped.
   */
  getAll(): boolean {
    return this.dropAll;
  }

  /**
   * Execute the stash drop command.
   *
   * @returns The new stash ref after drop, or undefined if no stashes remain
   */
  async call(): Promise<ObjectId | undefined> {
    this.checkCallable();
    this.setCallable(false);

    // Check if stash ref exists
    const stashRef = await this.refsStore.get(STASH_REF);
    if (!stashRef || !("objectId" in stashRef) || !stashRef.objectId) {
      return undefined;
    }

    // Drop all stashes - just delete the ref
    if (this.dropAll) {
      await this.refsStore.delete(STASH_REF);
      return undefined;
    }

    // Without reflog support, we can only drop the most recent stash (index 0)
    // For index > 0, we would need reflog support to access older stashes
    if (this.stashRefEntry > 0) {
      throw new InvalidStashIndexError(
        this.stashRefEntry,
        `Stash entry ${this.stashRefEntry} cannot be dropped without reflog support. ` +
          `Only stash@{0} can be dropped.`,
      );
    }

    // Drop stash@{0} by deleting the ref
    await this.refsStore.delete(STASH_REF);
    return undefined;
  }
}
