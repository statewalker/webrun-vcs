/**
 * In-memory WorkingCopy implementation for testing.
 *
 * Provides a fast, isolated WorkingCopy without filesystem access.
 * Useful for unit tests that need to verify WorkingCopy-dependent code
 * without dealing with actual file operations.
 *
 * This implementation delegates to the new Three-Part Architecture:
 * - History: Immutable repository objects
 * - Checkout: Mutable local state (HEAD, staging, operations)
 * - Worktree: Filesystem access
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import type { Checkout } from "../checkout/checkout.js";
import type { RepositoryStatus, StatusOptions } from "../status/index.js";
import type {
  CherryPickState,
  MergeState,
  RebaseState,
  RevertState,
  StashStore,
  WorkingCopy,
  WorkingCopyConfig,
} from "../working-copy.js";
import type { Worktree } from "../worktree/index.js";
import {
  getStateCapabilities,
  RepositoryState,
  type RepositoryStateValue,
  type StateCapabilities,
} from "./repository-state.js";
import { MemoryStashStore } from "./stash-store.memory.js";

/**
 * Options for MemoryWorkingCopy
 */
export interface MemoryWorkingCopyOptions {
  /** History interface */
  history: History;
  /** Checkout interface */
  checkout: Checkout;
  /** Worktree interface */
  worktree: Worktree;
  /** Optional stash store */
  stash?: StashStore;
  /** Optional configuration */
  config?: WorkingCopyConfig;
}

/**
 * In-memory WorkingCopy implementation.
 *
 * Stores HEAD, merge state, and rebase state in memory.
 * Provides test helpers for setting these states directly.
 */
export class MemoryWorkingCopy implements WorkingCopy {
  private headRef = "refs/heads/main";
  private headCommit: ObjectId | undefined;
  private _mergeState: MergeState | undefined;
  private _rebaseState: RebaseState | undefined;
  private _cherryPickState: CherryPickState | undefined;
  private _revertState: RevertState | undefined;
  private _repositoryState: RepositoryStateValue = RepositoryState.SAFE;

  readonly history: History;
  readonly checkout: Checkout;
  readonly worktree: Worktree;
  readonly stash: StashStore;
  readonly config: WorkingCopyConfig;

  constructor(options: MemoryWorkingCopyOptions) {
    this.history = options.history;
    this.checkout = options.checkout;
    this.worktree = options.worktree;
    this.stash = options.stash ?? new MemoryStashStore();
    this.config = options.config ?? {};
  }

  /**
   * Staging area - delegates to checkout.staging
   */
  get staging() {
    return this.checkout.staging;
  }

  /**
   * Get current HEAD commit ID.
   * Falls back to resolving HEAD from repository refs if not set locally.
   */
  async getHead(): Promise<ObjectId | undefined> {
    if (this.headCommit) {
      return this.headCommit;
    }
    // Try to resolve from refs
    const resolved = await this.history.refs.resolve(this.headRef);
    return resolved?.objectId;
  }

  /**
   * Get current branch name.
   * Returns undefined if HEAD is detached.
   */
  async getCurrentBranch(): Promise<string | undefined> {
    if (this.headCommit) {
      // Detached HEAD
      return undefined;
    }
    if (this.headRef.startsWith("refs/heads/")) {
      return this.headRef.substring("refs/heads/".length);
    }
    return undefined;
  }

  /**
   * Set HEAD to a branch or commit.
   */
  async setHead(target: ObjectId | string): Promise<void> {
    const isBranch = target.startsWith("refs/") || !target.match(/^[0-9a-f]{40,64}$/);

    if (isBranch) {
      const ref = target.startsWith("refs/") ? target : `refs/heads/${target}`;
      this.headRef = ref;
      this.headCommit = undefined;
    } else {
      this.headCommit = target;
    }
  }

  /**
   * Check if HEAD is detached.
   */
  async isDetachedHead(): Promise<boolean> {
    return this.headCommit !== undefined;
  }

  /**
   * Get merge state if a merge is in progress.
   */
  async getMergeState(): Promise<MergeState | undefined> {
    return this._mergeState;
  }

  /**
   * Get rebase state if a rebase is in progress.
   */
  async getRebaseState(): Promise<RebaseState | undefined> {
    return this._rebaseState;
  }

  /**
   * Get cherry-pick state if a cherry-pick is in progress.
   */
  async getCherryPickState(): Promise<CherryPickState | undefined> {
    return this._cherryPickState;
  }

  /**
   * Get revert state if a revert is in progress.
   */
  async getRevertState(): Promise<RevertState | undefined> {
    return this._revertState;
  }

  /**
   * Check if any operation is in progress.
   */
  async hasOperationInProgress(): Promise<boolean> {
    return (
      this._mergeState !== undefined ||
      this._rebaseState !== undefined ||
      this._cherryPickState !== undefined ||
      this._revertState !== undefined
    );
  }

  /**
   * Get current repository state.
   */
  async getState(): Promise<RepositoryStateValue> {
    return this._repositoryState;
  }

  /**
   * Get capability queries for current state.
   */
  async getStateCapabilities(): Promise<StateCapabilities> {
    return getStateCapabilities(this._repositoryState);
  }

  /**
   * Calculate repository status.
   * Returns a simplified status for testing.
   */
  async getStatus(_options?: StatusOptions): Promise<RepositoryStatus> {
    const hasConflicts = await this.staging.hasConflicts();

    return {
      branch: await this.getCurrentBranch(),
      head: await this.getHead(),
      files: [],
      isClean: true,
      hasStaged: false,
      hasUnstaged: false,
      hasUntracked: false,
      hasConflicts,
    };
  }

  /**
   * Refresh working copy state.
   */
  async refresh(): Promise<void> {
    await this.staging.read();
  }

  /**
   * Close working copy.
   * No-op for memory implementation.
   */
  async close(): Promise<void> {
    // No resources to release
  }

  // ============ Test Helpers ============

  /**
   * Set merge state directly (for testing).
   */
  setMergeState(state: MergeState | undefined): void {
    this._mergeState = state;
  }

  /**
   * Set rebase state directly (for testing).
   */
  setRebaseState(state: RebaseState | undefined): void {
    this._rebaseState = state;
  }

  /**
   * Set HEAD reference directly (for testing).
   */
  setHeadRef(ref: string): void {
    this.headRef = ref;
    this.headCommit = undefined;
  }

  /**
   * Set HEAD commit directly (for testing detached HEAD).
   */
  setHeadCommit(commitId: ObjectId): void {
    this.headCommit = commitId;
  }

  /**
   * Set cherry-pick state directly (for testing).
   */
  setCherryPickState(state: CherryPickState | undefined): void {
    this._cherryPickState = state;
  }

  /**
   * Set revert state directly (for testing).
   */
  setRevertState(state: RevertState | undefined): void {
    this._revertState = state;
  }

  /**
   * Set repository state directly (for testing).
   */
  setRepositoryState(state: RepositoryStateValue): void {
    this._repositoryState = state;
  }
}

/**
 * Create a MemoryWorkingCopy instance.
 */
export function createMemoryWorkingCopy(options: MemoryWorkingCopyOptions): MemoryWorkingCopy {
  return new MemoryWorkingCopy(options);
}
