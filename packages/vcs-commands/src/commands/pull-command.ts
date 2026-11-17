import { parseGitBool } from "@statewalker/vcs-utils";

import { NoHeadError } from "../errors/index.js";
import { FastForwardMode, isMergeSuccessful, type MergeStrategy } from "../results/merge-result.js";
import type { PullResult } from "../results/pull-result.js";
import { isRebaseSuccessful, RebaseStatus } from "../results/rebase-result.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand, type TagOption } from "./fetch-command.js";
import { MergeBaseGraph } from "./merge-bases.js";
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
 * // Pull with rebase (`git pull --rebase`; without the option, pull.rebase decides)
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
  /** `--rebase` / `--no-rebase`; undefined: branch.<name>.rebase, then pull.rebase */
  private rebase?: boolean;
  /** `--autostash` / `--no-autostash`; undefined: pull.autoStash, then rebase.autoStash */
  private autoStash?: boolean;
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
   * Set whether to use rebase instead of merge (`--rebase` / `--no-rebase`). Without it the
   * configuration decides, as in git: `branch.<name>.rebase`, else `pull.rebase`, else merge.
   * Only this option puts `--rebase` in the reflog lines (git's are the command line's).
   *
   * @param rebase Whether to use rebase
   */
  setRebase(rebase: boolean): this {
    this.checkCallable();
    this.rebase = rebase;
    return this;
  }

  /**
   * Whether rebase mode was requested with {@link setRebase} (the configuration aside).
   */
  isRebase(): boolean {
    return this.rebase ?? false;
  }

  /**
   * Stash local changes away and apply them again after the pull (`--autostash` /
   * `--no-autostash`). Default `pull.autoStash`, then for a rebase `rebase.autoStash` (a
   * merge reads `merge.autoStash` itself). A rebasing pull without it refuses a dirty tree
   * before fetching, as git's `require_clean_work_tree("pull with rebase")`.
   */
  setAutoStash(autoStash: boolean): this {
    this.checkCallable();
    this.autoStash = autoStash;
    return this;
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

    // git's GIT_REFLOG_ACTION for everything the pull writes: "pull" and its command-line
    // arguments (a rebase or autostash the configuration asks for is not among them)
    const action = this.reflogAction(
      [
        "pull",
        ...(this.rebase === true ? ["--rebase"] : this.rebase === false ? ["--no-rebase"] : []),
        ...(this.autoStash === true
          ? ["--autostash"]
          : this.autoStash === false
            ? ["--no-autostash"]
            : []),
        ...(this.remoteGiven || this.remoteBranchName ? [this.remote] : []),
        ...(this.remoteBranchName ? [this.remoteBranchName] : []),
      ].join(" "),
    );

    // git's pull.c: the option, else the configuration
    const rebase = this.rebase ?? this.configRebase(localBranchName);
    const pullAutoStash = this.autoStash ?? parseGitBool(this.config("pull.autoStash"));
    const autoStash = rebase
      ? (pullAutoStash ?? parseGitBool(this.config("rebase.autoStash")) ?? false)
      : pullAutoStash;
    if (rebase && !autoStash) {
      // require_clean_work_tree("pull with rebase"), before anything is fetched
      const refusal = await new RebaseCommand(this._workingCopy).checkCleanWorkTree(
        "pull with rebase",
      );
      if (refusal) {
        return {
          rebaseResult: refusal,
          successful: false,
          rebaseUsed: true,
          fetchedFrom: this.remote,
        };
      }
    }

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
    // (one that only fast-forwards is a `merge --ff-only --autostash`, as git's pull runs it)
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    const canFastForward =
      rebase &&
      headId !== undefined &&
      (await this.canFastForward(headId, trackingRefResolved.objectId));
    if (rebase && !canFastForward) {
      const rebaseResult = await new RebaseCommand(this._workingCopy)
        .setUpstream(trackingRefResolved.objectId)
        .setReflogAction(action)
        .setAutoStash(autoStash === true)
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
    // run_merge passes --autostash / --no-autostash only when pull has one to give
    if (autoStash !== undefined) mergeCommand.setAutoStash(autoStash);

    if (this.strategy) {
      mergeCommand.setStrategy(this.strategy);
    }
    if (this.fastForwardMode && !canFastForward) {
      mergeCommand.setFastForwardMode(this.fastForwardMode);
    }

    const mergeResult = await mergeCommand.call();
    const successful = isMergeSuccessful(mergeResult.status);

    if (canFastForward) {
      // a rebasing pull still reports a rebase: the fast-forward it made instead
      return {
        fetchResult,
        mergeResult,
        rebaseResult: successful
          ? { status: RebaseStatus.FAST_FORWARD, newHead: mergeResult.newHead }
          : { status: RebaseStatus.FAILED, message: mergeResult.message },
        successful,
        rebaseUsed: true,
        fetchedFrom: this.remote,
      };
    }
    return {
      fetchResult,
      mergeResult,
      successful,
      rebaseUsed: false,
      fetchedFrom: this.remote,
    };
  }

  private config(key: string): string | undefined {
    return configValue(this._workingCopy, key);
  }

  /**
   * git's config_get_rebase: `branch.<name>.rebase`, else `pull.rebase`; any value other
   * than false (`true`, `merges`, `interactive`) rebases.
   */
  private configRebase(branch: string): boolean {
    for (const key of [`branch.${branch}.rebase`, "pull.rebase"]) {
      const value = this.config(key);
      if (value === undefined) continue;
      return parseGitBool(value) ?? true;
    }
    return false;
  }

  /**
   * git's get_can_ff: whether `head` is a merge base of itself and `upstream` (an ancestor
   * of it), by git's date-ordered paint walk, which stops once the sides meet.
   */
  private async canFastForward(head: string, upstream: string): Promise<boolean> {
    if (head === upstream) return true;
    const graph = new MergeBaseGraph({
      load: async (id) => {
        const commit = await this.commits.load(id).catch(() => undefined);
        return commit ? { parents: commit.parents, date: commit.committer.timestamp } : undefined;
      },
      tree: async () => new Map(),
    });
    const bases = await graph.mergeBases(graph.commit(head), graph.commit(upstream));
    return bases.some((b) => b.id === head);
  }
}
