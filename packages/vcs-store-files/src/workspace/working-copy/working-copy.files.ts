/**
 * File-based WorkingCopy implementation.
 *
 * Manages local checkout state for a Git working directory.
 *
 * This implementation delegates to the new Three-Part Architecture:
 * - History: Immutable repository objects
 * - Checkout: Mutable local state (HEAD, staging, operations)
 * - Worktree: Filesystem access
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import type {
  Checkout,
  CherryPickState,
  MergeState,
  RebaseState,
  RevertState,
  Staging,
  StashStore,
  WorkingCopy,
  WorkingCopyConfig,
  Worktree,
} from "@statewalker/vcs-working-tree";
import {
  createStatusCalculator,
  getStateCapabilities,
  type RepositoryStateValue,
  type RepositoryStatus,
  type StateCapabilities,
  type StatusOptions,
} from "@statewalker/vcs-working-tree";
import type { CherryPickStateFilesApi } from "./cherry-pick-state-reader.js";
import type { MergeStateFilesApi } from "./merge-state-reader.js";
import type { RebaseStateFilesApi } from "./rebase-state-reader.js";
import { detectRepositoryState, type StateDetectorFilesApi } from "./repository-state-detector.js";
import type { RevertStateFilesApi } from "./revert-state-reader.js";

/**
 * Files API subset needed for GitWorkingCopy state detection
 */
export interface WorkingCopyFilesApi
  extends StateDetectorFilesApi,
    MergeStateFilesApi,
    RebaseStateFilesApi,
    CherryPickStateFilesApi,
    RevertStateFilesApi {}

/**
 * Options for creating a GitWorkingCopy
 */
export interface GitWorkingCopyOptions {
  /** History interface */
  history: History;
  /** Checkout interface */
  checkout: Checkout;
  /** Worktree interface */
  worktree: Worktree;
  /** Stash store */
  stash: StashStore;
  /** Configuration */
  config: WorkingCopyConfig;
  /** Files API for state detection */
  files: WorkingCopyFilesApi;
  /** Git directory path */
  gitDir: string;
}

/**
 * Git-compatible WorkingCopy implementation.
 *
 * Delegates to the Three-Part Architecture:
 * - History: Immutable repository objects
 * - Checkout: Mutable local state (HEAD, staging, operations)
 * - Worktree: Filesystem access
 */
export class GitWorkingCopy implements WorkingCopy {
  readonly history: History;
  readonly checkout: Checkout;
  readonly worktree: Worktree;
  readonly stash: StashStore;
  readonly config: WorkingCopyConfig;

  private readonly files: WorkingCopyFilesApi;
  private readonly gitDir: string;

  constructor(options: GitWorkingCopyOptions) {
    this.history = options.history;
    this.checkout = options.checkout;
    this.worktree = options.worktree;
    this.stash = options.stash;
    this.config = options.config;
    this.files = options.files;
    this.gitDir = options.gitDir;
  }

  /**
   * Staging area - delegates to checkout.staging
   */
  get staging(): Staging {
    return this.checkout.staging;
  }

  /**
   * Get current HEAD commit ID.
   */
  async getHead(): Promise<ObjectId | undefined> {
    return this.checkout.getHeadCommit();
  }

  /**
   * Get current branch name.
   * Returns undefined if HEAD is detached.
   */
  async getCurrentBranch(): Promise<string | undefined> {
    return this.checkout.getCurrentBranch();
  }

  /**
   * Set HEAD to a branch or commit.
   */
  async setHead(target: ObjectId | string): Promise<void> {
    const isBranch = target.startsWith("refs/") || !target.match(/^[0-9a-f]{40,64}$/);

    if (isBranch) {
      const ref = target.startsWith("refs/") ? target : `refs/heads/${target}`;
      await this.checkout.setHead({ type: "symbolic", target: ref });
    } else {
      await this.checkout.setHead({ type: "detached", commitId: target });
    }
  }

  /**
   * Check if HEAD is detached (pointing directly to commit, not branch).
   */
  async isDetachedHead(): Promise<boolean> {
    return this.checkout.isDetached();
  }

  /**
   * Get merge state if a merge is in progress.
   */
  async getMergeState(): Promise<MergeState | undefined> {
    const state = await this.checkout.getMergeState();
    if (!state) return undefined;
    return {
      mergeHead: state.mergeHead,
      origHead: state.originalHead ?? state.mergeHead,
      message: state.message,
      squash: state.squash,
    };
  }

  /**
   * Get rebase state if a rebase is in progress.
   */
  async getRebaseState(): Promise<RebaseState | undefined> {
    const state = await this.checkout.getRebaseState();
    if (!state) return undefined;
    return {
      type: state.type === "merge" ? "rebase-merge" : "rebase-apply",
      onto: state.onto,
      head: state.originalHead,
      current: state.currentIndex,
      total: state.totalCommits,
    };
  }

  /**
   * Get cherry-pick state if a cherry-pick is in progress.
   */
  async getCherryPickState(): Promise<CherryPickState | undefined> {
    const state = await this.checkout.getCherryPickState();
    if (!state) return undefined;
    return {
      cherryPickHead: state.commits[state.currentIndex] ?? state.originalHead,
    };
  }

  /**
   * Get revert state if a revert is in progress.
   */
  async getRevertState(): Promise<RevertState | undefined> {
    const state = await this.checkout.getRevertState();
    if (!state) return undefined;
    return {
      revertHead: state.commits[state.currentIndex] ?? state.originalHead,
    };
  }

  /**
   * Check if any operation is in progress (merge, rebase, cherry-pick, etc.).
   */
  async hasOperationInProgress(): Promise<boolean> {
    return this.checkout.hasOperationInProgress();
  }

  /**
   * Get current repository state.
   *
   * Detects in-progress operations like merge, rebase, cherry-pick, etc.
   */
  async getState(): Promise<RepositoryStateValue> {
    const hasConflicts = await this.staging.hasConflicts();
    return detectRepositoryState(this.files, this.gitDir, hasConflicts);
  }

  /**
   * Get capability queries for current state.
   *
   * Determines what operations are allowed in the current state.
   */
  async getStateCapabilities(): Promise<StateCapabilities> {
    const state = await this.getState();
    return getStateCapabilities(state);
  }

  /**
   * Calculate full repository status.
   *
   * Compares HEAD, staging area, and working tree.
   */
  async getStatus(options?: StatusOptions): Promise<RepositoryStatus> {
    const calculator = createStatusCalculator({
      worktree: this.worktree,
      staging: this.checkout.staging,
      // Cast new interfaces to old ones for compatibility with createStatusCalculator
      // TODO: Update createStatusCalculator to use new interfaces
      trees: this.history.trees as any,
      commits: this.history.commits as any,
      refs: this.history.refs as any,
      blobs: this.history.blobs as any,
    });
    return calculator.calculateStatus(options);
  }

  /**
   * Refresh working copy state from storage.
   */
  async refresh(): Promise<void> {
    await this.checkout.refresh();
  }

  /**
   * Close working copy and release resources.
   */
  async close(): Promise<void> {
    await this.checkout.close();
    await this.history.close();
  }
}
