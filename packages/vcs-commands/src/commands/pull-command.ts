import type { ObjectId } from "@statewalker/vcs-core";

import { NoHeadError } from "../errors/index.js";
import { FastForwardMode, isMergeSuccessful, type MergeStrategy } from "../results/merge-result.js";
import type { PullResult } from "../results/pull-result.js";
import { isRebaseSuccessful } from "../results/rebase-result.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand, type TagOption } from "./fetch-command.js";
import { MergeCommand } from "./merge-command.js";
import { configValue } from "./merge-config.js";
import { RebaseCommand } from "./rebase-command.js";

/**
 * Pull changes from a remote repository.
 *
 * Equivalent to `git pull` (fetch + merge).
 *
 * Based on JGit's PullCommand.
 *
 * @example
 * ```typescript
 * // Pull from default remote/branch
 * const result = await git.pull().call();
 *
 * // Pull from specific remote
 * const result = await git.pull()
 *   .setRemote("upstream")
 *   .call();
 *
 * // Pull specific branch
 * const result = await git.pull()
 *   .setRemoteBranchName("develop")
 *   .call();
 *
 * // Pull with rebase (not yet implemented)
 * const result = await git.pull()
 *   .setRebase(true)
 *   .call();
 * ```
 */
export class PullCommand extends TransportCommand<PullResult> {
  private remote = "origin";
  /** Whether the remote was named (it is then in the reflog action). */
  private remoteGiven = false;
  private remoteBranchName?: string;
  private rebase = false;
  private strategy?: MergeStrategy;
  private fastForwardMode?: FastForwardMode;
  private tagOption?: TagOption;

  /**
   * Set the remote to pull from.
   *
   * Default is "origin".
   *
   * @param remote Remote name
   */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    this.remoteGiven = true;
    return this;
  }

  /**
   * Get the remote being pulled from.
   */
  getRemote(): string {
    return this.remote;
  }

  /**
   * Set the remote branch to pull.
   *
   * If not set, uses the tracking branch for the current local branch.
   *
   * @param branch Remote branch name
   */
  setRemoteBranchName(branch: string): this {
    this.checkCallable();
    this.remoteBranchName = branch;
    return this;
  }

  /**
   * Get the remote branch name.
   */
  getRemoteBranchName(): string | undefined {
    return this.remoteBranchName;
  }

  /**
   * Set whether to use rebase instead of merge.
   *
   * Note: Rebase is not yet implemented.
   *
   * @param rebase Whether to use rebase
   */
  setRebase(rebase: boolean): this {
    this.checkCallable();
    this.rebase = rebase;
    return this;
  }

  /**
   * Whether rebase mode is enabled.
   */
  isRebase(): boolean {
    return this.rebase;
  }

  /**
   * Set the merge strategy.
   *
   * @param strategy Merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Set the fast-forward mode.
   *
   * @param mode Fast-forward mode
   */
  setFastForwardMode(mode: FastForwardMode): this {
    this.checkCallable();
    this.fastForwardMode = mode;
    return this;
  }

  /**
   * Get the fast-forward mode.
   */
  getFastForwardMode(): FastForwardMode | undefined {
    return this.fastForwardMode;
  }

  /**
   * Set the specification of annotated tag behavior during fetch.
   *
   * @param tagOption Tag option
   */
  setTagOpt(tagOption: TagOption): this {
    this.checkCallable();
    this.tagOption = tagOption;
    return this;
  }

  /**
   * Get the tag option.
   */
  getTagOpt(): TagOption | undefined {
    return this.tagOption;
  }

  /**
   * Execute the pull operation.
   *
   * @returns Pull result with fetch and merge results
   * @throws NoHeadError if HEAD is not set
   * @throws InvalidRemoteError if remote cannot be resolved
   */
  async call(): Promise<PullResult> {
    this.checkCallable();
    this.setCallable(false);

    // Get current branch
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch) {
      throw new NoHeadError("Cannot pull with detached HEAD");
    }

    // Extract branch name from full ref
    const localBranchName = currentBranch.replace("refs/heads/", "");

    // Determine remote branch
    const remoteBranch = this.remoteBranchName || localBranchName;

    // Build refspec
    const refspec = `refs/heads/${remoteBranch}:refs/remotes/${this.remote}/${remoteBranch}`;

    // git's GIT_REFLOG_ACTION for everything the pull writes: "pull" and its arguments
    const action = this.reflogAction(
      [
        "pull",
        ...(this.rebase ? ["--rebase"] : []),
        ...(this.remoteGiven || this.remoteBranchName ? [this.remote] : []),
        ...(this.remoteBranchName ? [this.remoteBranchName] : []),
      ].join(" "),
    );

    // Execute fetch
    const fetchCommand = new FetchCommand(this._workingCopy);
    fetchCommand.setRemote(this.remote);
    fetchCommand.setRefSpecs(refspec);
    fetchCommand.setReflogAction(action);

    if (this.credentials) {
      fetchCommand.setCredentials(this.credentials);
    }
    if (this.headers) {
      fetchCommand.setHeaders(this.headers);
    }
    if (this.timeout) {
      fetchCommand.setTimeout(this.timeout);
    }
    if (this.progressCallback) {
      fetchCommand.setProgressMonitor(this.progressCallback);
    }
    if (this.progressMessageCallback) {
      fetchCommand.setProgressMessageCallback(this.progressMessageCallback);
    }
    if (this.tagOption) {
      fetchCommand.setTagOpt(this.tagOption);
    }

    const fetchResult = await fetchCommand.call();

    // If repository is empty or nothing fetched, we're done
    if (fetchResult.isEmpty || fetchResult.trackingRefUpdates.length === 0) {
      return {
        fetchResult,
        successful: true,
        rebaseUsed: false,
        fetchedFrom: this.remote,
      };
    }

    // Get the remote tracking ref to merge
    const trackingRef = `refs/remotes/${this.remote}/${remoteBranch}`;
    const trackingRefResolved = await this.refsStore.resolve(trackingRef);

    if (!trackingRefResolved?.objectId) {
      // Nothing to merge
      return {
        fetchResult,
        successful: true,
        rebaseUsed: false,
        fetchedFrom: this.remote,
      };
    }

    // `git pull --rebase`: the branch rebased onto what was fetched
    // (one that only fast-forwards is a `merge --ff-only`, as git's pull runs it)
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    const canFastForward =
      this.rebase &&
      headId !== undefined &&
      (await this.reaches(trackingRefResolved.objectId, headId));
    if (this.rebase && !canFastForward) {
      const rebaseResult = await new RebaseCommand(this._workingCopy)
        .setUpstream(trackingRefResolved.objectId)
        .setReflogAction(action)
        .call();
      return {
        fetchResult,
        rebaseResult,
        successful: isRebaseSuccessful(rebaseResult.status),
        rebaseUsed: true,
        fetchedFrom: this.remote,
      };
    }

    // Execute merge (git's message for a pull: `Merge branch 'x' of <url>`)
    const mergeCommand = new MergeCommand(this._workingCopy);
    mergeCommand.include(trackingRefResolved.objectId);
    // git's fmt-merge-msg shortens the URL: no trailing slash, no `.git`
    const url = (configValue(this._workingCopy, `remote.${this.remote}.url`) ?? this.remote)
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    const into =
      localBranchName === "main" || localBranchName === "master" ? "" : ` into ${localBranchName}`;
    mergeCommand.setMessage(`Merge branch '${remoteBranch}' of ${url}${into}\n`);
    mergeCommand.setReflogAction(action);
    if (canFastForward) mergeCommand.setFastForwardMode(FastForwardMode.FF_ONLY);

    if (this.strategy) {
      mergeCommand.setStrategy(this.strategy);
    }
    if (this.fastForwardMode && !canFastForward) {
      mergeCommand.setFastForwardMode(this.fastForwardMode);
    }

    const mergeResult = await mergeCommand.call();

    return {
      fetchResult,
      mergeResult,
      successful: isMergeSuccessful(mergeResult.status),
      rebaseUsed: false,
      fetchedFrom: this.remote,
    };
  }

  /** Whether `tip` reaches `id` through its parents (or is it). */
  private async reaches(tip: ObjectId, id: ObjectId): Promise<boolean> {
    const seen = new Set<ObjectId>();
    const queue = [tip];
    while (queue.length > 0) {
      const next = queue.pop() as ObjectId;
      if (next === id) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const commit = await this.commits.load(next).catch(() => undefined);
      if (commit) queue.push(...commit.parents);
    }
    return false;
  }
}
