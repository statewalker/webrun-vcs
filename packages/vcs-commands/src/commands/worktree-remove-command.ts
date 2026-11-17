import type { LinkedWorktrees, WorktreeInfo } from "@statewalker/vcs-working-tree";

import { WorktreeError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { StatusCommand } from "./status-command.js";
import { checkCandidatePath, findLinkedWorktree, requireWorktrees } from "./worktree-support.js";

/** The refusals `move` and `remove` share for a locked worktree. */
function refuseLocked(wt: WorktreeInfo, force: number, verb: "move" | "remove"): void {
  if (force >= 2 || wt.lockReason === undefined) return;
  throw new WorktreeError(
    wt.lockReason
      ? `cannot ${verb} a locked working tree, lock reason: ${wt.lockReason}\nuse '${verb} -f -f' to override or unlock first`
      : `cannot ${verb} a locked working tree;\nuse '${verb} -f -f' to override or unlock first`,
  );
}

/**
 * A worktree this storage cannot name (outside the FilesApi's root, or written through a
 * path the root does not match) cannot be checked or changed: refused rather than taken
 * as missing.
 */
function refuseBeyond(worktrees: LinkedWorktrees, wt: WorktreeInfo, verb: "move" | "remove"): void {
  if (worktrees.reachable(wt)) return;
  throw new WorktreeError(`cannot ${verb} '${wt.path}': it is beyond this storage`);
}

/** git's `validate_no_submodules`. */
async function refuseSubmodules(worktrees: LinkedWorktrees, wt: WorktreeInfo): Promise<void> {
  if (await worktrees.hasSubmodules(wt)) {
    throw new WorktreeError("working trees containing submodules cannot be moved or removed");
  }
}

/**
 * Remove a linked worktree: its directory and its administrative files.
 *
 * Equivalent to `git worktree remove [-f] <worktree>`.
 *
 * @example
 * ```typescript
 * await git.worktreeRemove().setWorktree("../hotfix").call();
 * await git.worktreeRemove().setWorktree("../usb-wt").setForce(2).call(); // locked too
 * ```
 *
 * Refused (`WorktreeError`, git's messages): no such worktree; the main worktree; a locked
 * worktree unless forced twice; a worktree whose `.git` file does not point back (a gone
 * directory is fine); unless forced, one with submodules, or with modified, staged or
 * untracked files (git's `status --porcelain --ignore-submodules=none`, ignored files
 * aside); a worktree beyond this storage (outside the FilesApi's root, or reached through a
 * path the root does not match), which cannot be checked. The directory goes, then `.git/worktrees/<id>`, then `.git/worktrees` if empty.
 */
export class WorktreeRemoveCommand extends GitCommand<WorktreeInfo> {
  private worktree?: string;
  private force = 0;

  /** The worktree: a path, or a unique suffix of one. */
  setWorktree(worktree: string): this {
    this.checkCallable();
    this.worktree = worktree;
    return this;
  }

  /** `-f` (`true` or 1): dirty or untracked files go; `-f -f` (2): locked too. */
  setForce(force: boolean | number): this {
    this.checkCallable();
    this.force = typeof force === "number" ? force : force ? 1 : 0;
    return this;
  }

  async call(): Promise<WorktreeInfo> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "remove");
    const arg = this.worktree;
    const wt = await findLinkedWorktree(worktrees, arg, "'%s' is a main working tree");
    refuseBeyond(worktrees, wt, "remove");
    refuseLocked(wt, this.force, "remove");
    const invalid = await worktrees.validate(wt, { missingOk: true });
    if (invalid)
      throw new WorktreeError(`validation failed, cannot remove working tree: ${invalid}`);

    if ((await worktrees.pathState(wt.path)) !== "missing") {
      if (this.force === 0) {
        await refuseSubmodules(worktrees, wt);
        const status = await new StatusCommand(await worktrees.open(wt))
          .setIgnoreSubmodules("none")
          .call();
        if (!status.isClean()) {
          throw new WorktreeError(
            `'${arg}' contains modified or untracked files, use --force to delete it`,
          );
        }
      }
      await worktrees.deleteWorkTree(wt);
    }
    await worktrees.deleteAdminDir(wt.id as string);
    await worktrees.deleteAdminRootIfEmpty();
    return wt;
  }
}

/**
 * Move a linked worktree.
 *
 * Equivalent to `git worktree move [-f] <worktree> <new-path>`.
 *
 * @example
 * ```typescript
 * await git.worktreeMove().setWorktree("../hotfix").setDestination("../fix-1").call();
 * ```
 *
 * An existing directory as destination receives the worktree under its own name. Refused
 * (`WorktreeError`): no such worktree; the main worktree; a destination that exists and is
 * not an empty directory, or where a missing worktree is registered (unless forced);
 * submodules; a locked worktree unless forced twice; a worktree whose `.git` file does not
 * point back; a worktree beyond this storage. The directory is renamed, then `gitdir` and the worktree's `.git` file name
 * the new place.
 */
export class WorktreeMoveCommand extends GitCommand<WorktreeInfo> {
  private worktree?: string;
  private destination?: string;
  private force = 0;

  /** The worktree: a path, or a unique suffix of one. */
  setWorktree(worktree: string): this {
    this.checkCallable();
    this.worktree = worktree;
    return this;
  }

  /** `<new-path>`. */
  setDestination(destination: string): this {
    this.checkCallable();
    this.destination = destination;
    return this;
  }

  /** `-f` (`true` or 1), `-f -f` (2): a locked worktree too. */
  setForce(force: boolean | number): this {
    this.checkCallable();
    this.force = typeof force === "number" ? force : force ? 1 : 0;
    return this;
  }

  async call(): Promise<WorktreeInfo> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "move");
    if (this.destination === undefined) throw new WorktreeError("<new-path> is required");
    let destination = this.destination;
    const wt = await findLinkedWorktree(worktrees, this.worktree, "'%s' is a main working tree");
    refuseBeyond(worktrees, wt, "move");
    const state = await worktrees.pathState(destination);
    if (state === "directory" || state === "empty-directory") {
      const sep = wt.path.lastIndexOf("/");
      if (sep < 0) {
        throw new WorktreeError(`could not figure out destination name from '${wt.path}'`);
      }
      destination = `${destination.replace(/\/+$/, "")}${wt.path.slice(sep)}`;
    }
    await checkCandidatePath(worktrees, destination, this.force, "move");
    await refuseSubmodules(worktrees, wt);
    refuseLocked(wt, this.force, "move");
    const invalid = await worktrees.validate(wt);
    if (invalid) throw new WorktreeError(`validation failed, cannot move working tree: ${invalid}`);
    try {
      await worktrees.move(wt, destination);
    } catch (error) {
      throw new WorktreeError(error instanceof Error ? error.message : String(error));
    }
    return { ...wt, path: worktrees.hostPath(destination) };
  }
}
