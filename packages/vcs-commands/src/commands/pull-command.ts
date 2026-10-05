import { NoHeadError, NotImplementedError } from "../errors/index.js";
import {
  type FastForwardMode,
  isMergeSuccessful,
  type MergeStrategy,
} from "../results/merge-result.js";
import type { PullResult } from "../results/pull-result.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand, type TagOption } from "./fetch-command.js";
import { MergeCommand } from "./merge-command.js";

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

    // Execute fetch
    const fetchCommand = new FetchCommand(this._workingCopy);
    fetchCommand.setRemote(this.remote);
    fetchCommand.setRefSpecs(refspec);

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

    // Check if rebase was requested
    if (this.rebase) {
      // Rebase is not yet implemented
      throw new NotImplementedError("Pull with rebase");
    }

    // Execute merge
    const mergeCommand = new MergeCommand(this._workingCopy);
    mergeCommand.include(trackingRefResolved.objectId);

    if (this.strategy) {
      mergeCommand.setStrategy(this.strategy);
    }
    if (this.fastForwardMode) {
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
}
