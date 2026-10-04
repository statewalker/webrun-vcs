/**
 * Unified store for all transformation operations.
 *
 * Provides a single interface for managing merge, rebase, cherry-pick,
 * and revert operations, with detection of which operation is in progress.
 */

import type { Blobs } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { Staging } from "@statewalker/vcs-working-tree";
import type {
  ResolutionStore,
  TransformationCapabilities,
  TransformationState,
} from "@statewalker/vcs-working-tree/transformation";
import type { CherryPickStateStore } from "./cherry-pick-state-store.js";
import { GitCherryPickStateStore } from "./cherry-pick-state-store.js";
import type { MergeStateStore } from "./merge-state-store.js";
import { GitMergeStateStore } from "./merge-state-store.js";
import type { RebaseStateStore } from "./rebase-state-store.js";
import { GitRebaseStateStore } from "./rebase-state-store.js";
import { GitResolutionStore } from "./resolution-store.impl.js";
import type { RevertStateStore } from "./revert-state-store.js";
import { GitRevertStateStore } from "./revert-state-store.js";
import type { SequencerStore } from "./sequencer-store.js";
import { GitSequencerStore } from "./sequencer-store.js";

/**
 * Unified store for all transformation operations
 *
 * Provides a single interface for managing merge, rebase, cherry-pick,
 * and revert operations, with detection of which operation is in progress.
 */
export interface TransformationStore {
  /** Merge state operations */
  readonly merge: MergeStateStore;

  /** Rebase state operations */
  readonly rebase: RebaseStateStore;

  /** Cherry-pick state operations */
  readonly cherryPick: CherryPickStateStore;

  /** Revert state operations */
  readonly revert: RevertStateStore;

  /** Sequencer for multi-commit operations */
  readonly sequencer: SequencerStore;

  /**
   * Resolution store for conflict management (optional)
   *
   * Available when TransformationStore is created with staging and blobs.
   * Provides conflict detection, resolution workflow, and rerere functionality.
   */
  readonly resolution?: ResolutionStore;

  /**
   * Get current transformation state (if any)
   *
   * Detection priority:
   * 1. Rebase (most restrictive)
   * 2. Merge
   * 3. Cherry-pick
   * 4. Revert
   */
  getState(): Promise<TransformationState | undefined>;

  /**
   * Get capabilities for current state
   */
  getCapabilities(): Promise<TransformationCapabilities>;

  /**
   * Check if any operation is in progress
   */
  hasOperationInProgress(): Promise<boolean>;

  /**
   * Abort current operation (whatever it is)
   */
  abortCurrent(): Promise<void>;
}

/**
 * Configuration for creating TransformationStore with resolution support
 */
export interface TransformationStoreConfig {
  /** FilesApi implementation */
  files: FilesApi;
  /** Path to .git directory */
  gitDir: string;
  /** Staging interface for conflict detection (required for resolution) */
  staging?: Staging;
  /** Blobs interface for content storage (required for resolution) */
  blobs?: Blobs;
  /** Path to working tree (defaults to parent of gitDir) */
  worktreePath?: string;
}

/**
 * Git file-based TransformationStore implementation
 */
export class GitTransformationStore implements TransformationStore {
  readonly merge: MergeStateStore;
  readonly rebase: RebaseStateStore;
  readonly cherryPick: CherryPickStateStore;
  readonly revert: RevertStateStore;
  readonly sequencer: SequencerStore;
  readonly resolution?: ResolutionStore;

  /**
   * Create a TransformationStore
   *
   * @param files FilesApi implementation
   * @param gitDir Path to .git directory
   */
  constructor(files: FilesApi, gitDir: string);
  /**
   * Create a TransformationStore with resolution support
   *
   * @param config Configuration object with all dependencies
   */
  constructor(config: TransformationStoreConfig);
  constructor(filesOrConfig: FilesApi | TransformationStoreConfig, gitDir?: string) {
    let files: FilesApi;
    let dir: string;
    let staging: Staging | undefined;
    let blobs: Blobs | undefined;
    let worktreePath: string | undefined;

    if (typeof filesOrConfig === "object" && "gitDir" in filesOrConfig) {
      // Config object
      files = filesOrConfig.files;
      dir = filesOrConfig.gitDir;
      staging = filesOrConfig.staging;
      blobs = filesOrConfig.blobs;
      worktreePath = filesOrConfig.worktreePath;
    } else {
      // Legacy signature
      files = filesOrConfig as FilesApi;
      if (!gitDir) {
        throw new Error("gitDir is required when using legacy constructor signature");
      }
      dir = gitDir;
    }

    this.merge = new GitMergeStateStore(files, dir);
    this.rebase = new GitRebaseStateStore(files, dir);
    this.cherryPick = new GitCherryPickStateStore(files, dir);
    this.revert = new GitRevertStateStore(files, dir);
    this.sequencer = new GitSequencerStore(files, dir);

    // Create resolution store if dependencies are provided
    if (staging && blobs) {
      this.resolution = new GitResolutionStore(files, staging, blobs, dir, worktreePath);
    }
  }

  async getState(): Promise<TransformationState | undefined> {
    // Check in priority order

    // 1. Rebase (most restrictive)
    const rebaseState = await this.rebase.read();
    if (rebaseState) return rebaseState;

    // 2. Merge
    const mergeState = await this.merge.read();
    if (mergeState) return mergeState;

    // 3. Cherry-pick
    const cherryPickState = await this.cherryPick.read();
    if (cherryPickState) return cherryPickState;

    // 4. Revert
    const revertState = await this.revert.read();
    if (revertState) return revertState;

    return undefined;
  }

  async getCapabilities(): Promise<TransformationCapabilities> {
    const state = await this.getState();

    if (!state) {
      return {
        canContinue: false,
        canSkip: false,
        canAbort: false,
        canQuit: false,
        hasConflicts: false,
      };
    }

    // Check actual conflict status if resolution store is available
    // Otherwise assume conflicts exist (conservative default)
    const hasConflicts = this.resolution ? await this.resolution.hasConflicts() : true;

    // Base capabilities depend on operation type
    // canContinue means the operation supports --continue flag
    // hasConflicts indicates if conflicts need to be resolved
    switch (state.type) {
      case "merge":
        return {
          canContinue: true,
          canSkip: false,
          canAbort: true,
          canQuit: false,
          hasConflicts,
        };

      case "rebase":
        return {
          canContinue: true,
          canSkip: true,
          canAbort: true,
          canQuit: state.interactive,
          hasConflicts,
        };

      case "cherry-pick":
      case "revert": {
        const hasSequencer = await this.sequencer.isInProgress();
        return {
          canContinue: true,
          canSkip: hasSequencer,
          canAbort: true,
          canQuit: hasSequencer,
          hasConflicts,
        };
      }
    }
  }

  async hasOperationInProgress(): Promise<boolean> {
    return (
      (await this.rebase.isInProgress()) ||
      (await this.merge.isInProgress()) ||
      (await this.cherryPick.isInProgress()) ||
      (await this.revert.isInProgress())
    );
  }

  async abortCurrent(): Promise<void> {
    const state = await this.getState();
    if (!state) return;

    switch (state.type) {
      case "merge":
        await this.merge.abort();
        break;
      case "rebase":
        await this.rebase.abort();
        break;
      case "cherry-pick":
        await this.cherryPick.abort();
        await this.sequencer.abort();
        break;
      case "revert":
        await this.revert.abort();
        await this.sequencer.abort();
        break;
    }
  }
}

/**
 * Factory function for creating TransformationStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createTransformationStore(files: FilesApi, gitDir: string): TransformationStore;
/**
 * Factory function for creating TransformationStore with resolution support
 *
 * @param config Configuration object with all dependencies
 */
export function createTransformationStore(config: TransformationStoreConfig): TransformationStore;
export function createTransformationStore(
  filesOrConfig: FilesApi | TransformationStoreConfig,
  gitDir?: string,
): TransformationStore {
  if (typeof filesOrConfig === "object" && "gitDir" in filesOrConfig) {
    return new GitTransformationStore(filesOrConfig);
  }
  if (!gitDir) {
    throw new Error("gitDir is required when using legacy function signature");
  }
  return new GitTransformationStore(filesOrConfig as FilesApi, gitDir);
}
