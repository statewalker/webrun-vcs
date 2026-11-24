/**
 * `git branch --set-upstream-to` and `git branch --unset-upstream` (builtin/branch.c): the
 * `branch.<name>.remote` / `.merge` configuration of an existing branch.
 */

import { parseGitBool } from "@statewalker/vcs-utils";

import { GitApiError, RefNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  disableHint,
  installTracking,
  planTracking,
  TrackMode,
  trackableStart,
  upstreamMissingError,
} from "./branch-tracking.js";
import { worktreeUsingBranch } from "./worktree-support.js";

/**
 * The branch a set/unset-upstream names (cmd_branch's `branch_get`): the one checked out
 * when none is given or it is `HEAD`, else the name as `copy_branchname` interprets it.
 */
abstract class BranchUpstreamBase<T> extends GitCommand<T> {
  protected branch?: string;

  /**
   * The branch to change (default: the one checked out). `HEAD` names the current branch,
   * `@{-1}` the previous one.
   */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /**
   * The branch's short name, or undefined on a detached HEAD (git's `branch_get(NULL)`).
   */
  protected async branchName(): Promise<string | undefined> {
    if (this.branch === undefined || this.branch === "HEAD") {
      const current = await this.getCurrentBranch();
      return current?.startsWith("refs/heads/") ? current.slice("refs/heads/".length) : undefined;
    }
    return this.interpretLocalBranch(await this.expandPriorCheckout(this.branch));
  }

  /** git's `branch_checked_out`: whether some worktree (this one at least) has it. */
  protected async checkedOut(name: string): Promise<boolean> {
    const ref = `refs/heads/${name}`;
    const worktrees = this.workingCopy.worktrees;
    if (worktrees) return (await worktreeUsingBranch(worktrees, ref)) !== undefined;
    return (await this.getCurrentBranch()) === ref;
  }
}

/**
 * Set the upstream of a branch.
 *
 * Equivalent to `git branch --set-upstream-to=<upstream> [<branch>]`: the upstream must be a
 * branch (a remote-tracking branch some remote fetches into, or a local branch, tracked with
 * `remote = .`); `branch.autoSetupRebase` adds `branch.<name>.rebase = true`. git's message
 * (`branch 'main' set up to track 'origin/main'.`) is in {@link getOutput}, its warning for a
 * branch set as its own upstream in {@link getWarnings}.
 *
 * @example
 * ```typescript
 * const command = git.branchSetUpstream().setUpstream("origin/main");
 * await command.call();
 * command.getOutput(); // ["branch 'main' set up to track 'origin/main'."]
 * ```
 */
export class SetUpstreamBranchCommand extends BranchUpstreamBase<void> {
  private upstream?: string;
  private quiet = false;
  private readonly output: string[] = [];
  private readonly warnings: string[] = [];

  /** The upstream: a branch name (`origin/main`, `main`, `refs/remotes/origin/main`). */
  setUpstream(upstream: string): this {
    this.checkCallable();
    this.upstream = upstream;
    return this;
  }

  /** git's `-q`: no "set up to track" message. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** What git printed on stdout, line by line. Read after {@link call}. */
  getOutput(): string[] {
    return [...this.output];
  }

  /** What git printed on stderr (its warnings), line by line. Read after {@link call}. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * @throws GitApiError with git's `fatal:` lines: a detached HEAD, a branch that does not
   *   exist, an upstream that names nothing or no branch, ambiguous remotes
   */
  async call(): Promise<void> {
    this.checkCallable();
    const upstream = this.upstream;
    if (upstream === undefined) {
      throw new GitApiError("fatal: an upstream is required");
    }
    const compatibility = this.hooks.compatibility;
    const name = await this.branchName();
    if (name === undefined) {
      throw new GitApiError(
        `fatal: could not set upstream of HEAD to ${upstream} when it does not point to any branch`,
      );
    }
    const refName = `refs/heads/${name}`;
    if (!(await this.refsStore.has(refName))) {
      const given = this.branch !== undefined && this.branch !== "HEAD";
      if (!given || (await this.checkedOut(name))) {
        throw new RefNotFoundError(refName, `fatal: no commit on branch '${name}' yet`);
      }
      if (compatibility !== "2.43") await this.refuseRemoteSlip(upstream, name);
      throw new RefNotFoundError(refName, `fatal: branch '${name}' does not exist`);
    }

    // dwim_and_setup_tracking with BRANCH_TRACK_OVERRIDE
    const objectId = await this.revisionResolver()
      .resolve(upstream)
      .catch((error) => {
        if (error instanceof RefNotFoundError) return undefined;
        throw error;
      });
    if (objectId === undefined) {
      throw upstreamMissingError(this.workingCopy, upstream, compatibility);
    }
    const startRef = await trackableStart(
      this.workingCopy,
      this.refsStore,
      upstream,
      TrackMode.DIRECT,
    );
    await this.resolveRef(upstream, (n) => `fatal: not a valid branch point: '${n}'`);
    this.setCallable(false);
    if (startRef === undefined) return;
    const { plan, warnings } = planTracking(this.workingCopy, name, startRef, TrackMode.DIRECT, {
      compatibility,
    });
    this.warnings.push(...warnings);
    if (plan) {
      const lines = await installTracking(this.workingCopy, name, plan);
      if (!this.quiet) this.output.push(...lines);
    }
  }

  /**
   * git 2.5x's `die_if_upstream_looks_like_remote`: `--set-upstream-to origin topic` meant
   * `origin/topic` when `origin` is a remote and `refs/remotes/origin/topic` exists.
   */
  private async refuseRemoteSlip(upstream: string, name: string): Promise<void> {
    const config = RemoteConfigStore.from(this.workingCopy);
    const advice = config.value("advice.setUpstreamFailure");
    if (advice !== undefined && !(parseGitBool(advice) ?? true)) return;
    if (this.branch === undefined) return;
    if (upstream.includes("/") || !config.isConfigured(upstream)) return;
    if (!(await this.refsStore.has(`refs/remotes/${upstream}/${name}`))) return;
    throw new GitApiError(
      [
        "fatal: --set-upstream-to takes a single <remote>/<branch> argument",
        `hint: Did you mean to use: git branch --set-upstream-to=${upstream}/${name}?`,
        disableHint("setUpstreamFailure"),
      ].join("\n"),
    );
  }
}

/**
 * Remove the upstream of a branch.
 *
 * Equivalent to `git branch --unset-upstream [<branch>]`: `branch.<name>.remote` and
 * `branch.<name>.merge` are removed (`.rebase` stays, as git leaves it); a branch without
 * both is refused (`fatal: branch '<b>' has no upstream information`).
 *
 * @example
 * ```typescript
 * await git.branchUnsetUpstream().setBranch("topic").call();
 * ```
 */
export class UnsetUpstreamBranchCommand extends BranchUpstreamBase<void> {
  /**
   * @throws GitApiError with git's `fatal:` line: a detached HEAD, no upstream configured
   */
  async call(): Promise<void> {
    this.checkCallable();
    const name = await this.branchName();
    if (name === undefined) {
      throw new GitApiError(
        "fatal: could not unset upstream of HEAD when it does not point to any branch",
      );
    }
    const config = RemoteConfigStore.from(this.workingCopy);
    // branch_has_merge_config: a remote and at least one merge
    if (
      !config.value(`branch.${name}.remote`) ||
      config.values(`branch.${name}.merge`).length === 0
    ) {
      throw new GitApiError(`fatal: branch '${name}' has no upstream information`);
    }
    config.unset(`branch.${name}.remote`);
    config.unset(`branch.${name}.merge`);
    await config.save();
    this.setCallable(false);
  }
}
