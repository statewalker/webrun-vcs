import type { ObjectId, OwnReflogLine, Ref, Refs } from "@statewalker/vcs-core";
import {
  compareRefNames,
  formatPersonIdent,
  isSymbolicRef,
  isValidBranchName,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorktreeInfo } from "@statewalker/vcs-working-tree";

import {
  BranchUsedByWorktreeError,
  CannotDeleteCurrentBranchError,
  InvalidRefNameError,
  NotMergedError,
  RefAlreadyExistsError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { ListBranchMode } from "../types.js";
import { reflogMessages } from "./reflog-messages.js";
import { shortBranchName, worktreeUsingBranch } from "./worktree-support.js";

/**
 * Create a new branch.
 *
 * Equivalent to `git branch <name>`. With `setForce`, an existing branch some worktree has
 * checked out is refused (`BranchUsedByWorktreeError`: `cannot force update the branch 'x'
 * used by worktree at '<path>'`), where the backend keeps linked worktrees.
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
    const exists = await this.refsStore.has(refName);
    if (!this.force && exists) {
      throw new RefAlreadyExistsError(refName, `Branch '${this.name}' already exists`);
    }
    // git's validate_new_branchname: a branch a worktree has checked out is not force-moved
    const worktrees = this.workingCopy.worktrees;
    if (exists && worktrees) {
      const user = await worktreeUsingBranch(worktrees, refName);
      if (user) {
        throw new BranchUsedByWorktreeError(
          this.name,
          user.path,
          `cannot force update the branch '${this.name}' used by worktree at '${user.path}'`,
        );
      }
    }

    // Resolve start point
    const targetId = this.startPoint
      ? await this.resolveRef(this.startPoint, (n) => `fatal: not a valid branch point: '${n}'`)
      : await this.resolveHead();

    // git's create_branch: "branch: Created from <start>", "branch: Reset to <start>" (-f);
    // without a start point, cmd_branch names the branch checked out (`HEAD` when detached)
    const current = await this.getCurrentBranch();
    const start = this.startPoint ?? (current ? current.replace(/^refs\/heads\//, "") : "HEAD");
    const message = exists
      ? reflogMessages.branchReset(start)
      : reflogMessages.branchCreated(start);
    await this.refsStore.set(refName, targetId, this.reflogLine(message));

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
 * Where the backend keeps linked worktrees (`WorkingCopy.worktrees`), a branch any worktree
 * has checked out (or is rebasing or bisecting) is refused, as git's `branch_checked_out`:
 * `cannot delete branch 'x' used by worktree at '<path>'` (`BranchUsedByWorktreeError`;
 * `CannotDeleteCurrentBranchError` with that message for this worktree's own branch).
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
    const worktrees = this.workingCopy.worktrees;

    for (const name of this.branchNames) {
      const refName = name.startsWith("refs/") ? name : `refs/heads/${name}`;

      // git's branch_checked_out: no worktree's branch is deleted (this one's included)
      const user = worktrees ? await worktreeUsingBranch(worktrees, refName) : undefined;
      if (user) {
        const message = `cannot delete branch '${shortBranchName(refName)}' used by worktree at '${user.path}'`;
        if (user.current) throw new CannotDeleteCurrentBranchError(name, message);
        throw new BranchUsedByWorktreeError(shortBranchName(refName), user.path, message);
      }

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

    // git's delete_branch_config: a deleted branch's `[branch "<name>"]` section goes too
    const config = RemoteConfigStore.from(this.workingCopy);
    const configured = new Set(config.subsections("branch"));
    const sections = deleted
      .filter((r) => r.startsWith("refs/heads/"))
      .map((r) => shortBranchName(r))
      .filter((name) => configured.has(name));
    for (const name of sections) config.removeSection(`branch.${name}`);
    if (sections.length > 0) await config.save();

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
    branches.sort((a, b) => compareRefNames(a.name, b.name));

    return branches;
  }
}

/**
 * Rename a branch. Other worktrees whose HEAD is on it follow the new name, with git's
 * `Branch: renamed <old> to <new>` line in their HEAD reflog (git's
 * `replace_each_worktree_head_symref`). Refused (`BranchUsedByWorktreeError`) while a
 * worktree rebases or bisects the branch (`branch refs/heads/x is being rebased at <path>`).
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

    // Everything checked before anything changes: git's reject_rebase_or_bisect_branch (a
    // worktree with a detached HEAD rebasing or bisecting the branch), and the other
    // worktrees whose HEAD is on it
    const worktrees = this.workingCopy.worktrees;
    const others: WorktreeInfo[] = [];
    if (worktrees) {
      for (const wt of await worktrees.list()) {
        if (wt.detached && wt.rebasing === oldRefName) {
          throw new BranchUsedByWorktreeError(
            shortBranchName(oldRefName),
            wt.path,
            `branch ${oldRefName} is being rebased at ${wt.path}`,
          );
        }
        if (wt.detached && wt.bisecting === oldRefName) {
          throw new BranchUsedByWorktreeError(
            shortBranchName(oldRefName),
            wt.path,
            `branch ${oldRefName} is being bisected at ${wt.path}`,
          );
        }
        if (!wt.current && !wt.detached && wt.headRef === oldRefName) others.push(wt);
      }
    }

    // As git's files_copy_or_rename_ref: the old ref deleted (HEAD on it logs `<id> 0`), its
    // reflog carried over to the new ref with a `<id> <id>` line; then HEAD follows
    const message = reflogMessages.branchRenamed(oldRefName, newRefName);
    const log = this.reflogLine(message);
    const id = oldRef.objectId;
    const carried = await reflogLinesOfRef(this.refsStore, oldRefName);
    // (no log to carry: the new ref gets one only where git creates logs of branches,
    // core.logAllRefUpdates, false by default in a bare repository)
    const config = RemoteConfigStore.from(this.workingCopy);
    const logAll = logsBranches(config);
    const ownLines = [...carried, { oldId: id, newId: id, message, ...log }];
    const created = await this.refsStore.batch(
      [
        {
          name: newRefName,
          old: null,
          new: id,
          ...(carried.length > 0 || logAll ? { reflog: ownLines } : {}),
        },
      ],
      log,
    );
    if (!created.ok) {
      throw new RefAlreadyExistsError(newRefName, `Branch '${this.newName}' already exists`);
    }
    const head = await this.refsStore.get("HEAD");
    const onHead = head && isSymbolicRef(head) && head.target === oldRefName;
    await this.refsStore.batch([{ name: oldRefName, new: null }], log);

    // Update HEAD if it was pointing to old branch
    if (onHead) await this.refsStore.setSymbolic("HEAD", newRefName, log);
    // and every other worktree's HEAD on it, through that worktree's own refs, logged as
    // git's replace_each_worktree_head_symref logs it
    for (const wt of others) await worktrees?.updateHead(wt, newRefName, { ...log, message });

    // git's copy_or_rename_branch: the branch's configuration follows it
    // (git_config_rename_section of branch.<old> to branch.<new>)
    const oldShort = shortBranchName(oldRefName);
    if (oldShort !== this.newName) {
      config.renameSection(`branch.${oldShort}`, `branch.${this.newName}`);
      await config.save();
    }

    this.setCallable(false);

    const ref = await this.refsStore.get(newRefName);
    return ref as Ref;
  }
}

/**
 * Copy a branch: the new branch at the old one's commit, with a copy of its reflog and of
 * its configuration (`branch.<old>.*`), as git's `branch -c` (`files_copy_or_rename_ref`
 * with copy, `git_config_copy_section`). HEAD stays where it is, also when the branch
 * copied is the current one. Its reflog gets `Branch: copied refs/heads/<old> to
 * refs/heads/<new>`.
 *
 * Equivalent to `git branch -c [<old>] <new>` (`-C` with `setForce`).
 *
 * @example
 * ```typescript
 * await git.branchCopy().setNewName("feature-backup").call(); // the current branch
 * await git.branchCopy().setOldName("feature").setNewName("feature2").call();
 * ```
 */
export class CopyBranchCommand extends GitCommand<Ref> {
  private oldName?: string;
  private newName?: string;
  private force = false;

  /** The branch to copy (default: the current one). */
  setOldName(oldName: string): this {
    this.checkCallable();
    this.oldName = oldName;
    return this;
  }

  /** The new branch's name. */
  setNewName(newName: string): this {
    this.checkCallable();
    this.newName = newName;
    return this;
  }

  /** Overwrite a branch of the new name (`-C`); never one a worktree has checked out. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * @returns the new branch
   * @throws InvalidRefNameError for an invalid new name
   * @throws RefNotFoundError when the branch to copy does not exist (`fatal: no branch
   *   named 'x'`, or `fatal: no commit on branch 'x' yet` for the current, unborn one)
   * @throws RefAlreadyExistsError when the new branch exists, without `setForce`
   * @throws BranchUsedByWorktreeError when it is checked out in a worktree
   */
  async call(): Promise<Ref> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.newName) throw new InvalidRefNameError("", "New branch name is required");
    if (!isValidBranchName(this.newName)) {
      throw new InvalidRefNameError(
        this.newName,
        `fatal: '${this.newName}' is not a valid branch name`,
      );
    }
    const current = await this.getCurrentBranch();
    let oldRefName: string;
    if (this.oldName) {
      oldRefName = this.oldName.startsWith("refs/") ? this.oldName : `refs/heads/${this.oldName}`;
    } else if (current) {
      oldRefName = current;
    } else {
      throw new RefNotFoundError("HEAD", "fatal: cannot copy the current branch while not on any");
    }
    const oldShort = shortBranchName(oldRefName);
    const newRefName = `refs/heads/${this.newName}`;
    const oldRef = await this.refsStore.get(oldRefName);
    const id = oldRef && !isSymbolicRef(oldRef) ? oldRef.objectId : undefined;
    if (!id) {
      throw new RefNotFoundError(
        oldRefName,
        current === oldRefName
          ? `fatal: no commit on branch '${oldShort}' yet`
          : `fatal: no branch named '${oldShort}'`,
      );
    }

    // validate_new_branchname (validate_branchname when copying a branch onto itself)
    if (newRefName !== oldRefName && (await this.refsStore.has(newRefName))) {
      if (!this.force) {
        throw new RefAlreadyExistsError(
          newRefName,
          `fatal: a branch named '${this.newName}' already exists`,
        );
      }
      const worktrees = this.workingCopy.worktrees;
      const user = worktrees
        ? await worktreeUsingBranch(worktrees, newRefName)
        : current === newRefName
          ? { path: "." }
          : undefined;
      if (user) {
        throw new BranchUsedByWorktreeError(
          this.newName,
          user.path,
          `fatal: cannot force update the branch '${this.newName}' used by worktree at '${user.path}'`,
        );
      }
    }

    // files_copy_or_rename_ref with copy: the old reflog copied over the new one's, then
    // the new ref written with an `<id> <id>` line (HEAD logs it only when on the new ref)
    const message = reflogMessages.branchCopied(oldRefName, newRefName);
    const log = this.reflogLine(message);
    const config = RemoteConfigStore.from(this.workingCopy);
    const carried = await reflogLinesOfRef(this.refsStore, oldRefName);
    const line = { oldId: id, newId: id, message, ...log };
    if (newRefName === oldRefName) {
      // copied onto itself: one `<id> <id>` line (also HEAD's, when on it)
      await this.refsStore.batch([{ name: newRefName, new: id, reflog: [line] }], log);
    } else if (carried.length > 0 || logsBranches(config)) {
      // the new branch's own log is replaced: a branch -C overwrites goes first
      if (await this.refsStore.has(newRefName)) {
        await this.refsStore.batch([{ name: newRefName, new: null }], log);
      }
      await this.refsStore.batch([{ name: newRefName, new: id, reflog: [...carried, line] }], log);
    } else {
      await this.refsStore.set(newRefName, id, log);
    }

    // git_config_copy_section(branch.<old>, branch.<new>), unless the names are the same
    if (oldShort !== this.newName) {
      config.copySection(`branch.${oldShort}`, `branch.${this.newName}`);
      await config.save();
    }

    return (await this.refsStore.get(newRefName)) as Ref;
  }
}

/** Whether git creates reflogs of branches (core.logAllRefUpdates; off in a bare repository). */
function logsBranches(config: RemoteConfigStore): boolean {
  const setting = config.value("core.logAllRefUpdates");
  return (
    setting?.trim().toLowerCase() === "always" ||
    (parseGitBool(setting) ?? !(parseGitBool(config.value("core.bare")) ?? false))
  );
}

/** A reflog's lines, oldest first, as a batch carries them to another ref. */
async function reflogLinesOfRef(refs: Refs, name: string): Promise<OwnReflogLine[]> {
  const log = await refs.getReflog?.(name);
  if (!log) return [];
  return (await log.getReverseEntries()).reverse().map((entry) => ({
    oldId: entry.oldId,
    newId: entry.newId,
    ident: formatPersonIdent(entry.who),
    message: entry.comment,
  }));
}
