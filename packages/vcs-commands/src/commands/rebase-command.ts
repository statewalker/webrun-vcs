import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

import {
  CommitNotFoundError,
  InvalidArgumentError,
  NoHeadError,
  NoRebaseInProgressError,
  UpstreamRequiredError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { RebaseResult, RebaseTodoLine } from "../results/rebase-result.js";
import { RebaseAction, RebaseStatus } from "../results/rebase-result.js";
import { mergeTreesThreeWay } from "../tree-merge/index.js";

/**
 * Get timezone offset string in Git format (+HHMM or -HHMM).
 */
function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hours = Math.floor(absOffset / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absOffset % 60).toString().padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

/**
 * The available rebase operations.
 *
 * Based on JGit's RebaseCommand.Operation.
 */
export enum RebaseOperation {
  /** Initiates rebase */
  BEGIN = "begin",

  /** Continues after conflict resolution */
  CONTINUE = "continue",

  /** Skips the current commit */
  SKIP = "skip",

  /** Aborts and resets the current rebase */
  ABORT = "abort",

  /** Process steps (internal) */
  PROCESS_STEPS = "process-steps",
}

/**
 * Interactive rebase handler interface.
 *
 * Based on JGit's RebaseCommand.InteractiveHandler.
 */
export interface InteractiveHandler {
  /**
   * Prepare the list of steps before rebase starts.
   * Can reorder, remove, or change actions.
   */
  prepareSteps(steps: RebaseTodoLine[]): void;

  /**
   * Modify commit message during reword/squash.
   */
  modifyCommitMessage(message: string): string;
}

/**
 * In-memory rebase state.
 */
interface RebaseState {
  /** Original HEAD ref name */
  headName: string;

  /** Original HEAD commit ID */
  originalHead: ObjectId;

  /** Onto commit (upstream) */
  onto: ObjectId;

  /** Onto name for messages */
  ontoName: string;

  /** Commits to cherry-pick in order */
  todoSteps: RebaseTodoLine[];

  /** Completed steps */
  doneSteps: RebaseTodoLine[];

  /** Whether rebase is in progress */
  inProgress: boolean;

  /** Current commit being processed (for stop/conflict) */
  currentCommit?: ObjectId;
}

/**
 * Rebase command for replaying commits on top of another branch.
 *
 * Equivalent to `git rebase`.
 *
 * Based on JGit's RebaseCommand.
 *
 * @example
 * ```typescript
 * // Basic rebase onto main
 * const result = await git.rebase()
 *   .setUpstream("main")
 *   .call();
 *
 * // Abort ongoing rebase
 * const result = await git.rebase()
 *   .setOperation(RebaseOperation.ABORT)
 *   .call();
 *
 * // Rebase with merge strategy
 * const result = await git.rebase()
 *   .setUpstream("main")
 *   .setStrategy(MergeStrategy.OURS)
 *   .call();
 * ```
 */
export class RebaseCommand extends GitCommand<RebaseResult> {
  private operation = RebaseOperation.BEGIN;
  private upstreamCommit?: ObjectId;
  private upstreamCommitName?: string;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;
  private preserveMerges = false;
  private interactiveHandler?: InteractiveHandler;

  // In-memory state for tracking rebase progress
  private static rebaseStates = new WeakMap<object, RebaseState>();

  /**
   * Set the upstream branch or commit to rebase onto.
   *
   * @param upstream The upstream commit ID
   */
  setUpstream(upstream: ObjectId): this {
    this.checkCallable();
    this.upstreamCommit = upstream;
    this.upstreamCommitName = upstream;
    return this;
  }

  /**
   * Set the upstream branch name to rebase onto.
   *
   * @param upstream The upstream branch name
   */
  async setUpstreamBranch(upstream: string): Promise<this> {
    this.checkCallable();
    this.upstreamCommit = await this.resolveRef(upstream);
    this.upstreamCommitName = upstream;
    return this;
  }

  /**
   * Override the upstream name for conflict messages.
   *
   * @param name The name to use for upstream in messages
   */
  setUpstreamName(name: string): this {
    this.checkCallable();
    if (!this.upstreamCommit) {
      throw new InvalidArgumentError(
        "upstreamName",
        name,
        "setUpstreamName must be called after setUpstream",
      );
    }
    this.upstreamCommitName = name;
    return this;
  }

  /**
   * Set the operation to perform.
   *
   * @param operation BEGIN, CONTINUE, SKIP, or ABORT
   */
  setOperation(operation: RebaseOperation): this {
    this.checkCallable();
    this.operation = operation;
    return this;
  }

  /**
   * Get the current operation.
   */
  getOperation(): RebaseOperation {
    return this.operation;
  }

  /**
   * Set the merge strategy to use.
   *
   * @param strategy The merge strategy
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
   * Set the content merge strategy for file-level conflicts.
   *
   * @param strategy The content merge strategy
   */
  setContentMergeStrategy(strategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = strategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Set whether to preserve merges during rebase.
   *
   * @param preserve true to re-create merges
   */
  setPreserveMerges(preserve: boolean): this {
    this.checkCallable();
    this.preserveMerges = preserve;
    return this;
  }

  /**
   * Get whether merges are preserved.
   */
  getPreserveMerges(): boolean {
    return this.preserveMerges;
  }

  /**
   * Enable interactive rebase with the given handler.
   *
   * @param handler The interactive handler
   */
  runInteractively(handler: InteractiveHandler): this {
    this.checkCallable();
    this.interactiveHandler = handler;
    return this;
  }

  /**
   * Execute the rebase command.
   */
  async call(): Promise<RebaseResult> {
    this.checkCallable();
    this.setCallable(false);

    switch (this.operation) {
      case RebaseOperation.ABORT:
        return this.abort();

      case RebaseOperation.CONTINUE:
        return this.continueRebase();

      case RebaseOperation.SKIP:
        return this.skip();

      case RebaseOperation.BEGIN:
      case RebaseOperation.PROCESS_STEPS:
        return this.begin();
    }
  }

  /**
   * Begin the rebase operation.
   */
  private async begin(): Promise<RebaseResult> {
    if (!this.upstreamCommit) {
      throw new UpstreamRequiredError("Upstream commit is required for rebase BEGIN operation");
    }

    // Get current HEAD
    const headResolved = await this.refsStore.resolve("HEAD");
    if (!headResolved?.objectId) {
      throw new NoHeadError("HEAD cannot be resolved");
    }

    const headCommit = headResolved.objectId;

    // Get HEAD's target branch name (if symbolic)
    const headRef = await this.refsStore.get("HEAD");
    const headName = headRef && "target" in headRef ? headRef.target : headCommit;

    // Check if already up to date
    const isAncestor = await this.isAncestor(this.upstreamCommit, headCommit);
    if (isAncestor) {
      return {
        status: RebaseStatus.UP_TO_DATE,
        newHead: headCommit,
      };
    }

    // Check if can fast-forward
    const canFastForward = await this.isAncestor(headCommit, this.upstreamCommit);
    if (canFastForward) {
      // Fast-forward HEAD to upstream
      await this.updateHead(headName, this.upstreamCommit);
      return {
        status: RebaseStatus.FAST_FORWARD,
        newHead: this.upstreamCommit,
      };
    }

    // Calculate commits to cherry-pick
    const commitsToRebase = await this.calculateCommitsToRebase(headCommit, this.upstreamCommit);

    if (commitsToRebase.length === 0) {
      return {
        status: RebaseStatus.UP_TO_DATE,
        newHead: headCommit,
      };
    }

    // Build todo list
    const todoSteps: RebaseTodoLine[] = [];
    for (const commitId of commitsToRebase) {
      const commit = await this.commits.load(commitId);
      if (!commit) continue;
      const shortMessage = commit.message.split("\n")[0].substring(0, 50);
      todoSteps.push({
        action: RebaseAction.PICK,
        commit: commitId.substring(0, 7),
        shortMessage,
      });
    }

    // Let interactive handler modify steps
    if (this.interactiveHandler) {
      this.interactiveHandler.prepareSteps(todoSteps);
    }

    // Save rebase state
    const state: RebaseState = {
      headName,
      originalHead: headCommit,
      onto: this.upstreamCommit,
      ontoName: this.upstreamCommitName ?? this.upstreamCommit,
      todoSteps,
      doneSteps: [],
      inProgress: true,
    };
    RebaseCommand.rebaseStates.set(this._workingCopy, state);

    // Reset HEAD to onto
    await this.updateHead(headName, this.upstreamCommit);

    // Process steps
    return this.processSteps(state, commitsToRebase);
  }

  /**
   * Process the rebase steps (cherry-pick each commit).
   */
  private async processSteps(
    state: RebaseState,
    commitsToRebase: ObjectId[],
  ): Promise<RebaseResult> {
    let newHead = state.onto;

    for (let i = 0; i < state.todoSteps.length; i++) {
      const step = state.todoSteps[i];

      if (step.action === RebaseAction.COMMENT) {
        continue;
      }

      // Find the full commit ID
      const commitId = commitsToRebase.find((c) => c.startsWith(step.commit));
      if (!commitId) {
        throw new CommitNotFoundError(step.commit);
      }

      // Cherry-pick the commit
      const result = await this.cherryPickCommit(commitId, newHead, state);

      if (result.status === RebaseStatus.STOPPED) {
        state.currentCommit = commitId;
        state.doneSteps = state.todoSteps.slice(0, i);
        state.todoSteps = state.todoSteps.slice(i);
        return result;
      }

      if (result.newHead) {
        newHead = result.newHead;
      }

      // Handle EDIT action - stop after successful pick
      if (step.action === RebaseAction.EDIT) {
        state.currentCommit = commitId;
        state.doneSteps = state.todoSteps.slice(0, i + 1);
        state.todoSteps = state.todoSteps.slice(i + 1);
        return {
          status: RebaseStatus.EDIT,
          newHead,
          currentCommit: commitId,
        };
      }

      state.doneSteps.push(step);
    }

    // Rebase complete - clean up state
    state.inProgress = false;
    RebaseCommand.rebaseStates.delete(this._workingCopy);

    // Update branch ref to point to new head
    await this.updateHead(state.headName, newHead);

    return {
      status: RebaseStatus.OK,
      newHead,
    };
  }

  /**
   * Cherry-pick a single commit.
   */
  private async cherryPickCommit(
    commitId: ObjectId,
    ontoCommit: ObjectId,
    _state: RebaseState,
  ): Promise<RebaseResult> {
    const commit = await this.commits.load(commitId);
    if (!commit) {
      throw new CommitNotFoundError(commitId);
    }

    // Skip merge commits unless preserveMerges is set
    if (commit.parents.length > 1 && !this.preserveMerges) {
      // Return success without creating a new commit
      return {
        status: RebaseStatus.OK,
        newHead: ontoCommit,
      };
    }

    // Get parent commit for diff base
    const parentId = commit.parents[0];
    if (!parentId) {
      // Root commit - just use its tree
      const newCommitId = await this.createRebasedCommit(commit, ontoCommit, commit.tree);
      return {
        status: RebaseStatus.OK,
        newHead: newCommitId,
      };
    }

    // Three-way merge: parent -> commit changes applied to onto
    const parentCommit = await this.commits.load(parentId);
    const ontoCommitObj = await this.commits.load(ontoCommit);
    if (!parentCommit || !ontoCommitObj) {
      throw new CommitNotFoundError(parentId);
    }

    // Replay this commit's changes onto `onto`: base is the commit's own
    // parent, so base->commit is exactly the change being replayed. The merge
    // is path-level; a file both sides edited conflicts even if the edits are
    // to different regions.
    const mergeResult = await mergeTreesThreeWay(
      this.trees,
      parentCommit.tree,
      commit.tree,
      ontoCommitObj.tree,
    );

    if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
      return {
        status: RebaseStatus.STOPPED,
        currentCommit: commitId,
        conflicts: mergeResult.conflicts,
      };
    }

    // Create new commit with merged tree
    const newCommitId = await this.createRebasedCommit(commit, ontoCommit, mergeResult.tree);

    return {
      status: RebaseStatus.OK,
      newHead: newCommitId,
    };
  }

  /**
   * Create a new commit preserving the original author info.
   */
  private async createRebasedCommit(
    original: {
      author: PersonIdent;
      message: string;
    },
    parentId: ObjectId,
    treeId: ObjectId,
  ): Promise<ObjectId> {
    const committer = await this.getCommitter();

    return this.commits.store({
      tree: treeId,
      parents: [parentId],
      author: original.author,
      committer,
      message: original.message,
    });
  }

  /**
   * Get default committer identity.
   */
  private async getCommitter(): Promise<PersonIdent> {
    return {
      name: "Unknown",
      email: "unknown@example.com",
      timestamp: Math.floor(Date.now() / 1000),
      tzOffset: getTimezoneOffset(),
    };
  }

  /**
   * Abort the rebase and restore original HEAD.
   */
  private async abort(): Promise<RebaseResult> {
    const state = RebaseCommand.rebaseStates.get(this._workingCopy);
    if (!state) {
      return {
        status: RebaseStatus.ABORTED,
      };
    }

    // Restore HEAD to original
    await this.updateHead(state.headName, state.originalHead);

    // Clean up state
    RebaseCommand.rebaseStates.delete(this._workingCopy);

    return {
      status: RebaseStatus.ABORTED,
      newHead: state.originalHead,
    };
  }

  /**
   * Continue rebase after conflict resolution.
   */
  private async continueRebase(): Promise<RebaseResult> {
    const state = RebaseCommand.rebaseStates.get(this._workingCopy);
    if (!state || !state.inProgress) {
      throw new NoRebaseInProgressError();
    }

    // Get current HEAD
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("HEAD cannot be resolved");
    }

    // Calculate remaining commits to process
    const remaining: ObjectId[] = [];
    for (const step of state.todoSteps) {
      if (step.action === RebaseAction.COMMENT) continue;
      // Find full commit ID from original commits
      const commitId = state.originalHead; // Simplified - would need proper tracking
      remaining.push(commitId);
    }

    return this.processSteps(state, remaining);
  }

  /**
   * Skip current commit and continue.
   */
  private async skip(): Promise<RebaseResult> {
    const state = RebaseCommand.rebaseStates.get(this._workingCopy);
    if (!state || !state.inProgress) {
      throw new NoRebaseInProgressError();
    }

    // Skip first step
    if (state.todoSteps.length > 0) {
      const skipped = state.todoSteps.shift();
      if (skipped) {
        state.doneSteps.push(skipped);
      }
    }

    state.currentCommit = undefined;

    // Calculate remaining commits
    const remaining: ObjectId[] = [];
    return this.processSteps(state, remaining);
  }

  /**
   * Calculate which commits need to be rebased.
   */
  private async calculateCommitsToRebase(head: ObjectId, upstream: ObjectId): Promise<ObjectId[]> {
    const commits: ObjectId[] = [];
    const seen = new Set<ObjectId>();

    // Get all commits reachable from upstream
    const upstreamCommits = new Set<ObjectId>();
    for await (const commitId of this.commits.walkAncestry([upstream])) {
      upstreamCommits.add(commitId);
    }

    // Walk from head and collect commits not in upstream
    for await (const commitId of this.commits.walkAncestry([head])) {
      if (upstreamCommits.has(commitId)) {
        break;
      }
      if (!seen.has(commitId)) {
        seen.add(commitId);
        commits.push(commitId);
      }
    }

    // Reverse to get oldest first
    return commits.reverse();
  }

  /**
   * Check if commit A is an ancestor of commit B.
   */
  private async isAncestor(a: ObjectId, b: ObjectId): Promise<boolean> {
    if (a === b) return true;

    for await (const commitId of this.commits.walkAncestry([b])) {
      if (commitId === a) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update HEAD and optionally the branch it points to.
   */
  private async updateHead(headName: string, commitId: ObjectId): Promise<void> {
    if (headName.startsWith("refs/")) {
      // Update the branch ref
      await this.refsStore.set(headName, commitId);
    }
    // HEAD is symbolic, so it should follow
    await this.refsStore.set("HEAD", commitId);
  }
}
