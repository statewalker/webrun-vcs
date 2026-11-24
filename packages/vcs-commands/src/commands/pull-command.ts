import type { FilesApi, ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { type Checkout, isIndexUnborn } from "@statewalker/vcs-working-tree";

import { GitApiError, NoHeadError } from "../errors/index.js";
import { GuardedTransportCommand } from "../guarded-transport-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { FetchResult } from "../results/fetch-result.js";
import {
  FastForwardMode,
  isMergeSuccessful,
  type MergeResult,
  type MergeStrategy,
} from "../results/merge-result.js";
import type { PullResult } from "../results/pull-result.js";
import { isRebaseSuccessful, RebaseStatus } from "../results/rebase-result.js";
import type { CommitEditor } from "./commit-command.js";
import { FetchCommand, TagOption } from "./fetch-command.js";
import { FetchMultipleCommand } from "./fetch-multiple-command.js";
import { commitsBaseSource, MergeBaseGraph } from "./merge-bases.js";
import { MergeCommand } from "./merge-command.js";
import { configValue } from "./merge-config.js";
import { OperationState, readIndex } from "./merge-support.js";
import { type CleanupMode, parseCleanupMode } from "./message-cleanup.js";
import { RebaseCommand } from "./rebase-command.js";

/** One `FETCH_HEAD` entry to merge (pull.c's get_merge_heads). */
interface MergeHead {
  objectId: ObjectId;
  description: string;
}

/**
 * Pull changes from a remote repository.
 *
 * Equivalent to `git pull`: git's fetch (`git fetch [<remote> [<refspec>...]]`, the
 * configured refspecs when none is given), then the `FETCH_HEAD` entries marked for merge
 * merged into the current branch (`git merge FETCH_HEAD`), rebased onto (`--rebase`,
 * `pull.rebase`), or branched off on an unborn branch (pull.c's `pull_into_void`). The
 * options pull passes to git's merge, rebase and fetch are passed on the same way.
 *
 * Credentials and headers follow `GuardedTransportCommand`'s rule: {@link setCredentials} and
 * {@link setHeaders} go only to the origins named with `addCredentialOrigin`, else to the
 * default remote's origin (`branch.<name>.remote`, a name or a URL) while every remote the
 * pull reaches has it, or to the URL given to {@link setRemote} when it names no configured
 * remote; per-URL providers
 * (`setCredentialsForUrl`, `setHeadersForUrl`) answer for their URL's origin; a redirect to
 * another origin carries none. `--all` runs `FetchMultipleCommand` (git's fetch_multiple).
 *
 * @example
 * ```typescript
 * // Pull the current branch's upstream (branch.<name>.remote / .merge)
 * const result = await git.pull().call();
 *
 * // git pull --no-rebase --squash upstream main
 * const result = await git.pull()
 *   .setRemote("upstream")
 *   .setRemoteBranchName("main")
 *   .setRebase(false)
 *   .setSquash(true)
 *   .call();
 *
 * // Pull with rebase (`git pull --rebase`; without the option, pull.rebase decides)
 * const result = await git.pull()
 *   .setRebase(true)
 *   .call();
 * ```
 */
export class PullCommand extends GuardedTransportCommand<PullResult> {
  private remote = "origin";
  /** Whether the remote was named (it is then in the reflog action). */
  private remoteGiven = false;
  /** The refspecs after the remote (`git pull <remote> <refspec>...`) */
  private refSpecs: string[] = [];
  /** `--rebase` / `--no-rebase`; undefined: branch.<name>.rebase, then pull.rebase */
  private rebase?: boolean;
  /** `--verify-signatures` / `--no-verify-signatures`, passed to the merge */
  private verifySignatures?: boolean;
  /** `--autostash` / `--no-autostash`; undefined: pull.autoStash, then rebase.autoStash */
  private autoStash?: boolean;
  private strategy?: MergeStrategy;
  private strategyOptions: string[] = [];
  private fastForwardMode?: FastForwardMode;
  private tagOption?: TagOption;
  private repositoryFiles?: { files: FilesApi; gitDir?: string };
  // options passed to git-merge
  private squash?: boolean;
  private commit?: boolean;
  private edit?: boolean;
  private editor?: CommitEditor;
  private log?: boolean | number;
  private signoff?: boolean;
  private cleanupMode?: CleanupMode;
  private cleanupArg?: string;
  private noVerify?: boolean;
  private allowUnrelatedHistories = false;
  // options passed to git-fetch
  private all = false;
  private prune?: boolean;
  private depth?: number;
  private deepen?: number;
  private unshallow = false;
  private force = false;
  private compatibility?: "2.43" | "2.56";
  private dryRun = false;
  private recurseSubmodules?: boolean | "on-demand";

  /**
   * `--verify-signatures` (true) / `--no-verify-signatures` (false), passed to the merge as
   * git's pull passes it (see `MergeCommand.setVerifySignatures`; undefined: the merge's
   * `merge.verifySignatures`). Pulling into an unborn branch checks the commit whichever of
   * the two is given (pull.c's `pull_into_void`); a rebasing pull ignores
   * `--verify-signatures` with git's warning.
   */
  setVerifySignatures(verify: boolean | undefined): this {
    this.checkCallable();
    this.verifySignatures = verify;
    return this;
  }

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
   * Set the remote to pull from: a configured remote's name, a path or a URL (git's
   * `<repository>`). Default: the current branch's `branch.<name>.remote`, else `origin`.
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
   * Set the remote branch to pull (one refspec, `git pull <remote> <branch>`).
   *
   * If not set, the remote's configured refspecs are fetched and the current branch's
   * `branch.<name>.merge` is merged.
   *
   * @param branch Remote branch name
   */
  setRemoteBranchName(branch: string): this {
    this.checkCallable();
    this.refSpecs = [branch];
    return this;
  }

  /**
   * Get the remote branch name (the first refspec).
   */
  getRemoteBranchName(): string | undefined {
    return this.refSpecs[0];
  }

  /**
   * The refspecs to fetch (`git pull <remote> <refspec>...`): what they fetch is merged, two
   * or more heads as an octopus.
   */
  setRefSpecs(...refSpecs: string[]): this {
    this.checkCallable();
    this.refSpecs = [...refSpecs];
    return this;
  }

  /**
   * Set whether to use rebase instead of merge (`--rebase` / `--no-rebase`). Without it the
   * configuration decides, as in git: `branch.<name>.rebase`, else `pull.rebase`, else merge
   * (a pull that cannot fast-forward then refuses unless `pull.ff` or a fast-forward mode
   * is given: git's "Need to specify how to reconcile divergent branches.").
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
   * Set the merge strategy (`-s <strategy>`, passed to the merge or the rebase).
   *
   * @param strategy Merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * `-X <option>` for each option (passed to the merge or the rebase, see
   * `MergeCommand.setStrategyOptions`).
   */
  setStrategyOptions(options: readonly string[]): this {
    this.checkCallable();
    this.strategyOptions = [...options];
    return this;
  }

  /**
   * Set the fast-forward mode (`--ff`, `--no-ff`, `--ff-only`; default `pull.ff`). With
   * `--ff-only` a pull whose branches diverged dies before merging or rebasing (git's
   * `die_ff_impossible`), and one that can fast-forward merges even when a rebase is asked.
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
   * Set the specification of annotated tag behavior during fetch (`--tags`, `--no-tags`).
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

  /** `--squash` / `--no-squash`, passed to the merge (see `MergeCommand.setSquash`). */
  setSquash(squash: boolean): this {
    this.checkCallable();
    this.squash = squash;
    return this;
  }

  /** `--commit` / `--no-commit`, passed to the merge (see `MergeCommand.setCommit`). */
  setCommit(commit: boolean): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  /**
   * `--edit` / `--no-edit`, passed to the merge: with `--edit` the merge commit's message
   * goes through the editor ({@link setEditor}; see `MergeCommand.setEdit`). Without either
   * the merge does not edit (git's default without a terminal).
   */
  setEdit(edit: boolean): this {
    this.checkCallable();
    this.edit = edit;
    return this;
  }

  /** The editor `--edit` runs over MERGE_MSG (git's `GIT_EDITOR`; see `CommitCommand.setEditor`). */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * `--log[=<n>]` / `--no-log`, passed to the merge (see `MergeCommand.setLog`): true is
   * `--log`, a number `--log=<n>`, false `--no-log`.
   */
  setLog(log: boolean | number): this {
    this.checkCallable();
    this.log = log;
    return this;
  }

  /**
   * `--signoff` / `--no-signoff`, passed to the merge, or to the rebase of a rebasing pull.
   */
  setSignoff(signoff: boolean): this {
    this.checkCallable();
    this.signoff = signoff;
    return this;
  }

  /**
   * `--cleanup=<mode>`, passed to the merge. A mode git does not know dies before the fetch
   * (`Invalid cleanup mode <mode>`).
   */
  setCleanupMode(mode: CleanupMode | string): this {
    this.checkCallable();
    this.cleanupArg = mode;
    return this;
  }

  /** `--no-verify` (true) / `--verify` (false), passed to the merge. */
  setNoVerify(noVerify: boolean): this {
    this.checkCallable();
    this.noVerify = noVerify;
    return this;
  }

  /** `--allow-unrelated-histories`, passed to the merge. */
  setAllowUnrelatedHistories(allow: boolean): this {
    this.checkCallable();
    this.allowUnrelatedHistories = allow;
    return this;
  }

  /**
   * `--all`: fetch every remote (but those with `remote.<name>.skipDefaultUpdate`), each
   * appending to FETCH_HEAD as git's `fetch --all` does, then merge what the current
   * branch's upstream marked for merge. Takes no remote or refspec.
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `--prune` / `--no-prune`, passed to the fetch (`FetchCommand.setRemoveDeletedRefs`). */
  setPrune(prune: boolean): this {
    this.checkCallable();
    this.prune = prune;
    return this;
  }

  /** `--depth=<n>`, passed to the fetch. */
  setDepth(depth: number): this {
    this.checkCallable();
    this.depth = depth;
    return this;
  }

  /** `--deepen=<n>`, passed to the fetch (`FetchCommand.setDeepen`). */
  setDeepen(deepen: number): this {
    this.checkCallable();
    this.deepen = deepen;
    return this;
  }

  /** `--unshallow`, passed to the fetch. */
  setUnshallow(unshallow: boolean): this {
    this.checkCallable();
    this.unshallow = unshallow;
    return this;
  }

  /**
   * The git version whose advice text the refusals follow (2.43: `hint: ` before an empty
   * line, `git config advice.<name> false`); default the hooks' compatibility.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** `--force`, passed to the fetch (`FetchCommand.setForceUpdate`). */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * `--dry-run`: the fetch only shows what it would do (`FetchCommand.setDryRun`), and
   * nothing is merged or rebased.
   */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /**
   * `--recurse-submodules[=on-demand]` / `--no-recurse-submodules`. Recursing into
   * submodules needs the fetch's submodule recursion, which is not implemented yet: a pull
   * asked to recurse refuses before it fetches (`GitApiError`, exit 128); false is accepted
   * (nothing recurses).
   */
  setRecurseSubmodules(recurse: boolean | "on-demand"): this {
    this.checkCallable();
    this.recurseSubmodules = recurse;
    return this;
  }

  /**
   * Execute the pull operation.
   *
   * @returns Pull result with fetch and merge results
   * @throws NoHeadError if HEAD is detached and no refspec is given
   * @throws GitApiError with git's stderr where git's pull dies (exit 128, or 1 when nothing
   *   fetched is to be merged)
   */
  async call(): Promise<PullResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.recurseSubmodules === true || this.recurseSubmodules === "on-demand") {
      throw new GitApiError(
        "fatal: --recurse-submodules is not supported by pull yet (fetching submodules is not implemented)",
        { exitCode: 128 },
      );
    }
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    // Get current branch
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch && this.refSpecs.length === 0) {
      throw new NoHeadError("Cannot pull with detached HEAD");
    }
    const localBranchName = currentBranch?.replace(/^refs\/heads\//, "");

    const store = RemoteConfigStore.from(this._workingCopy);
    if (!this.remoteGiven && localBranchName !== undefined) {
      // git fetch without a repository: the branch's remote, else origin
      this.remote = store.remoteForBranch(localBranchName);
    }
    if (this.all && (this.remoteGiven || this.refSpecs.length > 0)) {
      throw new GitApiError("fatal: fetch --all does not take a repository argument", {
        exitCode: 128,
      });
    }
    // get_cleanup_mode: an unknown mode dies before anything is fetched
    if (this.cleanupArg !== undefined) {
      let mode: CleanupMode;
      try {
        mode = parseCleanupMode(this.cleanupArg);
      } catch {
        throw new GitApiError(`fatal: Invalid cleanup mode ${this.cleanupArg}`, { exitCode: 128 });
      }
      this.cleanupMode = mode;
    }

    // git's GIT_REFLOG_ACTION for everything the pull writes: "pull" and its command-line
    // arguments (a rebase or autostash the configuration asks for is not among them)
    const action = this.reflogAction(this.commandLine().join(" "));

    // pull.ff, unless a fast-forward mode is given; an explicit --rebase / --no-rebase turns
    // pull.ff=only into --ff
    let ff = this.fastForwardMode;
    if (ff === undefined) {
      ff = this.configFastForward();
      if (this.rebase !== undefined && ff === FastForwardMode.FF_ONLY) ff = FastForwardMode.FF;
    }
    // git's pull.c: the option, else the configuration
    const configured =
      localBranchName !== undefined ? this.configRebase(localBranchName) : undefined;
    let rebase = this.rebase ?? configured ?? false;
    const rebaseUnspecified = this.rebase === undefined && configured === undefined;

    // an index with unmerged entries, or a merge in progress, dies before the fetch
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length > 0) {
      throw new GitApiError(
        [
          "error: Pulling is not possible because you have unmerged files.",
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
          "hint: as appropriate to mark resolution and make a commit.",
          "fatal: Exiting because of an unresolved conflict.",
        ].join("\n"),
        { exitCode: 128 },
      );
    }
    const checkout = (this._workingCopy as { checkout?: Checkout }).checkout;
    if (await this.mergeInProgress()) {
      throw new GitApiError(
        [
          "error: You have not concluded your merge (MERGE_HEAD exists).",
          "hint: Please, commit your changes before merging.",
          "fatal: Exiting because of unfinished merge.",
        ].join("\n"),
        { exitCode: 128 },
      );
    }

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

    // a remote read from .git/remotes/ or .git/branches/ (git 2.x) is fetched with its own
    // refspecs, as any other: `git fetch <remote> [<refspec>...]`
    const fetchResults: FetchResult[] = [];
    // remote_get(NULL): the branch's remote (a name, or a URL or path git allows there too)
    const defaultRemoteUrl = store.remoteUrlOf(store.remoteForBranch(localBranchName));
    if (this.all) {
      // fetch --all: builtin/fetch.c's fetch_multiple (every remote fetched, a failure
      // reported once all ran, skipDefaultUpdate / skipFetchAll honoured)
      const multiple = new FetchMultipleCommand(this._workingCopy)
        .setAll(true)
        .setUpdateHeadOk(true)
        .setEnvReflogAction(action);
      if (this.prune !== undefined) multiple.setPrune(this.prune);
      if (this.tagOption !== undefined) multiple.setTagOpt(this.tagOption);
      if (this.dryRun) multiple.setDryRun(true);
      if (this.force) multiple.setForceUpdate(true);
      // credentials and headers: decided from every URL the fetch reaches, handed down
      this.resolveAuth(await multiple.plannedUrls(), defaultRemoteUrl);
      this.configureChild(multiple);
      const fetched = await multiple.call();
      for (const entry of fetched.fetches) if (entry.result) fetchResults.push(entry.result);
      if (fetched.exitCode !== 0) {
        // run_fetch failed: pull returns its status before merging anything
        throw new GitApiError(fetched.stderr.replace(/\n$/, ""), { exitCode: fetched.exitCode });
      }
      if (fetched.remotes.length === 1) this.remote = fetched.remotes[0] as string;
    } else {
      await this.loadLegacyRemote(this.remote);
      // a URL the caller names (no configured remote) is the one this fetch is for: its
      // origin is trusted, as FetchCommand trusts the URL it is given
      const url = store.remoteUrlOf(this.remote);
      const named = this.remoteGiven && !store.isConfigured(this.remote);
      this.resolveAuth([url], named ? url : defaultRemoteUrl);
      fetchResults.push(await this.fetchCommand(this.remote, this.refSpecs, action).call());
    }
    const fetchResult = fetchResults[fetchResults.length - 1];
    const fetched = {
      fetchResult,
      ...(fetchResults.length > 1 ? { fetchResults } : {}),
      fetchedFrom: this.remote,
    };

    // --dry-run: nothing more once fetched
    if (this.dryRun) return { ...fetched, successful: true, rebaseUsed: false };

    let warnings = await this.fastForwardMovedHead(origHead);
    const shown = () => (warnings.length > 0 ? { warnings } : {});

    const { heads, text: fetchHead } = await this.mergeHeadsFromFetchHead(checkout);
    if (heads.length === 0) this.dieNoMergeCandidates(localBranchName, rebase);
    const mergeIds = heads.map((h) => h.objectId);

    // pull_into_void: an unborn branch (rebasing or not) branches off what was fetched, a
    // two-way switch from the empty tree keeping the staged changes it does not overwrite
    if (origHead === undefined) {
      if (heads.length > 1) {
        throw new GitApiError("fatal: Cannot merge multiple branches into empty head.", {
          exitCode: 128,
        });
      }
      const mergeResult = await new MergeCommand(this._workingCopy)
        .shareHooksOf(this)
        .setVerifySignatures(this.verifySignatures)
        .callIntoVoid(mergeIds[0] as ObjectId);
      return {
        ...fetched,
        mergeResult,
        successful: isMergeSuccessful(mergeResult.status),
        rebaseUsed: false,
        ...shown(),
      };
    }
    if (heads.length > 1) {
      if (rebase) {
        throw new GitApiError("fatal: Cannot rebase onto multiple branches.", { exitCode: 128 });
      }
      if (ff === FastForwardMode.FF_ONLY) {
        throw new GitApiError("fatal: Cannot fast-forward to multiple branches.", {
          exitCode: 128,
        });
      }
    }

    const canFastForward =
      heads.length === 1 && (await this.isAncestor(origHead, mergeIds[0] as ObjectId));
    let upToDate = true;
    if (!canFastForward) {
      for (const id of mergeIds) {
        if (!(await this.isAncestor(id, origHead))) {
          upToDate = false;
          break;
        }
      }
    }
    const divergent = !canFastForward && !upToDate;
    // ff-only takes precedence over rebase
    if (ff === FastForwardMode.FF_ONLY) {
      if (divergent) {
        throw new GitApiError(
          this.advice(
            [
              "Diverging branches can't be fast-forwarded, you need to either:",
              "",
              "\tgit merge --no-ff",
              "",
              "or:",
              "",
              "\tgit rebase",
            ],
            "diverging",
            "Not possible to fast-forward, aborting.",
          ),
          { exitCode: 128 },
        );
      }
      rebase = false;
    }
    // no way to reconcile divergent branches given: git's advice, then it dies
    if (ff === undefined && rebaseUnspecified && divergent) {
      throw new GitApiError(
        this.advice(
          [
            "You have divergent branches and need to specify how to reconcile them.",
            "You can do so by running one of the following commands sometime before",
            "your next pull:",
            "",
            "  git config pull.rebase false  # merge",
            "  git config pull.rebase true   # rebase",
            "  git config pull.ff only       # fast-forward only",
            "",
            'You can replace "git config" with "git config --global" to set a default',
            "preference for all repositories. You can also pass --rebase, --no-rebase,",
            "or --ff-only on the command line to override the configured default per",
            "invocation.",
          ],
          undefined,
          "Need to specify how to reconcile divergent branches.",
        ),
        { exitCode: 128 },
      );
    }

    // `git pull --rebase`: the branch rebased onto what was fetched
    // (one that only fast-forwards is a `merge --ff-only`, as git's pull runs it)
    if (rebase && !canFastForward) {
      // run_rebase
      if (this.verifySignatures === true) {
        warnings = [...warnings, "warning: ignoring --verify-signatures for rebase"];
      }
      const rebaseCommand = new RebaseCommand(this._workingCopy)
        .shareHooksOf(this)
        .setUpstream(mergeIds[0] as ObjectId)
        .setReflogAction(action)
        .setAutoStash(autoStash === true);
      if (this.strategy) rebaseCommand.setStrategy(this.strategy);
      if (this.strategyOptions.length > 0) rebaseCommand.setStrategyOptions(this.strategyOptions);
      if (this.signoff !== undefined) rebaseCommand.setSignoff(this.signoff);
      const rebaseResult = await rebaseCommand.call();
      return {
        ...fetched,
        rebaseResult,
        successful: isRebaseSuccessful(rebaseResult.status),
        rebaseUsed: true,
        ...shown(),
      };
    }

    // run_merge: `git merge [<options>] FETCH_HEAD`
    const mergeCommand = new MergeCommand(this._workingCopy).shareHooksOf(this);
    for (const id of mergeIds) mergeCommand.include(id);
    // git merges FETCH_HEAD: fmt-merge-msg describes the heads from its lines
    mergeCommand.setMergeNames(fetchHead);
    mergeCommand.setReflogAction(action);
    const mergeFf = rebase ? FastForwardMode.FF_ONLY : ff;
    if (mergeFf !== undefined) mergeCommand.setFastForwardMode(mergeFf);
    if (this.verifySignatures !== undefined)
      mergeCommand.setVerifySignatures(this.verifySignatures);
    // run_merge passes --autostash / --no-autostash only when pull has one to give
    if (autoStash !== undefined) mergeCommand.setAutoStash(autoStash);
    if (this.strategy) mergeCommand.setStrategy(this.strategy);
    if (this.strategyOptions.length > 0) mergeCommand.setStrategyOptions(this.strategyOptions);
    if (this.squash !== undefined) mergeCommand.setSquash(this.squash);
    if (this.commit !== undefined) mergeCommand.setCommit(this.commit);
    if (this.edit !== undefined) mergeCommand.setEdit(this.edit);
    if (this.editor) mergeCommand.setEditor(this.editor);
    if (this.log !== undefined) mergeCommand.setLog(this.log);
    if (this.signoff !== undefined) mergeCommand.setSignoff(this.signoff);
    if (this.cleanupMode !== undefined) mergeCommand.setCleanupMode(this.cleanupMode);
    if (this.noVerify !== undefined) mergeCommand.setNoVerify(this.noVerify);
    if (this.allowUnrelatedHistories) mergeCommand.setAllowUnrelatedHistories(true);

    const mergeResult: MergeResult = await mergeCommand.call();
    const successful = isMergeSuccessful(mergeResult.status);

    if (rebase) {
      // a rebasing pull still reports a rebase: the fast-forward it made instead
      return {
        ...fetched,
        mergeResult,
        rebaseResult: successful
          ? { status: RebaseStatus.FAST_FORWARD, newHead: mergeResult.newHead }
          : { status: RebaseStatus.FAILED, message: mergeResult.message },
        successful,
        rebaseUsed: true,
        ...shown(),
      };
    }
    return { ...fetched, mergeResult, successful, rebaseUsed: false, ...shown() };
  }

  /**
   * git's advise() lines (`hint:`, 2.43's `hint: ` before an empty line), the
   * `advise_if_enabled` hint naming `advice.<name>` when given, then the `fatal:` line.
   */
  private advice(lines: string[], name: string | undefined, fatal: string): string {
    const v243 = (this.compatibility ?? this.hooks.compatibility) === "2.43";
    const out = lines.map((l) => (l === "" ? (v243 ? "hint: " : "hint:") : `hint: ${l}`));
    if (name !== undefined) {
      out.push(
        v243 ? "hint: " : "hint:",
        `hint: Disable this message with "git config${v243 ? "" : " set"} advice.${name} false"`,
      );
    }
    out.push(`fatal: ${fatal}`);
    return out.join("\n");
  }

  /**
   * The pull's command line as git's reflog action spells it (`pull` and its arguments), in
   * a fixed order since our options have none.
   */
  private commandLine(): string[] {
    const flag = (value: boolean | undefined, name: string) =>
      value === true ? [`--${name}`] : value === false ? [`--no-${name}`] : [];
    return [
      "pull",
      ...flag(this.rebase, "rebase"),
      ...flag(this.autoStash, "autostash"),
      ...(this.log === undefined
        ? []
        : typeof this.log === "number"
          ? [`--log=${this.log}`]
          : flag(this.log, "log")),
      ...flag(this.signoff, "signoff"),
      ...flag(this.squash, "squash"),
      ...flag(this.commit, "commit"),
      ...flag(this.edit, "edit"),
      ...(this.cleanupArg !== undefined ? [`--cleanup=${this.cleanupArg}`] : []),
      ...(this.fastForwardMode ? [`--${this.fastForwardMode}`] : []),
      ...(this.noVerify === true ? ["--no-verify"] : this.noVerify === false ? ["--verify"] : []),
      ...flag(this.verifySignatures, "verify-signatures"),
      ...(this.strategy ? [`--strategy=${this.strategy}`] : []),
      ...this.strategyOptions.map((o) => `--strategy-option=${o}`),
      ...(this.allowUnrelatedHistories ? ["--allow-unrelated-histories"] : []),
      ...(this.all ? ["--all"] : []),
      ...(this.force ? ["--force"] : []),
      ...(this.dryRun ? ["--dry-run"] : []),
      ...(this.tagOption === TagOption.FETCH_TAGS ? ["--tags"] : []),
      ...(this.tagOption === TagOption.NO_TAGS ? ["--no-tags"] : []),
      ...flag(this.prune, "prune"),
      ...(this.depth !== undefined ? [`--depth=${this.depth}`] : []),
      ...(this.deepen !== undefined ? [`--deepen=${this.deepen}`] : []),
      ...(this.unshallow ? ["--unshallow"] : []),
      ...(this.remoteGiven || this.refSpecs.length > 0 ? [this.remote] : []),
      ...this.refSpecs,
    ];
  }

  /**
   * run_fetch: `git fetch [<options>] <remote> [<refspec>...]` with the pull's options, over
   * the guarded transports (the credentials and headers go only where they are for).
   */
  private fetchCommand(remote: string, refSpecs: string[], action: string): FetchCommand {
    const fetchCommand = this.configureChild(new FetchCommand(this._workingCopy));
    fetchCommand.setRemote(remote);
    fetchCommand.setRefSpecs(...refSpecs);
    // git pull fetches with --update-head-ok
    fetchCommand.setUpdateHeadOk(true);
    fetchCommand.setReflogAction(action);
    if (this.tagOption) fetchCommand.setTagOpt(this.tagOption);
    if (this.prune !== undefined) fetchCommand.setRemoveDeletedRefs(this.prune);
    if (this.depth !== undefined) fetchCommand.setDepth(this.depth);
    if (this.deepen !== undefined) fetchCommand.setDeepen(this.deepen);
    if (this.unshallow) fetchCommand.setUnshallow(true);
    if (this.force) fetchCommand.setForceUpdate(true);
    if (this.dryRun) fetchCommand.setDryRun(true);
    if (this.repositoryFiles) fetchCommand.setRepositoryFiles(this.repositoryFiles);
    return fetchCommand;
  }

  /** Whether MERGE_HEAD exists (pull.c's `file_exists(git_path_merge_head())`). */
  private async mergeInProgress(): Promise<boolean> {
    const state = new OperationState(this._workingCopy.checkout, this.refsStore);
    if ((await state.read("MERGE_HEAD")) !== undefined) return true;
    return (await state.ref("MERGE_HEAD")) !== undefined;
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
   * pull.c's `get_merge_heads`: the FETCH_HEAD entries not marked `not-for-merge`, with the
   * file's text (what `git merge FETCH_HEAD` gives fmt-merge-msg).
   */
  private async mergeHeadsFromFetchHead(
    checkout: Checkout | undefined,
  ): Promise<{ heads: MergeHead[]; text: string }> {
    const text = (await checkout?.readFetchHead?.()) ?? "";
    const heads: MergeHead[] = [];
    for (const line of text.split("\n")) {
      const m = /^([0-9a-f]{40,64})\t([^\t]*)\t(.*)$/.exec(line);
      if (!m || m[2] === "not-for-merge") continue;
      heads.push({ objectId: m[1] as ObjectId, description: m[3] as string });
    }
    return { heads, text };
  }

  /**
   * pull.c's `die_no_merge_candidates`: why nothing fetched is to be merged.
   *
   * @throws GitApiError with git's lines (exit 1)
   */
  private dieNoMergeCandidates(branch: string | undefined, rebase: boolean): never {
    const store = RemoteConfigStore.from(this._workingCopy);
    const branchRemote = branch !== undefined ? store.value(`branch.${branch}.remote`) : undefined;
    const which = rebase
      ? "Please specify which branch you want to rebase against."
      : "Please specify which branch you want to merge with.";
    let lines: string[];
    if (this.refSpecs.length > 0) {
      lines = [
        rebase
          ? "There is no candidate for rebasing against among the refs that you just fetched."
          : "There are no candidates for merging among the refs that you just fetched.",
        "Generally this means that you provided a wildcard refspec which had no",
        "matches on the remote end.",
      ];
    } else if (this.remoteGiven && branch !== undefined && branchRemote !== this.remote) {
      lines = [
        `You asked to pull from the remote '${this.remote}', but did not specify`,
        "a branch. Because this is not the default configured remote",
        "for your current branch, you must specify a branch on the command line.",
      ];
    } else if (branch === undefined) {
      lines = [
        "You are not currently on a branch.",
        which,
        "See git-pull(1) for details.",
        "",
        "    git pull <remote> <branch>",
        "",
      ];
    } else if (store.values(`branch.${branch}.merge`).length === 0) {
      const remotes = store.configuredNames();
      const remoteName = remotes.length === 1 ? remotes[0] : "<remote>";
      lines = [
        "There is no tracking information for the current branch.",
        which,
        "See git-pull(1) for details.",
        "",
        "    git pull <remote> <branch>",
        "",
        "If you wish to set tracking information for this branch you can do so with:",
        "",
        `    git branch --set-upstream-to=${remoteName}/<branch> ${branch}`,
        "",
      ];
    } else {
      const merge = store.values(`branch.${branch}.merge`)[0] ?? "";
      lines = [
        `Your configuration specifies to merge with the ref '${merge}'`,
        "from the remote, but no such ref was fetched.",
      ];
    }
    throw new GitApiError(lines.join("\n"), { exitCode: 1 });
  }

  private config(key: string): string | undefined {
    return configValue(this._workingCopy, key);
  }

  /**
   * git's config_get_ff: `pull.ff` (false `--no-ff`, true `--ff`, `only` `--ff-only`).
   *
   * @throws GitApiError for any other value (`invalid value for 'pull.ff'`)
   */
  private configFastForward(): FastForwardMode | undefined {
    const value = this.config("pull.ff");
    if (value === undefined) return undefined;
    const bool = parseGitBool(value);
    if (bool === true) return FastForwardMode.FF;
    if (bool === false) return FastForwardMode.NO_FF;
    if (value === "only") return FastForwardMode.FF_ONLY;
    throw new GitApiError(`fatal: invalid value for 'pull.ff': '${value}'`, { exitCode: 128 });
  }

  /**
   * git's config_get_rebase: `branch.<name>.rebase`, else `pull.rebase`; any value other
   * than false (`true`, `merges`, `interactive`) rebases. Undefined when neither is set.
   */
  private configRebase(branch: string): boolean | undefined {
    for (const key of [`branch.${branch}.rebase`, "pull.rebase"]) {
      const value = this.config(key);
      if (value === undefined) continue;
      return parseGitBool(value) ?? true;
    }
    return undefined;
  }

  /**
   * Whether `ancestor` is an ancestor of `commit` (git's repo_is_descendant_of), by git's
   * date-ordered paint walk, which stops once the sides meet.
   */
  private async isAncestor(ancestor: string, commit: string): Promise<boolean> {
    if (ancestor === commit) return true;
    const graph = new MergeBaseGraph(commitsBaseSource(this.commits, async () => new Map()));
    const bases = await graph.mergeBases(graph.commit(ancestor), graph.commit(commit));
    return bases.some((b) => b.id === ancestor);
  }
}
