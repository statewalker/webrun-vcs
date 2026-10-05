/**
 * Git file-based Checkout implementation
 *
 * Implements the new Checkout interface using standard Git state files:
 * - HEAD: Current branch/commit
 * - MERGE_HEAD: Merge in progress
 * - rebase-merge/ or rebase-apply/: Rebase state
 * - CHERRY_PICK_HEAD: Cherry-pick in progress
 * - REVERT_HEAD: Revert in progress
 */

import type { ObjectId, Refs } from "@statewalker/vcs-core";
import type {
  Checkout,
  CheckoutCherryPickState,
  CheckoutConfig,
  CheckoutMergeState,
  CheckoutOperationState,
  CheckoutRebaseState,
  CheckoutRevertState,
  CheckoutStash,
  HeadValue,
  Staging,
} from "@statewalker/vcs-working-tree";
import {
  type CherryPickStateFilesApi,
  readCherryPickState,
} from "../working-copy/cherry-pick-state-reader.js";
import { type MergeStateFilesApi, readMergeState } from "../working-copy/merge-state-reader.js";
import { type RebaseStateFilesApi, readRebaseState } from "../working-copy/rebase-state-reader.js";
import { type RevertStateFilesApi, readRevertState } from "../working-copy/revert-state-reader.js";

/**
 * Files API subset needed for GitCheckout
 */
export interface GitCheckoutFilesApi
  extends MergeStateFilesApi,
    RebaseStateFilesApi,
    CherryPickStateFilesApi,
    RevertStateFilesApi {
  /**
   * Write content to a file
   */
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  /**
   * Create directory
   */
  mkdir?(path: string): Promise<void>;
  /**
   * Remove a file
   */
  remove?(path: string): Promise<void>;
  /**
   * Remove a directory recursively
   */
  removeDir?(path: string): Promise<void>;
}

/**
 * Options for creating a GitCheckout
 */
export interface GitCheckoutOptions {
  /** Staging interface */
  staging: Staging;
  /** Refs interface for HEAD management */
  refs: Refs;
  /** Files API for reading/writing state files */
  files: GitCheckoutFilesApi;
  /** Path to .git directory */
  gitDir: string;
  /** Optional stash */
  stash?: CheckoutStash;
  /** Optional config */
  config?: CheckoutConfig;
}

/**
 * Git file-based Checkout implementation
 */
export class GitCheckout implements Checkout {
  readonly staging: Staging;
  readonly stash?: CheckoutStash;
  readonly config?: CheckoutConfig;

  private readonly refs: Refs;
  private readonly files: GitCheckoutFilesApi;
  private readonly gitDir: string;
  private initialized = false;

  constructor(options: GitCheckoutOptions) {
    this.staging = options.staging;
    this.refs = options.refs;
    this.files = options.files;
    this.gitDir = options.gitDir;
    this.stash = options.stash;
    this.config = options.config;
  }

  // ========== HEAD Management ==========

  async getHead(): Promise<HeadValue> {
    const headRef = await this.refs.get("HEAD");

    if (!headRef) {
      // No HEAD - should not happen in a valid repository
      throw new Error("HEAD not found");
    }

    if ("target" in headRef) {
      // Symbolic reference
      return { type: "symbolic", target: headRef.target };
    }

    // Direct reference (detached HEAD)
    if (!headRef.objectId) {
      throw new Error("HEAD is detached but has no commit ID");
    }
    return { type: "detached", commitId: headRef.objectId };
  }

  async setHead(value: HeadValue): Promise<void> {
    if (value.type === "symbolic") {
      await this.refs.setSymbolic("HEAD", value.target);
    } else {
      await this.refs.set("HEAD", value.commitId);
    }
  }

  async getHeadCommit(): Promise<ObjectId | undefined> {
    const resolved = await this.refs.resolve("HEAD");
    return resolved?.objectId;
  }

  async getCurrentBranch(): Promise<string | undefined> {
    const headRef = await this.refs.get("HEAD");
    if (headRef && "target" in headRef) {
      const target = headRef.target;
      if (target.startsWith("refs/heads/")) {
        return target.substring("refs/heads/".length);
      }
    }
    return undefined;
  }

  async isDetached(): Promise<boolean> {
    const headRef = await this.refs.get("HEAD");
    return headRef !== undefined && !("target" in headRef);
  }

  // ========== Operation State ==========

  async getOperationState(): Promise<CheckoutOperationState | undefined> {
    const merge = await this.getMergeState();
    if (merge) return { type: "merge", state: merge };

    const rebase = await this.getRebaseState();
    if (rebase) return { type: "rebase", state: rebase };

    const cherryPick = await this.getCherryPickState();
    if (cherryPick) return { type: "cherry-pick", state: cherryPick };

    const revert = await this.getRevertState();
    if (revert) return { type: "revert", state: revert };

    return undefined;
  }

  async hasOperationInProgress(): Promise<boolean> {
    return (await this.getOperationState()) !== undefined;
  }

  // -------- Merge --------

  async getMergeState(): Promise<CheckoutMergeState | undefined> {
    const state = await readMergeState(this.files, this.gitDir);
    if (!state) return undefined;

    return {
      mergeHead: state.mergeHead,
      originalHead: state.origHead,
      message: state.message,
      squash: state.squash,
    };
  }

  async setMergeState(state: CheckoutMergeState | null): Promise<void> {
    if (state === null) {
      // Clear merge state
      await this.removeFile(`${this.gitDir}/MERGE_HEAD`);
      await this.removeFile(`${this.gitDir}/MERGE_MSG`);
      await this.removeFile(`${this.gitDir}/MERGE_MODE`);
    } else {
      // Write merge state files
      await this.writeFile(`${this.gitDir}/MERGE_HEAD`, `${state.mergeHead}\n`);
      if (state.message) {
        await this.writeFile(`${this.gitDir}/MERGE_MSG`, state.message);
      }
      if (state.squash) {
        await this.writeFile(`${this.gitDir}/MERGE_MODE`, "");
      }
    }
  }

  async getMergeHead(): Promise<ObjectId | undefined> {
    const state = await this.getMergeState();
    return state?.mergeHead;
  }

  // -------- Rebase --------

  async getRebaseState(): Promise<CheckoutRebaseState | undefined> {
    const state = await readRebaseState(this.files, this.gitDir);
    if (!state) return undefined;

    return {
      type: state.type === "rebase-merge" ? "merge" : "apply",
      currentCommit: undefined, // Not directly available from reader
      onto: state.onto,
      originalBranch: undefined, // Would need to read head-name file
      originalHead: state.head,
      totalCommits: state.total,
      currentIndex: state.current,
      commits: [], // Would need to read todo file
    };
  }

  async setRebaseState(state: CheckoutRebaseState | null): Promise<void> {
    if (state === null) {
      // Clear rebase state
      await this.removeDir(`${this.gitDir}/rebase-merge`);
      await this.removeDir(`${this.gitDir}/rebase-apply`);
    } else {
      // Writing rebase state is complex - typically managed by git rebase command
      const dir = state.type === "merge" ? "rebase-merge" : "rebase-apply";
      const rebaseDir = `${this.gitDir}/${dir}`;

      await this.mkdir(rebaseDir);
      await this.writeFile(`${rebaseDir}/onto`, state.onto);
      await this.writeFile(`${rebaseDir}/orig-head`, state.originalHead);
      await this.writeFile(`${rebaseDir}/msgnum`, String(state.currentIndex));
      await this.writeFile(`${rebaseDir}/end`, String(state.totalCommits));

      if (state.originalBranch) {
        await this.writeFile(`${rebaseDir}/head-name`, `refs/heads/${state.originalBranch}`);
      }
    }
  }

  // -------- Cherry-pick --------

  async getCherryPickState(): Promise<CheckoutCherryPickState | undefined> {
    const state = await readCherryPickState(this.files, this.gitDir);
    if (!state) return undefined;

    const origHead = await this.getOrigHead();

    return {
      commits: [state.cherryPickHead],
      currentIndex: 0,
      originalHead: origHead ?? state.cherryPickHead, // Fallback
    };
  }

  async setCherryPickState(state: CheckoutCherryPickState | null): Promise<void> {
    if (state === null) {
      await this.removeFile(`${this.gitDir}/CHERRY_PICK_HEAD`);
    } else {
      const currentCommit = state.commits[state.currentIndex];
      if (currentCommit) {
        await this.writeFile(`${this.gitDir}/CHERRY_PICK_HEAD`, `${currentCommit}\n`);
      }
    }
  }

  // -------- Revert --------

  async getRevertState(): Promise<CheckoutRevertState | undefined> {
    const state = await readRevertState(this.files, this.gitDir);
    if (!state) return undefined;

    const origHead = await this.getOrigHead();

    return {
      commits: [state.revertHead],
      currentIndex: 0,
      originalHead: origHead ?? state.revertHead, // Fallback
    };
  }

  async setRevertState(state: CheckoutRevertState | null): Promise<void> {
    if (state === null) {
      await this.removeFile(`${this.gitDir}/REVERT_HEAD`);
    } else {
      const currentCommit = state.commits[state.currentIndex];
      if (currentCommit) {
        await this.writeFile(`${this.gitDir}/REVERT_HEAD`, `${currentCommit}\n`);
      }
    }
  }

  // -------- Abort --------

  async abortOperation(): Promise<void> {
    const state = await this.getOperationState();
    if (!state) return;

    switch (state.type) {
      case "merge":
        await this.setMergeState(null);
        break;
      case "rebase":
        await this.setRebaseState(null);
        break;
      case "cherry-pick":
        await this.setCherryPickState(null);
        break;
      case "revert":
        await this.setRevertState(null);
        break;
    }

    // Clear staging if conflicts exist
    if (await this.staging.hasConflicts()) {
      await this.staging.clear();

      // Restore staging from HEAD
      const headCommit = await this.getHeadCommit();
      if (headCommit) {
        // Note: Would need access to Trees to properly restore staging
        // For now just clear - full abort would need WorkingCopy context
      }
    }
  }

  // ========== Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Read staging
    await this.staging.read();

    // Initialize refs if supported
    if (this.refs.initialize) {
      await this.refs.initialize();
    }

    this.initialized = true;
  }

  async refresh(): Promise<void> {
    await this.staging.read();
  }

  async close(): Promise<void> {
    // Write any pending staging changes
    await this.staging.write();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ========== Internal Helpers ==========

  private async getOrigHead(): Promise<ObjectId | undefined> {
    try {
      const content = await this.readFile(`${this.gitDir}/ORIG_HEAD`);
      return content?.trim();
    } catch {
      return undefined;
    }
  }

  private async readFile(path: string): Promise<string | undefined> {
    try {
      const content = await this.files.read(path);
      if (!content) return undefined;
      return new TextDecoder().decode(content);
    } catch {
      return undefined;
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const encoder = new TextEncoder();
    await this.files.write(path, [encoder.encode(content)]);
  }

  private async removeFile(path: string): Promise<void> {
    if (this.files.remove) {
      try {
        await this.files.remove(path);
      } catch {
        // Ignore if file doesn't exist
      }
    }
  }

  private async removeDir(path: string): Promise<void> {
    if (this.files.removeDir) {
      try {
        await this.files.removeDir(path);
      } catch {
        // Ignore if directory doesn't exist
      }
    }
  }

  private async mkdir(path: string): Promise<void> {
    if ("mkdir" in this.files && typeof this.files.mkdir === "function") {
      await this.files.mkdir(path);
    }
  }
}

/**
 * Factory function to create a GitCheckout
 */
export function createGitCheckout(options: GitCheckoutOptions): Checkout {
  return new GitCheckout(options);
}
