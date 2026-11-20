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
 * With a ref store that keeps reflogs (`getReflog`, `deleteReflogEntry`), any
 * `stash@{n}` can be dropped, as git drops it; otherwise only the most recent
 * stash (index 0).
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
  /** Whether a stash was named ({@link setStashRef}): git's message for a missing one differs */
  private stashRefGiven = false;
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
    this.stashRefGiven = true;
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
      // `git stash clear` without a stash is fine, `git stash drop` is not (get_stash_info):
      //   git stash drop           -> "No stash entries found."
      //   git stash drop stash@{5} -> "error: stash@{5} is not a valid reference"
      // both exit 1 on git 2.43, 128 on 2.5x (cmd_stash maps a failure to die's status)
      if (this.dropAll) return undefined;
      const message = this.stashRefGiven
        ? `error: stash@{${this.stashRefEntry}} is not a valid reference`
        : "No stash entries found.";
      throw new InvalidStashIndexError(this.stashRefEntry, message).withExitCode(128);
    }

    // Drop all stashes: delete the ref and its reflog (`git stash clear`)
    if (this.dropAll) {
      await this.deleteStashRef(stashRef.objectId);
      return undefined;
    }

    // With reflog support, as `git stash drop stash@{n}`: `git reflog delete --rewrite
    // --updateref refs/stash@{n}` (under the ref's and the log's locks on git files),
    // then the ref goes once no entry is left.
    const refs = this.refsStore;
    const reflog = await refs.getReflog?.(STASH_REF);
    if (reflog && refs.deleteReflogEntry) {
      if (!(await reflog.getReverseEntry(this.stashRefEntry))) {
        // get_oid of stash@{n} beyond the log dies (exit 128 on every version)
        const count = (await reflog.getReverseEntries()).length;
        throw new InvalidStashIndexError(
          this.stashRefEntry,
          `fatal: log for 'stash' only has ${count} entries`,
        );
      }
      const left = await refs.deleteReflogEntry(STASH_REF, this.stashRefEntry, {
        rewrite: true,
        updateRef: true,
      });
      // As git: refs/stash goes only once refs/stash@{0} no longer exists, re-checked
      // now, so a stash pushed since the drop is kept (and returned).
      const top = await (await refs.getReflog?.(STASH_REF))?.getReverseEntry(0);
      if (left > 0 || top) return top?.newId;
      const current = await refs.get(STASH_REF);
      if (current && "objectId" in current && current.objectId) {
        // a push between our read and the delete wins: the drop itself has succeeded
        await this.deleteStashRef(current.objectId, { ignoreMismatch: true });
      }
      const after = await (await refs.getReflog?.(STASH_REF))?.getReverseEntry(0);
      return after?.newId;
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
    await this.deleteStashRef(stashRef.objectId);
    return undefined;
  }

  /**
   * Delete `refs/stash` and its reflog if it still holds `expected` (git's clear_stash).
   * With `ignoreMismatch`, a ref another writer moved meanwhile is left alone.
   */
  private async deleteStashRef(
    expected: ObjectId,
    options: { ignoreMismatch?: boolean } = {},
  ): Promise<void> {
    const result = await this.refsStore.batch([
      { name: STASH_REF, old: expected, new: null, noDeref: true },
    ]);
    const moved = result.rejected.every((r) => r.reason === "mismatch");
    if (!result.ok && !(options.ignoreMismatch && moved)) {
      const why = result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ");
      throw new Error(`Cannot drop the stash: ${why}`);
    }
  }
}
