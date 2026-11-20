import type { PersonIdent } from "@statewalker/vcs-core";

import { parseGitBool } from "@statewalker/vcs-utils";

import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import { type RevertResult, RevertStatus } from "../results/revert-result.js";
import { CommitCommand, type CommitEditor } from "./commit-command.js";
import { favorOf } from "./merge-command.js";
import { OperationState } from "./merge-support.js";
import { CleanupMode } from "./message-cleanup.js";
import {
  type PickCommitMode,
  type PickOutcome,
  PickSequencer,
  SequencerOperation,
} from "./sequencer-pick.js";

/**
 * Revert commits on current branch.
 *
 * Equivalent to `git revert`: each commit's change undone by git's merge-ort (the commit as
 * base, its parent as theirs), written to the index and the working tree, and committed as
 * `Revert "<subject>"`. Refused, with git's messages, on staged changes, unmerged entries,
 * or where it would overwrite local changes or untracked files. A conflict stops with
 * git's markers (`>>>>>>> parent of <abbrev> (<subject>)`), stages 1-3 and git's state
 * (`REVERT_HEAD`, `MERGE_MSG`, `AUTO_MERGE`, `sequencer/` for several commits), so native
 * git can continue or abort it and the other way round ({@link setOperation}).
 *
 * @example
 * ```typescript
 * // Revert a single commit
 * const result = await git.revert().include(commitId).call();
 *
 * // Revert without committing
 * await git.revert().include(commitId).setNoCommit(true).call();
 *
 * // Revert a merge commit
 * await git.revert().include(mergeCommitId).setMainlineParentNumber(1).call();
 * ```
 */
export class RevertCommand extends GitCommand<RevertResult> {
  private includes: string[] = [];
  private noCommit = false;
  private mainlineParent?: number;
  private strategy: MergeStrategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private ourCommitName?: string;
  private reflogPrefix = "revert:";
  private operation = SequencerOperation.START;
  private committer?: PersonIdent;
  private edit?: boolean;
  private editor?: CommitEditor;

  /**
   * Add a commit to revert.
   *
   * @param refOrId Commit ID or reference to revert
   */
  include(refOrId: string): this {
    this.checkCallable();
    this.includes.push(refOrId);
    return this;
  }

  /**
   * Set whether to commit after revert (`--no-commit` when true).
   *
   * @param noCommit Whether to skip committing (default: false)
   */
  setNoCommit(noCommit: boolean): this {
    this.checkCallable();
    this.noCommit = noCommit;
    return this;
  }

  /**
   * Set mainline parent number for reverting merge commits.
   *
   * @param parent Parent number (1 = first parent, 2 = second parent)
   */
  setMainlineParentNumber(parent: number): this {
    this.checkCallable();
    this.mainlineParent = parent;
    return this;
  }

  /**
   * Set the merge strategy (only git's merge-ort is run; kept for compatibility).
   *
   * @param strategy Merge strategy to use
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
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
   * @param prefix Reflog message prefix (default: "revert:")
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
   * Revert the included commits (default), or `--continue`, `--skip`, `--abort`, `--quit`
   * the revert in progress.
   */
  setOperation(operation: SequencerOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /**
   * The committer of the commits made, and their author when nobody is configured (default:
   * both resolved as git resolves them).
   */
  setCommitter(committer: PersonIdent): this {
    this.checkCallable();
    this.committer = committer;
    return this;
  }

  /**
   * `--edit` (`-e`): each revert that applies cleanly is committed as git commits it then,
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
   * The editor of {@link setEdit} (git's `core.editor` / `GIT_EDITOR`): see
   * `CommitCommand.setEditor`. Without one the template is kept as it is (comments stripped).
   */
  setEditor(editor: CommitEditor): this {
    this.checkCallable();
    this.editor = editor;
    return this;
  }

  /**
   * The sequencer's `git commit`: run_git_commit's `git commit -n -e` for an edited revert
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
    } else {
      commit.shareHooksOf(this).setEdit(mode.edit);
      if (!mode.edit) commit.setCleanupMode(CleanupMode.STRIP);
    }
    if (this.editor) commit.setEditor(this.editor);
    if (this.committer) commit.setCommitterIdent(this.committer);
    const status = RemoteConfigStore.from(this.workingCopy).value("commit.status");
    commit.setIncludeStatus(status === undefined ? true : (parseGitBool(status) ?? true));
    const made = await commit.call();
    return made.id;
  }

  async call(): Promise<RevertResult> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();
    const worktree = this.worktreeAccess;
    const run = () => this.run();
    const result = toResult(await (worktree?.batch ? worktree.batch(run) : run()));
    return this.sparseWarnings.length > 0 ? { ...result, warnings: this.sparseWarnings } : result;
  }

  /** What the sparse checkout printed while the result was written. */
  private readonly sparseWarnings: string[] = [];

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
      },
      {
        action: "revert",
        noCommit: this.noCommit,
        mainline: this.mainlineParent,
        favor: favorOf(this.contentStrategy),
        oursLabel: this.ourCommitName,
        committer: this.committer,
        edit: this.edit,
        reflogAction: this.reflogAction(this.reflogPrefix.replace(/:$/, "")),
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

function toResult(outcome: PickOutcome): RevertResult {
  const status =
    outcome.status === "ok"
      ? RevertStatus.OK
      : outcome.status === "conflicting"
        ? RevertStatus.CONFLICTING
        : RevertStatus.FAILED;
  return {
    status,
    newHead: outcome.newHead,
    revertedRefs: outcome.picked,
    ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    output: outcome.output,
  };
}
