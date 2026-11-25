import type { PersonIdent } from "@statewalker/vcs-core";

import { parseGitBool } from "@statewalker/vcs-utils";

import { GitApiError } from "../errors/git-api-error.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type CherryPickResult, CherryPickStatus } from "../results/cherry-pick-result.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import { CommitCommand, type CommitEditor } from "./commit-command.js";
import { favorOf } from "./merge-command.js";
import { OperationState } from "./merge-support.js";
import { CleanupMode } from "./message-cleanup.js";
import {
  type PickCommitMode,
  type PickOutcome,
  PickSequencer,
  pickOptionsConflict,
  SequencerOperation,
} from "./sequencer-pick.js";

/**
 * Cherry-pick commits onto current branch.
 *
 * Equivalent to `git cherry-pick`: each commit's change merged into HEAD by git's merge-ort,
 * written to the index and the working tree, and committed with the commit's author and
 * message. Refused, with git's messages, on staged changes, unmerged entries, or where the
 * change would overwrite local changes or untracked files. A conflict stops with git's
 * markers (`<<<<<<< HEAD` / `>>>>>>> <abbrev> (<subject>)`), stages 1-3 and git's state
 * (`CHERRY_PICK_HEAD`, `MERGE_MSG`, `AUTO_MERGE`, and `sequencer/` for several commits), so
 * native git can `--continue`, `--skip` or `--abort` it, and the other way round
 * ({@link setOperation}).
 *
 * @example
 * ```typescript
 * const result = await git.cherryPick().include(commitId).call();
 * if (result.status === CherryPickStatus.CONFLICTING) {
 *   // resolve, `git add`, then
 *   await git.cherryPick().setOperation(SequencerOperation.CONTINUE).call();
 * }
 *
 * // Cherry-pick a merge commit
 * await git.cherryPick().include(mergeCommitId).setMainlineParentNumber(1).call();
 * ```
 */
export class CherryPickCommand extends GitCommand<CherryPickResult> {
  private includes: string[] = [];
  private noCommit = false;
  private mainlineParent?: number;
  private strategy: MergeStrategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private strategyGiven = false;
  private strategyOptions: string[] = [];
  /** Whose behaviour to follow where git 2.43 and 2.5x differ (default: the hooks') */
  private compatibility?: "2.43" | "2.56";
  private ourCommitName?: string;
  private reflogPrefix = "cherry-pick:";
  private operation = SequencerOperation.START;
  private committer?: PersonIdent;
  private edit?: boolean;
  /** `-S[<keyid>]` / `--no-gpg-sign` (undefined: `commit.gpgSign`) */
  private sign?: boolean | string;
  private editor?: CommitEditor;
  private signoff = false;
  private recordOrigin = false;
  private allowEmpty = false;
  private allowEmptyMessage = false;
  private keepRedundant = false;
  private empty?: "stop" | "drop" | "keep";
  private allowFf = false;

  /**
   * Add a commit to cherry-pick.
   *
   * @param refOrId Commit ID or reference to cherry-pick
   */
  include(refOrId: string): this {
    this.checkCallable();
    this.includes.push(refOrId);
    return this;
  }

  /**
   * Set whether to commit after cherry-pick (`--no-commit` when true: the change is left in
   * the index and the worktree, with `MERGE_MSG`).
   *
   * @param noCommit Whether to skip committing (default: false)
   */
  setNoCommit(noCommit: boolean): this {
    this.checkCallable();
    this.noCommit = noCommit;
    return this;
  }

  /**
   * Set mainline parent number for cherry-picking merge commits.
   *
   * @param parent Parent number (1 = first parent, 2 = second parent)
   */
  setMainlineParentNumber(parent: number): this {
    this.checkCallable();
    this.mainlineParent = parent;
    return this;
  }

  /**
   * Set the merge strategy (`-s`): merge-ort (RECURSIVE, ORT), RESOLVE (git-merge-resolve) or
   * SUBTREE (git merge-subtree). Given, it is saved in `sequencer/opts` for a run of several
   * commits.
   *
   * @param strategy Merge strategy to use
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    this.strategyGiven = true;
    return this;
  }

  /**
   * The `-X <option>`s (merge-ort's parse_merge_opt: `ours`, `theirs`, `subtree[=<path>]`,
   * `patience`, `diff-algorithm=<name>`, `ignore-space-change`, `ignore-all-space`,
   * `ignore-space-at-eol`, `ignore-cr-at-eol`, `renormalize`, `no-renames`,
   * `find-renames[=<n>]`, `rename-threshold=<n>`); unknown ones are ignored, as the
   * sequencer ignores them.
   */
  setStrategyOptions(options: readonly string[]): this {
    this.checkCallable();
    this.strategyOptions = [...options];
    return this;
  }

  /**
   * Whose behaviour to follow where git 2.43 and 2.5x differ (a strategy that gives up dies
   * in 2.5x only; 2.43's merge-subtree records no AUTO_MERGE). Default: the hook runner's,
   * else 2.56.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** Adds one `-X <option>` (see {@link setStrategyOptions}). */
  addStrategyOption(option: string): this {
    this.checkCallable();
    this.strategyOptions.push(option);
    return this;
  }

  /**
   * Get the merge strategy.
   */
  getStrategy(): MergeStrategy {
    return this.strategy;
  }

  /**
   * Set the content merge strategy for handling conflicts (`-X ours`, `-X theirs`).
   *
   * @param contentStrategy Content merge strategy
   */
  setContentMergeStrategy(contentStrategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = contentStrategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Set the name to be used for "ours" in conflict markers.
   *
   * @param name Name for ours side (default: HEAD)
   */
  setOurCommitName(name: string): this {
    this.checkCallable();
    this.ourCommitName = name;
    return this;
  }

  /**
   * Get the name used for "ours" in conflict markers.
   */
  getOurCommitName(): string | undefined {
    return this.ourCommitName;
  }

  /**
   * Set the reflog prefix.
   *
   * @param prefix Reflog message prefix (default: "cherry-pick:")
   */
  setReflogPrefix(prefix: string): this {
    this.checkCallable();
    this.reflogPrefix = prefix;
    return this;
  }

  /**
   * Get the reflog prefix.
   */
  getReflogPrefix(): string {
    return this.reflogPrefix;
  }

  /**
   * Pick the included commits (default), or `--continue`, `--skip`, `--abort`, `--quit`
   * the cherry-pick in progress.
   */
  setOperation(operation: SequencerOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /** The committer of the commits made (default: resolved as git resolves it). */
  setCommitter(committer: PersonIdent): this {
    this.checkCallable();
    this.committer = committer;
    return this;
  }

  /**
   * `--edit` (`-e`): each cherry-pick that applies cleanly is committed as git commits it then,
   * by `git commit -n -e`: the message goes through the editor ({@link setEditor}) in git
   * commit's template (with its help and status, as `commit.status` says), with git
   * commit's prepare-commit-msg (told `merge`) and post-commit hooks, and without pre-commit
   * or commit-msg. `false` (`--no-edit`) commits the message as it is, as does leaving it unset
   * (the default). Given either way, it is saved in `sequencer/opts` (`options.edit`) for a
   * run of several commits: `--continue` then commits a resolved conflict under `--edit` by
   * plain `git commit` (its editor, every hook), and edits the picks after it.
   */
  setEdit(edit: boolean): this {
    this.checkCallable();
    this.edit = edit;
    return this;
  }

  /**
   * `-S` (true) / `--no-gpg-sign` (false): whether to sign the commits made; undefined (the
   * default) leaves it to `commit.gpgSign`. Each commit is signed through the host's signer
   * (`GitHostEnvironment.signer`) as git's sequencer signs it (try_to_commit's commit_tree, or
   * the `git commit -S<key>` it runs after an edit or a resolved conflict). When it cannot be
   * signed the pick fails as git's does (`error: gpg failed to sign the data:`, `error: failed
   * to write commit object`; 2.43 adds `fatal: cherry-pick failed`, exit 128, 2.5x exits 1:
   * {@link SigningFailedError}), left in progress and nothing committed.
   */
  setSign(sign: boolean | undefined): this {
    this.checkCallable();
    this.sign = sign;
    return this;
  }

  /** `-S<keyid>`: sign with this key (see {@link setSign}). */
  setSigningKey(keyId: string): this {
    this.checkCallable();
    this.sign = keyId;
    return this;
  }

  /**
   * `-s` / `--signoff`: the committer's `Signed-off-by:` added to each message as git's
   * append_signoff adds it (after a blank line unless the message ends with a trailer block,
   * nothing when that block's last line is it already; `trailer.*` configuration applies).
   * The message is then cleaned up as `whitespace` unless `commit.cleanup` says otherwise.
   */
  setSignoff(signoff: boolean): this {
    this.checkCallable();
    this.signoff = signoff;
    return this;
  }

  /**
   * `-x`: `(cherry picked from commit <id>)` added to each message, after a blank line unless
   * the message ends with a trailer block; the message is then cleaned up as `whitespace`
   * unless `commit.cleanup` says otherwise.
   */
  setRecordOrigin(recordOrigin: boolean): this {
    this.checkCallable();
    this.recordOrigin = recordOrigin;
    return this;
  }

  /** `--allow-empty`: a commit that is empty in itself is committed (default: the pick stops). */
  setAllowEmpty(allowEmpty: boolean): this {
    this.checkCallable();
    this.allowEmpty = allowEmpty;
    return this;
  }

  /** `--allow-empty-message` (kept in `sequencer/opts`; a message is never refused here). */
  setAllowEmptyMessage(allowEmptyMessage: boolean): this {
    this.checkCallable();
    this.allowEmptyMessage = allowEmptyMessage;
    return this;
  }

  /**
   * `--keep-redundant-commits` (git's deprecated `--empty=keep`): a commit whose change is in
   * HEAD already is committed empty; implies {@link setAllowEmpty}.
   */
  setKeepRedundantCommits(keep: boolean): this {
    this.checkCallable();
    this.keepRedundant = keep;
    return this;
  }

  /**
   * `--empty=<mode>` (git 2.45+): what to do with a commit whose change is in HEAD already:
   * `stop` (the default: the pick stops for `git commit --allow-empty` or `--skip`), `drop`
   * (skipped, with git's `dropping <id> <subject> -- patch contents already upstream` line in
   * the result's output) or `keep` (committed empty, as {@link setKeepRedundantCommits}).
   * A commit empty in itself is still left to {@link setAllowEmpty}.
   */
  setEmpty(mode: "stop" | "drop" | "keep"): this {
    this.checkCallable();
    this.empty = mode;
    return this;
  }

  /**
   * `--ff`: a commit whose parent (the `-m` one of a merge) is HEAD, or a root commit on an
   * unborn branch, is fast-forwarded to (reflog `cherry-pick: fast-forward`) instead of
   * picked. Refused with `-s`, `-x`, `--no-commit` and `--edit`, as git refuses them.
   */
  setFastForward(fastForward: boolean): this {
    this.checkCallable();
    this.allowFf = fastForward;
    return this;
  }

  /**
   * The editor of {@link setEdit} (git's `core.editor` / `GIT_EDITOR`): see
   * `CommitCommand.setEditor`. Without one the template is kept as it is (comments stripped).
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * The sequencer's `git commit`: run_git_commit's `git commit -n -e` for an edited cherry-pick
   * (GIT_REFLOG_ACTION set), or continue_single_pick's `git commit` for a resolved conflict
   * (`--no-edit --cleanup=strip` unless edited; every hook, its own reflog message).
   */
  private async gitCommit(mode: PickCommitMode) {
    const commit = new CommitCommand(this.workingCopy);
    if (mode.kind === "pick") {
      commit
        .shareHooksOf(this, { GIT_REFLOG_ACTION: mode.reflogAction })
        .setNoVerify(true)
        .setEdit(true)
        .setReflogAction(mode.reflogAction);
      if (mode.allowEmpty) commit.setAllowEmpty(true);
    } else {
      commit.shareHooksOf(this).setEdit(mode.edit);
      if (!mode.edit) commit.setCleanupMode(CleanupMode.STRIP);
    }
    if (this.editor) commit.setEditor(this.editor);
    // run_git_commit passes -S<key> (the run's gpg_sign) to git commit
    if (typeof this.sign === "string") commit.setSigningKey(this.sign);
    else if (this.sign !== undefined) commit.setSign(this.sign);
    if (this.committer) commit.setCommitterIdent(this.committer);
    const status = RemoteConfigStore.from(this.workingCopy).value("commit.status");
    commit.setIncludeStatus(status === undefined ? true : (parseGitBool(status) ?? true));
    const made = await commit.call();
    this.rerereLines.push(...(made.rerereOutput ?? []));
    return made.id;
  }

  async call(): Promise<CherryPickResult> {
    this.checkCallable();
    this.setCallable(false);
    this.checkOptions();
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();
    const worktree = this.worktreeAccess;
    const run = () => this.run();
    let result = toResult(await (worktree?.batch ? worktree.batch(run) : run()));
    if (this.rerereLines.length > 0) result = { ...result, rerereOutput: [...this.rerereLines] };
    return this.sparseWarnings.length > 0 ? { ...result, warnings: this.sparseWarnings } : result;
  }

  /** parse_options and verify_opt_compatible: git's refusals before anything is read. */
  private checkOptions(): void {
    if (this.mainlineParent !== undefined && !(this.mainlineParent > 0)) {
      throw new GitApiError("error: option `mainline' expects a number greater than zero", {
        exitCode: 129,
      });
    }
    const conflict = pickOptionsConflict(
      "pick",
      this.operation,
      {
        action: "pick",
        noCommit: this.noCommit,
        mainline: this.mainlineParent,
        signoff: this.signoff,
        edit: this.edit,
        recordOrigin: this.recordOrigin,
        allowFf: this.allowFf,
        keepRedundant: this.keepRedundant || this.empty === "keep",
        emptyGiven: this.empty !== undefined,
        ...(this.rerereAutoUpdate === undefined ? {} : { rerereAutoUpdate: this.rerereAutoUpdate }),
      },
      this.hooks.compatibility,
    );
    if (conflict) throw new GitApiError(conflict, { exitCode: 128 });
  }

  /** What the sparse checkout printed while the result was written. */
  private readonly sparseWarnings: string[] = [];
  /** What rerere printed on stderr (a stopped pick, a `--continue`'s commit) */
  private readonly rerereLines: string[] = [];
  /** `--[no-]rerere-autoupdate` */
  private rerereAutoUpdate?: boolean;

  /**
   * `--rerere-autoupdate` (true) / `--no-rerere-autoupdate` (false): whether resolutions
   * rerere replays at a conflict are staged (default `rerere.autoUpdate`); kept for the
   * picks `--continue` makes, refused with `--continue`, `--skip`, `--abort`, `--quit`.
   */
  setRerereAutoUpdate(autoUpdate: boolean): this {
    this.checkCallable();
    this.rerereAutoUpdate = autoUpdate;
    return this;
  }

  private async run(): Promise<PickOutcome> {
    const sequencer = new PickSequencer(
      {
        workingCopy: this.workingCopy,
        worktree: this.worktreeAccess,
        staging: this.staging,
        blobs: this.blobs,
        trees: this.trees,
        commits: this.commits,
        refs: this.refsStore,
        sparseWarnings: this.sparseWarnings,
        state: new OperationState(this.workingCopy.checkout, this.refsStore),
        resolve: (name) => this.resolveRef(name),
        hooks: this.hooks,
        gitCommit: (mode) => this.gitCommit(mode),
        rerereOutput: this.rerereLines,
      },
      {
        action: "pick",
        noCommit: this.noCommit,
        mainline: this.mainlineParent,
        favor: favorOf(this.contentStrategy),
        ...(this.strategyGiven ? { strategy: this.strategy } : {}),
        strategyOptions: this.strategyOptions,
        ...(this.compatibility ? { compatibility: this.compatibility } : {}),
        oursLabel: this.ourCommitName,
        committer: this.committer,
        edit: this.edit,
        sign: this.sign,
        signoff: this.signoff,
        recordOrigin: this.recordOrigin,
        allowEmpty: this.allowEmpty,
        allowEmptyMessage: this.allowEmptyMessage,
        keepRedundant: this.keepRedundant || this.empty === "keep",
        dropRedundant: this.empty === "drop",
        allowFf: this.allowFf,
        reflogAction: this.reflogAction(this.reflogPrefix.replace(/:$/, "")),
        ...(this.rerereAutoUpdate === undefined ? {} : { rerereAutoUpdate: this.rerereAutoUpdate }),
      },
    );
    switch (this.operation) {
      case SequencerOperation.CONTINUE:
        return sequencer.continue();
      case SequencerOperation.SKIP:
        return sequencer.skip();
      case SequencerOperation.ABORT:
        return sequencer.abort();
      case SequencerOperation.QUIT:
        return sequencer.quit();
      default:
        return sequencer.start(this.includes);
    }
  }
}

function toResult(outcome: PickOutcome): CherryPickResult {
  const status =
    outcome.status === "ok"
      ? CherryPickStatus.OK
      : outcome.status === "conflicting"
        ? CherryPickStatus.CONFLICTING
        : CherryPickStatus.FAILED;
  return {
    status,
    newHead: outcome.newHead,
    cherryPickedRefs: outcome.picked,
    ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    output: outcome.output,
  };
}
