import type { PersonIdent } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import { type CherryPickResult, CherryPickStatus } from "../results/cherry-pick-result.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import { favorOf } from "./merge-command.js";
import { OperationState } from "./merge-support.js";
import { type PickOutcome, PickSequencer, SequencerOperation } from "./sequencer-pick.js";

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
  private ourCommitName?: string;
  private reflogPrefix = "cherry-pick:";
  private operation = SequencerOperation.START;
  private committer?: PersonIdent;

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

  async call(): Promise<CherryPickResult> {
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
      },
      {
        action: "pick",
        noCommit: this.noCommit,
        mainline: this.mainlineParent,
        favor: favorOf(this.contentStrategy),
        oursLabel: this.ourCommitName,
        committer: this.committer,
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
