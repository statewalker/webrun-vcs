import type { WorktreeInfo } from "@statewalker/vcs-working-tree";

import { WorktreeError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { findLinkedWorktree as findLinked, requireWorktrees } from "./worktree-support.js";

/**
 * Lock a linked worktree, so `prune` keeps it and `move` / `remove` refuse it.
 *
 * Equivalent to `git worktree lock [--reason <string>] <worktree>`.
 *
 * @example
 * ```typescript
 * await git.worktreeLock().setWorktree("../usb-wt").setReason("on a USB disk").call();
 * ```
 *
 * `<worktree>` is a path, or the end of one (`wt` for `/src/wt`) when only one worktree's
 * path ends so. Refused (`WorktreeError`): no such worktree, the main worktree, a worktree
 * already locked. The reason goes into `.git/worktrees/<id>/locked` (a line end added).
 */
export class WorktreeLockCommand extends GitCommand<WorktreeInfo> {
  private worktree?: string;
  private reason = "";

  /** The worktree: a path, or a unique suffix of one. */
  setWorktree(worktree: string): this {
    this.checkCallable();
    this.worktree = worktree;
    return this;
  }

  /** `--reason <string>` (default: none). */
  setReason(reason: string): this {
    this.checkCallable();
    this.reason = reason;
    return this;
  }

  async call(): Promise<WorktreeInfo> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "lock");
    const wt = await findLinked(
      worktrees,
      this.worktree,
      "The main working tree cannot be locked or unlocked",
    );
    if (wt.lockReason !== undefined) {
      throw new WorktreeError(
        wt.lockReason
          ? `'${this.worktree}' is already locked, reason: ${wt.lockReason}`
          : `'${this.worktree}' is already locked`,
      );
    }
    await worktrees.lock(wt, this.reason);
    return { ...wt, lockReason: this.reason.trim() };
  }
}

/**
 * Unlock a linked worktree.
 *
 * Equivalent to `git worktree unlock <worktree>`.
 *
 * @example
 * ```typescript
 * await git.worktreeUnlock().setWorktree("../usb-wt").call();
 * ```
 *
 * Refused (`WorktreeError`): no such worktree, the main worktree, a worktree not locked.
 */
export class WorktreeUnlockCommand extends GitCommand<WorktreeInfo> {
  private worktree?: string;

  /** The worktree: a path, or a unique suffix of one. */
  setWorktree(worktree: string): this {
    this.checkCallable();
    this.worktree = worktree;
    return this;
  }

  async call(): Promise<WorktreeInfo> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "unlock");
    const wt = await findLinked(
      worktrees,
      this.worktree,
      "The main working tree cannot be locked or unlocked",
    );
    if (wt.lockReason === undefined) throw new WorktreeError(`'${this.worktree}' is not locked`);
    await worktrees.unlock(wt);
    const { lockReason: _reason, ...unlocked } = wt;
    return unlocked;
  }
}
