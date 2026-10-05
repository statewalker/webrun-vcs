import type { ObjectId, Ref } from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";

import {
  CannotDeleteCurrentBranchError,
  InvalidRefNameError,
  NotMergedError,
  RefAlreadyExistsError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { ListBranchMode } from "../types.js";

/**
 * Validate a branch name according to Git rules.
 *
 * @param name Branch name to validate
 * @returns true if valid
 */
function isValidBranchName(name: string): boolean {
  // Cannot be empty
  if (!name || name.length === 0) {
    return false;
  }

  // Cannot start or end with /
  if (name.startsWith("/") || name.endsWith("/")) {
    return false;
  }

  // Cannot contain ..
  if (name.includes("..")) {
    return false;
  }

  // Cannot contain special characters (control chars, space, ~^:?*[\)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git ref validation requires checking for control characters
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(name)) {
    return false;
  }

  // Cannot end with .lock
  if (name.endsWith(".lock")) {
    return false;
  }

  // Cannot start with -
  if (name.startsWith("-")) {
    return false;
  }

  // Cannot be @
  if (name === "@") {
    return false;
  }

  // Cannot contain @{
  if (name.includes("@{")) {
    return false;
  }

  return true;
}

/**
 * Create a new branch.
 *
 * Equivalent to `git branch <name>`.
 *
 * Based on JGit's CreateBranchCommand.
 *
 * @example
 * ```typescript
 * // Create branch from HEAD
 * await git.branchCreate().setName("feature").call();
 *
 * // Create branch from specific commit
 * await git.branchCreate()
 *   .setName("hotfix")
 *   .setStartPoint("abc123")
 *   .call();
 *
 * // Force create (overwrite existing)
 * await git.branchCreate()
 *   .setName("existing")
 *   .setForce(true)
 *   .call();
 * ```
 */
export class CreateBranchCommand extends GitCommand<Ref> {
  private name?: string;
  private startPoint?: string;
  private force = false;

  /**
   * Set the name of the branch to create.
   *
   * @param name Branch name (without refs/heads/ prefix)
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /**
   * Set the starting point for the new branch.
   *
   * Can be a commit ID, branch name, or tag name.
   * If not set, defaults to HEAD.
   *
   * @param startPoint Commit-ish to start from
   */
  setStartPoint(startPoint: string): this {
    this.checkCallable();
    this.startPoint = startPoint;
    return this;
  }

  /**
   * Set whether to force create the branch.
   *
   * If true, overwrites an existing branch.
   *
   * @param force Whether to force create
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Execute the branch creation.
   *
   * @returns The created branch ref
   * @throws InvalidRefNameError if branch name is invalid
   * @throws RefAlreadyExistsError if branch exists and force is false
   */
  async call(): Promise<Ref> {
    this.checkCallable();

    if (!this.name) {
      throw new InvalidRefNameError("", "Branch name is required");
    }

    if (!isValidBranchName(this.name)) {
      throw new InvalidRefNameError(this.name);
    }

    const refName = `refs/heads/${this.name}`;

    // Check if already exists
    if (!this.force && (await this.refsStore.has(refName))) {
      throw new RefAlreadyExistsError(refName, `Branch '${this.name}' already exists`);
    }

    // Resolve start point
    const targetId = this.startPoint
      ? await this.resolveRef(this.startPoint)
      : await this.resolveHead();

    await this.refsStore.set(refName, targetId);

    this.setCallable(false);

    const ref = await this.refsStore.get(refName);
    return ref as Ref;
  }
}

/**
 * Delete branches.
 *
 * Equivalent to `git branch -d` or `git branch -D`.
 *
 * Based on JGit's DeleteBranchCommand.
 *
 * @example
 * ```typescript
 * // Delete a single branch
 * await git.branchDelete().setBranchNames("feature").call();
 *
 * // Delete multiple branches
 * await git.branchDelete()
 *   .setBranchNames("feature", "hotfix")
 *   .call();
 *
 * // Force delete (even if not merged)
 * await git.branchDelete()
 *   .setBranchNames("feature")
 *   .setForce(true)
 *   .call();
 * ```
 */
export class DeleteBranchCommand extends GitCommand<string[]> {
  private branchNames: string[] = [];
  private force = false;

  /**
   * Set the branches to delete.
   *
   * @param names Branch names (without refs/heads/ prefix)
   */
  setBranchNames(...names: string[]): this {
    this.checkCallable();
    this.branchNames.push(...names);
    return this;
  }

  /**
   * Set whether to force delete.
   *
   * If true, deletes even if branch is not fully merged.
   *
   * @param force Whether to force delete
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Execute the branch deletion.
   *
   * @returns List of deleted branch names (full ref names)
   * @throws CannotDeleteCurrentBranchError if trying to delete current branch
   * @throws RefNotFoundError if branch doesn't exist
   * @throws NotMergedError if branch is not merged and force is false
   */
  async call(): Promise<string[]> {
    this.checkCallable();
    this.setCallable(false);

    const currentBranch = await this.getCurrentBranch();
    const deleted: string[] = [];

    for (const name of this.branchNames) {
      const refName = name.startsWith("refs/") ? name : `refs/heads/${name}`;

      // Cannot delete current branch
      if (currentBranch === refName) {
        throw new CannotDeleteCurrentBranchError(name);
      }

      // Check if exists
      if (!(await this.refsStore.has(refName))) {
        throw new RefNotFoundError(refName, `Branch '${name}' not found`);
      }

      // Check if fully merged (unless force)
      if (!this.force) {
        const isMerged = await this.isBranchMerged(refName);
        if (!isMerged) {
          throw new NotMergedError(name);
        }
      }

      await this.refsStore.delete(refName);
      deleted.push(refName);
    }

    return deleted;
  }

  /**
   * Check if a branch is fully merged into HEAD or upstream.
   */
  private async isBranchMerged(refName: string): Promise<boolean> {
    const ref = await this.refsStore.resolve(refName);
    if (!ref?.objectId) {
      return true; // Non-existent is "merged"
    }

    // Check if branch commit is ancestor of HEAD
    try {
      const headId = await this.resolveHead();
      return this.commits.isAncestor(ref.objectId, headId);
    } catch {
      // If HEAD doesn't exist, consider it merged
      return true;
    }
  }
}

/**
 * List branches.
 *
 * Equivalent to `git branch -l`.
 *
 * Based on JGit's ListBranchCommand.
 *
 * @example
 * ```typescript
 * // List local branches
 * const branches = await git.branchList().call();
 *
 * // List remote branches
 * const remote = await git.branchList()
 *   .setListMode(ListBranchMode.REMOTE)
 *   .call();
 *
 * // List all branches
 * const all = await git.branchList()
 *   .setListMode(ListBranchMode.ALL)
 *   .call();
 * ```
 */
export class ListBranchCommand extends GitCommand<Ref[]> {
  private listMode = ListBranchMode.LOCAL;
  private containsCommit?: ObjectId;

  /**
   * Set the listing mode.
   *
   * @param mode Which branches to list
   */
  setListMode(mode: ListBranchMode): this {
    this.checkCallable();
    this.listMode = mode;
    return this;
  }

  /**
   * Filter to branches containing the given commit.
   *
   * @param commit Commit that must be in branch history
   */
  setContains(commit: ObjectId): this {
    this.checkCallable();
    this.containsCommit = commit;
    return this;
  }

  /**
   * Execute the branch listing.
   *
   * @returns List of branch refs
   */
  async call(): Promise<Ref[]> {
    this.checkCallable();
    this.setCallable(false);

    const prefixes: string[] = [];
    if (this.listMode === ListBranchMode.LOCAL || this.listMode === ListBranchMode.ALL) {
      prefixes.push("refs/heads/");
    }
    if (this.listMode === ListBranchMode.REMOTE || this.listMode === ListBranchMode.ALL) {
      prefixes.push("refs/remotes/");
    }

    const branches: Ref[] = [];

    for (const prefix of prefixes) {
      for await (const ref of this.refsStore.list(prefix)) {
        // Skip symbolic refs
        if (isSymbolicRef(ref)) {
          continue;
        }

        // Filter by contains
        if (this.containsCommit && ref.objectId) {
          const contains = await this.commits.isAncestor(this.containsCommit, ref.objectId);
          if (!contains) {
            continue;
          }
        }

        branches.push(ref);
      }
    }

    // Sort by name
    branches.sort((a, b) => a.name.localeCompare(b.name));

    return branches;
  }
}

/**
 * Rename a branch.
 *
 * Equivalent to `git branch -m`.
 *
 * Based on JGit's RenameBranchCommand.
 *
 * @example
 * ```typescript
 * // Rename current branch
 * await git.branchRename().setNewName("new-name").call();
 *
 * // Rename specific branch
 * await git.branchRename()
 *   .setOldName("old-branch")
 *   .setNewName("new-branch")
 *   .call();
 * ```
 */
export class RenameBranchCommand extends GitCommand<Ref> {
  private oldName?: string;
  private newName?: string;

  /**
   * Set the old branch name.
   *
   * If not set, uses the current branch.
   *
   * @param oldName Current branch name
   */
  setOldName(oldName: string): this {
    this.checkCallable();
    this.oldName = oldName;
    return this;
  }

  /**
   * Set the new branch name.
   *
   * @param newName New branch name
   */
  setNewName(newName: string): this {
    this.checkCallable();
    this.newName = newName;
    return this;
  }

  /**
   * Execute the branch rename.
   *
   * @returns The renamed branch ref
   * @throws InvalidRefNameError if new name is invalid
   * @throws RefNotFoundError if old branch doesn't exist
   * @throws RefAlreadyExistsError if new branch already exists
   */
  async call(): Promise<Ref> {
    this.checkCallable();

    if (!this.newName) {
      throw new InvalidRefNameError("", "New branch name is required");
    }

    if (!isValidBranchName(this.newName)) {
      throw new InvalidRefNameError(this.newName);
    }

    // Determine old ref name
    let oldRefName: string;
    if (this.oldName) {
      oldRefName = this.oldName.startsWith("refs/") ? this.oldName : `refs/heads/${this.oldName}`;
    } else {
      const currentBranch = await this.getCurrentBranch();
      if (!currentBranch) {
        throw new RefNotFoundError("HEAD", "HEAD is detached, specify old branch name");
      }
      oldRefName = currentBranch;
    }

    const newRefName = `refs/heads/${this.newName}`;

    // Check old exists
    const oldRef = await this.refsStore.resolve(oldRefName);
    if (!oldRef?.objectId) {
      throw new RefNotFoundError(oldRefName);
    }

    // Check new doesn't exist
    if (await this.refsStore.has(newRefName)) {
      throw new RefAlreadyExistsError(newRefName, `Branch '${this.newName}' already exists`);
    }

    // Create new and delete old
    await this.refsStore.set(newRefName, oldRef.objectId);
    await this.refsStore.delete(oldRefName);

    // Update HEAD if it was pointing to old branch
    const head = await this.refsStore.get("HEAD");
    if (head && isSymbolicRef(head) && head.target === oldRefName) {
      await this.refsStore.setSymbolic("HEAD", newRefName);
    }

    this.setCallable(false);

    const ref = await this.refsStore.get(newRefName);
    return ref as Ref;
  }
}
