import type { PersonIdent } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import { type RevertResult, RevertStatus } from "../results/revert-result.js";
import { favorOf } from "./merge-command.js";
import { OperationState } from "./merge-support.js";
import { type PickOutcome, PickSequencer, SequencerOperation } from "./sequencer-pick.js";

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

  async call(): Promise<RevertResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktree = this.worktreeAccess;
    const run = () => this.run();
    return toResult(await (worktree?.batch ? worktree.batch(run) : run()));
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
        state: new OperationState(this.workingCopy.checkout, this.refsStore),
        resolve: (name) => this.resolveRef(name),
      },
      {
        action: "revert",
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
