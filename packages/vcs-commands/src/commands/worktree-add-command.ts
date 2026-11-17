import {
  isSymbolicRef,
  isValidBranchName,
  type ObjectId,
  type PersonIdent,
} from "@statewalker/vcs-core";
import type {
  CreatedLinkedWorktree,
  LinkedWorktrees,
  NewWorktreeHead,
  WorkingCopy,
} from "@statewalker/vcs-working-tree";

import { WorktreeError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { abbrevLengths, coreBool, worktreeModeTrust } from "./core-config.js";
import { checkoutFreshTree } from "./tree-restore.js";
import {
  checkCandidatePath,
  refuseIfCheckedOut,
  requireWorktrees,
  worktreeUsingBranch,
} from "./worktree-support.js";

/** What {@link WorktreeAddCommand} did. */
export interface WorktreeAddResult {
  /** The new worktree's path, as git prints it. */
  path: string;
  /** Its administrative directory's name (`.git/worktrees/<id>`). */
  id: string;
  /** The branch HEAD points at (`refs/heads/x`); undefined for a detached HEAD. */
  branch?: string;
  /** The commit HEAD resolves to; undefined for an unborn (`--orphan`) branch. */
  head?: ObjectId;
  /** What git prints on stderr (`Preparing worktree (...)`), without `--quiet`. */
  messages: string[];
  /** What git prints on stdout: the checkout's `HEAD is now at <abbrev> <subject>`, without `--quiet`. */
  output: string[];
  /** A working copy of the new worktree. */
  workingCopy: WorkingCopy;
}

/**
 * Add a linked worktree.
 *
 * Equivalent to `git worktree add [-f] [--detach] [--no-checkout] [--lock [--reason <r>]]
 * [--orphan] [(-b | -B) <new-branch>] <path> [<commit-ish>]`.
 *
 * @example
 * ```typescript
 * // a worktree on a new branch, checked out
 * await git.worktreeAdd().setPath("../hotfix").setNewBranch("hotfix").call();
 * // detached at a tag, locked
 * await git.worktreeAdd().setPath("../v1").setCommitish("v1.0").setDetach(true)
 *   .setLock(true).setLockReason("on a USB disk").call();
 * ```
 *
 * As git's `add`: without a commit-ish the new branch is named after the path's last
 * component (an existing branch of that name is checked out instead), and a repository
 * without any commit infers `--orphan`. Refused, with git's message (`WorktreeError`): a
 * path that exists and is not an empty directory; a missing path a worktree is still
 * registered at (unless forced: once, or twice when it is locked); a branch checked out in
 * another worktree (`BranchUsedByWorktreeError`, unless forced); a commit-ish that names no
 * commit; `-b` with a branch that exists.
 *
 * Steps, as git takes them: the branch is created first (`git branch`, reflog
 * `branch: Created from <commit-ish>`) and stays if the worktree then fails; the
 * administrative directory is written locked (`initializing`, or the `--lock` reason);
 * HEAD and its reflog line; then, unless `--no-checkout`, the files and the index are
 * checked out (git runs `reset --hard`: ORIG_HEAD and, on a branch, the reflog line
 * `reset: moving to HEAD`). A failure removes what was created. The `post-checkout`
 * hook is not run, and `--track` / `--guess-remote` are not supported.
 */
export class WorktreeAddCommand extends GitCommand<WorktreeAddResult> {
  private path?: string;
  private commitish?: string;
  private newBranch?: string;
  private forceNewBranch = false;
  private detach = false;
  private force = 0;
  private checkout = true;
  private lock = false;
  private lockReason?: string;
  private orphan = false;
  private quiet = false;
  private who?: PersonIdent;

  /** The new worktree's path (a path of the repository's storage, or an absolute host path). */
  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  /** What to check out (default: HEAD; with a new branch, its start). */
  setCommitish(commitish: string): this {
    this.checkCallable();
    this.commitish = commitish;
    return this;
  }

  /** `-b <branch>` (or `-B <branch>` with `force`): create the branch and check it out. */
  setNewBranch(branch: string, force = false): this {
    this.checkCallable();
    this.newBranch = branch;
    this.forceNewBranch = force;
    return this;
  }

  /** `--detach`: HEAD holds the commit, even when a branch is named. */
  setDetach(detach: boolean): this {
    this.checkCallable();
    this.detach = detach;
    return this;
  }

  /** `-f` (`true` or 1), `-f -f` (2). */
  setForce(force: boolean | number): this {
    this.checkCallable();
    this.force = typeof force === "number" ? force : force ? 1 : 0;
    return this;
  }

  /** `--[no-]checkout` (default: checked out). */
  setCheckout(checkout: boolean): this {
    this.checkCallable();
    this.checkout = checkout;
    return this;
  }

  /** `--lock`: the worktree stays locked. */
  setLock(lock: boolean): this {
    this.checkCallable();
    this.lock = lock;
    return this;
  }

  /** `--reason <text>` (requires `--lock`). */
  setLockReason(reason: string): this {
    this.checkCallable();
    this.lockReason = reason;
    return this;
  }

  /** `--orphan`: an unborn branch with an empty index. */
  setOrphan(orphan: boolean): this {
    this.checkCallable();
    this.orphan = orphan;
    return this;
  }

  /** `--quiet`: no messages. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** The identity of the reflog lines (default: the repository's `user.name` / `user.email`). */
  setIdent(who: PersonIdent): this {
    this.checkCallable();
    this.who = who;
    return this;
  }

  async call(): Promise<WorktreeAddResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "add");
    const path = this.path;
    if (path === undefined || path === "")
      throw new WorktreeError("worktree add: <path> is required");

    if (this.detach && this.newBranch !== undefined) {
      throw new WorktreeError("options '-b', '-B', and '--detach' cannot be used together");
    }
    if (this.detach && this.orphan) {
      throw new WorktreeError("options '--orphan' and '--detach' cannot be used together");
    }
    if (this.orphan && !this.checkout) {
      throw new WorktreeError("options '--orphan' and '--no-checkout' cannot be used together");
    }
    if (this.orphan && this.commitish !== undefined) {
      throw new WorktreeError("option '--orphan' and commit-ish cannot be used together");
    }
    if (this.lockReason !== undefined && !this.lock) {
      throw new WorktreeError("the option '--reason' requires '--lock'");
    }
    const keepLocked = this.lockReason ?? (this.lock ? "added with --lock" : undefined);

    let branch = this.commitish ?? "HEAD";
    let newBranch = this.newBranch;
    let orphan = this.orphan;
    const messages: string[] = [];
    const output: string[] = [];
    const basename = path.replace(/\/+$/, "").split("/").pop() ?? "";

    if (this.forceNewBranch && newBranch !== undefined && this.force === 0) {
      const ref = `refs/heads/${newBranch}`;
      if (isValidBranchName(newBranch) && (await this.refsStore.has(ref))) {
        await refuseIfCheckedOut(worktrees, ref, false);
      }
    }

    if (orphan && newBranch === undefined) {
      newBranch = basename;
    } else if (orphan || this.detach) {
      // nothing to guess
    } else if (this.commitish === undefined && newBranch !== undefined) {
      orphan = await this.dwimOrphan();
    } else if (this.commitish === undefined) {
      // DWIM: the branch named after the path, checked out if it exists, else created
      if (isValidBranchName(basename) && (await this.refsStore.has(`refs/heads/${basename}`))) {
        branch = basename;
      } else {
        newBranch = basename;
        orphan = await this.dwimOrphan();
      }
    }

    const commitId = await this.commitOf(branch);
    if (!orphan && commitId === undefined) throw new WorktreeError(`invalid reference: ${branch}`);

    if (!this.quiet) messages.push(await this.preparingLine(branch, newBranch));

    if (orphan) {
      branch = newBranch ?? basename;
    } else if (newBranch !== undefined && commitId !== undefined) {
      await this.createBranch(worktrees, newBranch, branch, commitId);
      branch = newBranch;
    }

    return this.addWorktree(worktrees, path, branch, orphan, keepLocked, messages, output);
  }

  /** git's `dwim_orphan` without remotes: no valid HEAD and no branch at all infers `--orphan`. */
  private async dwimOrphan(): Promise<boolean> {
    if ((await this.refsStore.resolve("HEAD"))?.objectId) return false;
    for await (const ref of this.refsStore.list("refs/heads/")) {
      if ("objectId" in ref && ref.objectId) return false;
    }
    if (!this.checkout) {
      throw new WorktreeError("options '--orphan' and '--no-checkout' cannot be used together");
    }
    return true;
  }

  /** The commit `name` names (`lookup_commit_reference_by_name`), else undefined. */
  private async commitOf(name: string): Promise<ObjectId | undefined> {
    try {
      const id = await this.resolveRef(name);
      return (await this.commits.has(id)) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private async abbrev(id: ObjectId): Promise<string> {
    const lengths = await abbrevLengths(this.workingCopy, [id]);
    return id.slice(0, lengths.get(id) ?? 7);
  }

  /** git's `print_preparing_worktree_line`. */
  private async preparingLine(branch: string, newBranch: string | undefined): Promise<string> {
    if (this.forceNewBranch && newBranch !== undefined) {
      const existing = await this.commitOf(newBranch);
      return existing === undefined
        ? `Preparing worktree (new branch '${newBranch}')`
        : `Preparing worktree (resetting branch '${newBranch}'; was at ${await this.abbrev(existing)})`;
    }
    if (newBranch !== undefined) return `Preparing worktree (new branch '${newBranch}')`;
    if (!this.detach && (await this.isBranch(branch))) {
      return `Preparing worktree (checking out '${branch}')`;
    }
    const id = (await this.commitOf(branch)) as ObjectId;
    return `Preparing worktree (detached HEAD ${await this.abbrev(id)})`;
  }

  private async isBranch(name: string): Promise<boolean> {
    return isValidBranchName(name) && (await this.refsStore.has(`refs/heads/${name}`));
  }

  /** The identity set, else git's committer ident (environment, configuration). */
  private ident(): string | undefined {
    return this.reflogLine("", this.who).ident;
  }

  /** `git branch [--force] <new> <start>`, with git's reflog line. */
  private async createBranch(
    worktrees: LinkedWorktrees,
    name: string,
    start: string,
    commitId: ObjectId,
  ): Promise<void> {
    if (!isValidBranchName(name)) throw new WorktreeError(`'${name}' is not a valid branch name`);
    const ref = `refs/heads/${name}`;
    const exists = await this.refsStore.has(ref);
    if (exists && !this.forceNewBranch) {
      throw new WorktreeError(`a branch named '${name}' already exists`);
    }
    if (exists) {
      // git branch --force refuses a branch some worktree has checked out, whatever -f says
      const user = await worktreeUsingBranch(worktrees, ref);
      if (user) {
        throw new WorktreeError(
          `cannot force update the branch '${name}' used by worktree at '${user.path}'`,
        );
      }
    }
    const message = exists ? `branch: Reset to ${start}` : `branch: Created from ${start}`;
    const result = await this.refsStore.batch([{ name: ref, new: commitId, noDeref: true }], {
      message,
      ...(this.ident() ? { ident: this.ident() } : {}),
    });
    if (!result.ok) throw new WorktreeError(`cannot create branch '${name}'`);
  }

  /** git's `add_worktree`. */
  private async addWorktree(
    worktrees: LinkedWorktrees,
    path: string,
    branch: string,
    orphan: boolean,
    keepLocked: string | undefined,
    messages: string[],
    output: string[],
  ): Promise<WorktreeAddResult> {
    await checkCandidatePath(worktrees, path, this.force, "add");

    const ref = `refs/heads/${branch}`;
    const isBranch = !this.detach && (await this.isBranch(branch));
    if (isBranch && this.force === 0) await refuseIfCheckedOut(worktrees, ref, false);
    const commitId = await this.commitOf(branch);
    if (commitId === undefined && !orphan) throw new WorktreeError(`invalid reference: ${branch}`);
    if (orphan) {
      if (!isValidBranchName(branch))
        throw new WorktreeError(`'${branch}' is not a valid branch name`);
      if (await this.refsStore.has(ref)) {
        throw new WorktreeError(`a branch named '${branch}' already exists`);
      }
    }

    const head: NewWorktreeHead =
      !isBranch && !orphan && commitId !== undefined ? { id: commitId } : { ref };
    let created: CreatedLinkedWorktree;
    try {
      created = await worktrees.create({
        path,
        head,
        ...(keepLocked !== undefined ? { lockReason: keepLocked } : {}),
        ...(this.ident() ? { ident: this.ident() } : {}),
      });
    } catch (error) {
      throw error instanceof WorktreeError
        ? error
        : new WorktreeError(error instanceof Error ? error.message : String(error));
    }

    const entry = (await worktrees.list()).find((wt) => wt.id === created.id);
    if (!entry) {
      await worktrees.discardCreate(created, path);
      throw new WorktreeError(`could not find created worktree '${created.id}'`);
    }
    let workingCopy: WorkingCopy;
    try {
      workingCopy = await worktrees.open(entry);
      if (this.checkout) await this.checkoutWorktree(workingCopy, orphan, output);
    } catch (error) {
      await worktrees.discardCreate(created, path);
      throw error;
    }
    await worktrees.finishCreate(created.id, keepLocked !== undefined);
    return {
      path: entry.path,
      id: created.id,
      ...("ref" in head ? { branch: head.ref } : {}),
      ...(commitId !== undefined && !orphan ? { head: commitId } : {}),
      messages,
      output,
      workingCopy,
    };
  }

  /** git's `reset --hard --no-recurse-submodules` in the new worktree. */
  private async checkoutWorktree(
    workingCopy: WorkingCopy,
    orphan: boolean,
    output: string[],
  ): Promise<void> {
    const refs = workingCopy.history.refs;
    const staging = workingCopy.checkout.staging;
    const headId = orphan ? undefined : (await refs.resolve("HEAD"))?.objectId;
    const commit = headId ? await workingCopy.history.commits.load(headId) : undefined;
    if (!commit || !headId) {
      // an unborn branch: the index is the empty tree
      await staging.clear();
      await staging.write();
      return;
    }
    const worktree = workingCopy.worktree;
    await checkoutFreshTree(
      {
        // the new worktree's history shares the repository's objects
        trees: this.trees,
        blobs: workingCopy.history.blobs,
        staging,
        worktree,
        symlinks: worktreeModeTrust(workingCopy, worktree).symlinks,
        ignoreCase: coreBool(workingCopy, "ignorecase", false),
      },
      commit.tree,
      "worktree add",
    );
    // reset_refs: ORIG_HEAD, and HEAD moved to where it is (logged through a branch)
    await refs.set("ORIG_HEAD", headId);
    const head = await refs.get("HEAD");
    if (head && isSymbolicRef(head)) {
      const ident = this.ident();
      await refs.batch([{ name: "HEAD", new: headId }], {
        message: "reset: moving to HEAD",
        ...(ident ? { ident } : {}),
      });
    }
    if (!this.quiet) {
      // the subject as pretty=oneline gives it: the first paragraph on one line
      const subject = commit.message
        .trim()
        .split(/\n\s*\n/)[0]
        .replace(/\s*\n\s*/g, " ");
      output.push(`HEAD is now at ${await this.abbrev(headId)} ${subject}`);
    }
  }
}
