import type { FilesApi, ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { type Checkout, isIndexUnborn } from "@statewalker/vcs-working-tree";

import { GitApiError, NoHeadError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { FastForwardMode, isMergeSuccessful, type MergeStrategy } from "../results/merge-result.js";
import type { PullResult } from "../results/pull-result.js";
import { isRebaseSuccessful, RebaseStatus } from "../results/rebase-result.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand, TagOption } from "./fetch-command.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
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
  private repositoryFiles?: { files: FilesApi; gitDir?: string };

  /**
   * The files of the repository, for the fetch to write the commit-graph
   * `fetch.writeCommitGraph` asks for (see `FetchCommand.setRepositoryFiles`).
   */
  setRepositoryFiles(repository: { files: FilesApi; gitDir?: string }): this {
    this.checkCallable();
    this.repositoryFiles = repository;
    return this;
  }

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
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    // Get current branch
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch) {
      throw new NoHeadError("Cannot pull with detached HEAD");
    }

    // Extract branch name from full ref
    const localBranchName = currentBranch.replace("refs/heads/", "");

    // Determine remote branch
    const remoteBranch = this.remoteBranchName || localBranchName;

    // a remote read from .git/remotes/ or .git/branches/ (git 2.x) is pulled as pull.c does:
    // `git fetch <remote> [<branch>]` with the remote's own refspecs, then the FETCH_HEAD
    // entries marked for merge
    await this.loadLegacyRemote(this.remote);
    const store = RemoteConfigStore.from(this._workingCopy);
    const legacy = store.legacyOrigin(this.remote) !== undefined;
    const trackingRef = `refs/remotes/${this.remote}/${remoteBranch}`;

    // Build refspec
    const refspecs = legacy
      ? this.remoteBranchName
        ? [this.remoteBranchName]
        : []
      : [`refs/heads/${remoteBranch}:${trackingRef}`];

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
        ...(this.fastForwardMode ? [`--${this.fastForwardMode}`] : []),
        ...(this.strategy ? [`--strategy=${this.strategy}`] : []),
        ...(this.tagOption === TagOption.FETCH_TAGS ? ["--tags"] : []),
        ...(this.tagOption === TagOption.NO_TAGS ? ["--no-tags"] : []),
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
    const origHead = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (rebase && origHead === undefined && !(await isIndexUnborn(this.staging))) {
      // git's pull.c: an unborn branch with an index file (even one without entries) is
      // refused before the fetch, --autostash or not
      return {
        rebaseResult: {
          status: RebaseStatus.FAILED,
          message: "fatal: Updating an unborn branch with changes added to the index.",
        },
        successful: false,
        rebaseUsed: true,
        fetchedFrom: this.remote,
      };
    }
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
    fetchCommand.setTransports(this.getTransports());
    fetchCommand.setRemote(this.remote);
    fetchCommand.setRefSpecs(...refspecs);
    // git pull fetches with --update-head-ok
    fetchCommand.setUpdateHeadOk(true);
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
    if (this.repositoryFiles) {
      fetchCommand.setRepositoryFiles(this.repositoryFiles);
    }

    const fetchResult = await fetchCommand.call();

    let warnings: string[] = [];
    let mergeTarget: { objectId: ObjectId; description?: string } | undefined;
    if (legacy) {
      if (fetchResult.isEmpty) {
        return { fetchResult, successful: true, rebaseUsed: false, fetchedFrom: this.remote };
      }
      warnings = await this.fastForwardMovedHead(origHead);
      mergeTarget = await this.mergeHeadFromFetchHead(localBranchName);
    } else {
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
      const resolved = await this.refsStore.resolve(trackingRef);
      if (resolved?.objectId) mergeTarget = { objectId: resolved.objectId };
    }

    if (!mergeTarget) {
      // Nothing to merge
      return {
        fetchResult,
        successful: true,
        rebaseUsed: false,
        fetchedFrom: this.remote,
      };
    }
    const trackingRefResolved = mergeTarget;
    // pull.c's warning() when the fetch moved the checked-out branch
    const shown = warnings.length > 0 ? { warnings } : {};

    // pull_into_void: an unborn branch (rebasing or not) branches off what was fetched, a
    // two-way switch from the empty tree keeping the staged changes it does not overwrite
    const headNow = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (origHead === undefined && headNow === undefined) {
      const mergeResult = await new MergeCommand(this._workingCopy)
        .shareHooksOf(this)
        .callIntoVoid(trackingRefResolved.objectId);
      return {
        fetchResult,
        mergeResult,
        successful: isMergeSuccessful(mergeResult.status),
        rebaseUsed: false,
        fetchedFrom: this.remote,
        ...shown,
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
        .shareHooksOf(this)
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
        ...shown,
      };
    }

    // Execute merge (git's message for a pull: `Merge branch 'x' of <url>`)
    const mergeCommand = new MergeCommand(this._workingCopy).shareHooksOf(this);
    mergeCommand.include(trackingRefResolved.objectId);
    // git's fmt-merge-msg shortens the URL: no trailing slash, no `.git`
    const url = (
      configValue(this._workingCopy, `remote.${this.remote}.url`) ??
      store.remoteUrls(this.remote)[0] ??
      this.remote
    )
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    const into =
      localBranchName === "main" || localBranchName === "master" ? "" : ` into ${localBranchName}`;
    mergeCommand.setMessage(
      mergeTarget.description
        ? `Merge ${mergeTarget.description}${into}`
        : `Merge branch '${remoteBranch}' of ${url}${into}`,
    );
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
        ...shown,
      };
    }
    return {
      fetchResult,
      mergeResult,
      successful,
      rebaseUsed: false,
      fetchedFrom: this.remote,
      ...shown,
    };
  }

  /**
   * pull.c after its fetch: when the fetch moved the checked-out branch itself
   * (`--update-head-ok`, a branches remote named after it), the index and worktree still at
   * `origHead` are fast-forwarded to the new HEAD (merge.c `checkout_fast_forward`), with
   * git's warning; local changes in the way are git's death.
   *
   * @returns the warning git printed, if any
   * @throws GitApiError with git's stderr: the warning, unpack-trees' refusal and pull.c's
   *   `Cannot fast-forward your working tree.` lines (exit 128)
   */
  private async fastForwardMovedHead(origHead: ObjectId | undefined): Promise<string[]> {
    const currHead = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (origHead === undefined || currHead === undefined || origHead === currHead) return [];
    const warning =
      "warning: fetch updated the current branch head.\n" +
      "fast-forwarding your working tree from\n" +
      `commit ${origHead}.`;
    const refused = await new MergeCommand(this._workingCopy)
      .shareHooksOf(this)
      .callCheckoutFastForward(origHead, currHead);
    if (refused) {
      throw new GitApiError(
        `${warning}\n${refused.message}\n` +
          "fatal: Cannot fast-forward your working tree.\n" +
          "After making sure that you saved anything precious from\n" +
          `$ git diff ${origHead}\n` +
          "output, run\n" +
          "$ git reset --hard\n" +
          "to recover.",
        { exitCode: 128 },
      );
    }
    return [warning];
  }

  /**
   * pull.c's `get_merge_heads`: the first FETCH_HEAD entry not marked `not-for-merge`, with
   * its description (`branch 'x' of <url>`, as fmt-merge-msg titles the merge).
   *
   * @throws GitApiError with `die_no_merge_candidates`' lines (exit 1) when there is none
   */
  private async mergeHeadFromFetchHead(
    branch: string,
  ): Promise<{ objectId: ObjectId; description?: string }> {
    const checkout = (this._workingCopy as { checkout?: Checkout }).checkout;
    const text = (await checkout?.readFetchHead?.()) ?? "";
    for (const line of text.split("\n")) {
      const m = /^([0-9a-f]{40,64})\t([^\t]*)\t(.*)$/.exec(line);
      if (!m || m[2] === "not-for-merge") continue;
      return { objectId: m[1] as ObjectId, description: m[3] };
    }
    const store = RemoteConfigStore.from(this._workingCopy);
    let message: string;
    if (this.remoteBranchName) {
      message =
        "There are no candidates for merging among the refs that you just fetched.\n" +
        "Generally this means that you provided a wildcard refspec which had no\n" +
        "matches on the remote end.";
    } else if (store.value(`branch.${branch}.remote`) !== this.remote) {
      message =
        `You asked to pull from the remote '${this.remote}', but did not specify\n` +
        "a branch. Because this is not the default configured remote\n" +
        "for your current branch, you must specify a branch on the command line.";
    } else {
      message =
        `Your configuration specifies to merge with the ref '${store.value(`branch.${branch}.merge`) ?? ""}'\n` +
        "from the remote, but no such ref was fetched.";
    }
    throw new GitApiError(message, { exitCode: 1 });
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
    const graph = new MergeBaseGraph(commitsBaseSource(this.commits, async () => new Map()));
    const bases = await graph.mergeBases(graph.commit(head), graph.commit(upstream));
    return bases.some((b) => b.id === head);
  }
}
