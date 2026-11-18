/**
 * SwitchCommand - `git switch`: switch to a branch, create one, detach HEAD, or start an
 * orphan branch. The checks and messages are `git switch`'s (`builtin/checkout.c`,
 * checked against git 2.43 and 2.56); the switch itself is {@link CheckoutCommand}'s.
 *
 * @example
 * ```typescript
 * await git.switch().setName("feature").call();                  // git switch feature
 * await git.switch().setName("-").call();                        // git switch -
 * await git.switch().setCreateBranch("topic").setName("origin/topic").call(); // -c, tracks it
 * await git.switch().setDetach(true).setName("v1.0").call();     // git switch --detach v1.0
 * await git.switch().setOrphan("pages").call();                  // git switch --orphan pages
 * await git.switch().setName("v1.0").call();
 * // throws SwitchRefusedError: "fatal: a branch is expected, got tag 'v1.0'\nhint: ..."
 * ```
 */

import { isValidBranchName } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";

import {
  BranchUsedByWorktreeError,
  InvalidRefNameError,
  NotACommitError,
  RevisionError,
  SwitchRefusedError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { endOfSymbolicChain, guessRemoteBranch, TrackMode } from "./branch-tracking.js";
import { CheckoutCommand, type CheckoutResult, nonCommitSwitchError } from "./checkout-command.js";
import { OperationState } from "./merge-support.js";

/** git's hint after `a branch is expected` (advice.suggestDetachingHead). */
const DETACH_HINT =
  "hint: If you want to detach HEAD at the commit, try again with the --detach option.";

/**
 * Switch branches, as `git switch` does.
 *
 * - `setName(<branch>)`: switch to a local branch; `-` (and `@{-N}`) is the branch left
 *   before. A name no branch has but one remote-tracking branch has creates the local
 *   branch from it, tracking it (`--guess`, see {@link setGuess}). Anything else that names
 *   a commit (a tag, a remote-tracking branch, `HEAD~1`) is refused without `setDetach`.
 * - `setCreateBranch(<new>)` / `setForceCreateBranch(<new>)` (`-c` / `-C`), with
 *   `setName(<start-point>)` (default HEAD).
 * - `setDetach(true)` with `setName(<commit>)` (default HEAD).
 * - `setOrphan(<new>)`: an unborn branch with an empty index and worktree.
 *
 * Refused while a merge, rebase, cherry-pick or revert is in progress (`fatal: cannot
 * switch branch while merging ...`). `setMerge(true)` (`-m`) carries local changes over.
 */
export class SwitchCommand extends GitCommand<CheckoutResult> {
  private name?: string;
  private newBranch?: string;
  private forceCreate = false;
  private orphan?: string;
  private detach = false;
  private guess?: boolean;
  private track = TrackMode.DEFAULT;
  private discardChanges = false;
  private force = false;
  private ignoreOtherWorktrees = false;
  private merge = false;

  /**
   * The branch to switch to; with `-c`/`-C` the start point, with `--detach` the commit.
   *
   * @param name A branch, `-`, `@{-N}`, or a commit-ish
   */
  setName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /** The start point of a branch `-c`/`-C` creates (the same as {@link setName}). */
  setStartPoint(start: string): this {
    return this.setName(start);
  }

  /**
   * Create `name` and switch to it (`-c <new-branch>`); refused when it exists.
   *
   * @param name New branch name
   */
  setCreateBranch(name: string): this {
    this.checkCallable();
    this.newBranch = name;
    this.forceCreate = false;
    return this;
  }

  /**
   * Create `name`, or reset it when it exists, and switch to it (`-C <new-branch>`).
   *
   * @param name Branch name
   */
  setForceCreateBranch(name: string): this {
    this.checkCallable();
    this.newBranch = name;
    this.forceCreate = true;
    return this;
  }

  /**
   * Detach HEAD at the commit named by {@link setName} (`--detach`), HEAD when none.
   */
  setDetach(detach: boolean): this {
    this.checkCallable();
    this.detach = detach;
    return this;
  }

  /**
   * Switch to a new unborn branch `name` (`--orphan`), the tracked files removed.
   */
  setOrphan(name: string): this {
    this.checkCallable();
    this.orphan = name;
    return this;
  }

  /**
   * `--guess` / `--no-guess` (default `checkout.guess`, true): a name no branch has is the
   * one remote-tracking branch of that name (`checkout.defaultRemote` picks among several).
   */
  setGuess(guess: boolean): this {
    this.checkCallable();
    this.guess = guess;
    return this;
  }

  /**
   * `--track` (`TrackMode.DIRECT`), `--track=inherit`, `--no-track` (`TrackMode.NONE`).
   * Any of them without `-c` names the new branch after the remote-tracking branch, as git
   * does (`origin/topic` creates `topic`, untracked with `--no-track`; `main` is refused,
   * `missing branch name; try -c`).
   */
  setTrack(mode: TrackMode): this {
    this.checkCallable();
    this.track = mode;
    return this;
  }

  /**
   * `--discard-changes`: local changes are thrown away, the index and worktree made the
   * target's; untracked files in the way still refuse the switch.
   */
  setDiscardChanges(discard: boolean): this {
    this.checkCallable();
    this.discardChanges = discard;
    return this;
  }

  /**
   * `-f` (`--force`): `--discard-changes`, also overwriting untracked files in the way
   * and ignoring unmerged entries.
   */
  setForced(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * `-m` / `--merge` (git 2.55+): local changes the switch would lose are carried over
   * through an autostash, conflicts labelled `<branch>` and `local`; see
   * `CheckoutCommand.setMerge` for the result. Refused with `-f` (`fatal: '-f' cannot be
   * used with '-m'`) and `--discard-changes`.
   */
  setMerge(merge: boolean): this {
    this.checkCallable();
    this.merge = merge;
    return this;
  }

  /** `--ignore-other-worktrees`: switch to a branch another worktree has checked out. */
  setIgnoreOtherWorktrees(ignore: boolean): this {
    this.checkCallable();
    this.ignoreOtherWorktrees = ignore;
    return this;
  }

  async call(): Promise<CheckoutResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();
    const trackGiven = this.track !== TrackMode.DEFAULT;

    // checkout_main: --track (and --no-track) without -c names the branch after the
    // remote one
    let newBranch = this.newBranch;
    if (trackGiven && newBranch === undefined && !this.orphan) {
      if (this.name === undefined)
        throw new SwitchRefusedError("fatal: --track needs a branch name");
      const rest = this.name.replace(/^refs\//, "").replace(/^remotes\//, "");
      const slash = rest.indexOf("/");
      if (slash < 0 || slash === rest.length - 1) {
        throw new SwitchRefusedError("fatal: missing branch name; try -c");
      }
      newBranch = rest.slice(slash + 1);
    }

    // the options that do not go together (checkout_main, checkout_branch)
    if (newBranch !== undefined && this.orphan !== undefined) {
      throw new SwitchRefusedError(
        "fatal: options '-c', '-C', and '--orphan' cannot be used together",
      );
    }
    if (this.detach && (newBranch !== undefined || this.orphan !== undefined)) {
      throw new SwitchRefusedError("fatal: '--detach' cannot be used with '-b/-B/--orphan'");
    }
    if (this.orphan !== undefined && trackGiven) {
      throw new SwitchRefusedError("fatal: '--orphan' cannot be used with '-t'");
    }
    if (this.orphan !== undefined && this.name !== undefined) {
      throw new SwitchRefusedError("fatal: '--orphan' cannot take <start-point>");
    }
    if (this.detach && trackGiven) {
      throw new SwitchRefusedError("fatal: '--detach' cannot be used with '-t'");
    }
    if (this.name === undefined && newBranch === undefined && !this.orphan && !this.detach) {
      throw new SwitchRefusedError("fatal: missing branch or commit argument");
    }

    // the new branch (validate_new_branchname / validate_branchname)
    const created = newBranch ?? this.orphan;
    if (created !== undefined) {
      if (!isValidBranchName(created)) {
        throw new InvalidRefNameError(created, `fatal: '${created}' is not a valid branch name`);
      }
      if (!this.forceCreate && (await this.refsStore.has(`refs/heads/${created}`))) {
        throw new SwitchRefusedError(`fatal: a branch named '${created}' already exists`);
      }
    }

    // `<branch>`: a local branch, a name guessed into one, else refused; a start point or
    // the commit to detach at must name a commit. `-` is @{-1}, and @{-N} is expanded once,
    // the switch itself handed the expanded name
    const arg = this.name === "-" ? "@{-1}" : this.name;
    const name =
      arg === undefined
        ? undefined
        : await this.interpretLocalBranch(await this.expandPriorCheckout(arg));
    if (arg !== undefined && name !== undefined) {
      if (created === undefined && !this.detach) {
        await this.checkBranchArgument(arg, name);
      } else if (!(await this.namesCommit(arg, name))) {
        throw new SwitchRefusedError(`fatal: invalid reference: ${arg}`);
      }
    }

    // checkout_branch: the options that do not go with --merge
    if (this.merge && this.force) {
      throw new SwitchRefusedError("fatal: '-f' cannot be used with '-m'");
    }
    if (this.merge && this.discardChanges) {
      throw new SwitchRefusedError("fatal: '--discard-changes' cannot be used with '--merge'");
    }

    await this.refuseInProgress();

    const checkout = new CheckoutCommand(this._workingCopy)
      .setForced(this.force || this.discardChanges)
      .setProtectUntracked(!this.force)
      .setIgnoreOtherWorktrees(this.ignoreOtherWorktrees)
      .setTrack(this.track)
      .setMerge(this.merge);
    if (this.guess !== undefined) checkout.setGuess(this.guess);
    if (this.hasReflogAction()) checkout.setReflogAction(this.reflogAction("checkout"));
    if (this.orphan !== undefined) {
      checkout.setOrphan(true).setOrphanFromEmptyTree(true).setName(this.orphan);
    } else if (newBranch !== undefined) {
      checkout.setForceCreateBranch(this.forceCreate).setCreateBranch(true).setName(newBranch);
      if (name !== undefined) checkout.setStartPoint(name);
    } else {
      if (this.detach) checkout.setDetach(true);
      if (name !== undefined) checkout.setName(name);
    }
    try {
      return await checkout.call();
    } catch (error) {
      // die_if_switching_to_a_branch_in_use: git's fatal line
      if (error instanceof BranchUsedByWorktreeError && !error.message.startsWith("fatal: ")) {
        throw new BranchUsedByWorktreeError(
          error.branchName,
          error.worktreePath,
          `fatal: ${error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * git's `parse_branchname_arg` and `die_expecting_a_branch` for `git switch <name>`: a
   * local branch (also as `-` / `@{-N}`) passes, as does a name `--guess` turns into a new
   * branch; a commit is refused with git's message and hint; anything else is an invalid
   * reference. `arg` is the argument (`-` as @{-1}), `name` it with @{-N} expanded; only
   * the argument itself is guessed into a remote-tracking branch, so `-` naming a deleted
   * branch is an invalid reference.
   */
  private async checkBranchArgument(arg: string, name: string): Promise<void> {
    if (isValidBranchName(name) && (await this.refsStore.has(`refs/heads/${name}`))) return;
    let commit: string | undefined;
    try {
      commit = await this.resolveRef(name);
    } catch (error) {
      // a tree or a blob: git's switch_branches refusal
      if (error instanceof NotACommitError) throw nonCommitSwitchError(arg, error);
      // not a revision; where git dies reading it (`@{u}` without upstream), its message
      if (error instanceof RevisionError) throw error;
    }
    if (commit === undefined) {
      const configured = RemoteConfigStore.from(this.workingCopy).value("checkout.guess");
      const guess = this.guess ?? parseGitBool(configured) ?? true;
      if (guess && isValidBranchName(arg)) {
        if (await guessRemoteBranch(this.workingCopy, this.refsStore, arg)) return;
      }
      throw new SwitchRefusedError(`fatal: invalid reference: ${arg}`);
    }
    throw new SwitchRefusedError(`fatal: ${await this.expectedABranch(name)}\n${DETACH_HINT}`);
  }

  /**
   * Whether `name` (`@{-N}` expanded) is a revision that names a commit; one that names a
   * tree, a blob or a missing object is refused as git's switch_branches refuses it.
   */
  private async namesCommit(arg: string, name: string): Promise<boolean> {
    try {
      await this.resolveRef(name);
      return true;
    } catch (error) {
      if (error instanceof NotACommitError) throw nonCommitSwitchError(arg, error);
      if (error instanceof RevisionError) throw error;
      return false;
    }
  }

  /** git's die_expecting_a_branch: what `name` is, by the ref it dwims to. */
  private async expectedABranch(given: string): Promise<string> {
    // dwim_ref reads the branch syntax first (`@{u}` is the upstream's ref)
    const interpreted = await this.revisionResolver().interpretBranchName(given);
    const name = interpreted?.replace(/^refs\//, "") ?? given;
    const candidates = [
      name,
      `refs/${name}`,
      `refs/tags/${name}`,
      `refs/heads/${name}`,
      `refs/remotes/${name}`,
      `refs/remotes/${name}/HEAD`,
    ];
    for (const candidate of candidates) {
      if (!candidate.startsWith("refs/") && !/^[A-Z_]+$/.test(candidate)) continue;
      // dwim_ref names the ref a symbolic one ends at (`origin` is origin's HEAD's branch)
      const ref = await endOfSymbolicChain(this.refsStore, candidate);
      if (ref === undefined) continue;
      if (ref.startsWith("refs/tags/")) {
        return `a branch is expected, got tag '${ref.slice("refs/tags/".length)}'`;
      }
      if (ref.startsWith("refs/remotes/")) {
        return `a branch is expected, got remote branch '${ref.slice("refs/remotes/".length)}'`;
      }
      return `a branch is expected, got '${ref}'`;
    }
    return `a branch is expected, got commit '${given}'`;
  }

  /** git's die_if_some_operation_in_progress (switch only). */
  private async refuseInProgress(): Promise<void> {
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const refuse = (doing: string, command: string) => {
      throw new SwitchRefusedError(
        `fatal: cannot switch branch ${doing}\nConsider "git ${command} --quit" or "git worktree add".`,
      );
    };
    if (await state.ref("MERGE_HEAD")) refuse("while merging", "merge");
    if ((await state.exists("rebase-merge")) || (await state.exists("rebase-apply"))) {
      refuse("while rebasing", "rebase");
    }
    if (await state.ref("CHERRY_PICK_HEAD")) refuse("while cherry-picking", "cherry-pick");
    if (await state.ref("REVERT_HEAD")) refuse("while reverting", "revert");
  }
}
