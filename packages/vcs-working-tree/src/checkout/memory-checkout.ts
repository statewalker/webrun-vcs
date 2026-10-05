/**
 * In-memory Checkout implementation
 *
 * Useful for:
 * - Testing
 * - Non-file-based backends
 * - Temporary checkout operations
 *
 * This implementation stores all checkout state in memory.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { Staging } from "../staging/staging.js";
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
} from "./checkout.js";

/**
 * Options for creating a MemoryCheckout
 */
export interface MemoryCheckoutOptions {
  /** Staging interface */
  staging: Staging;
  /** Initial HEAD value */
  initialHead?: HeadValue;
  /** Optional stash */
  stash?: CheckoutStash;
  /** Optional config */
  config?: CheckoutConfig;
}

/**
 * In-memory Checkout implementation
 */
export class MemoryCheckout implements Checkout {
  readonly staging: Staging;
  readonly stash?: CheckoutStash;
  readonly config?: CheckoutConfig;

  private head: HeadValue;
  private mergeState?: CheckoutMergeState;
  private rebaseState?: CheckoutRebaseState;
  private cherryPickState?: CheckoutCherryPickState;
  private revertState?: CheckoutRevertState;
  private headCommit?: ObjectId;
  private initialized = false;

  constructor(options: MemoryCheckoutOptions) {
    this.staging = options.staging;
    this.stash = options.stash;
    this.config = options.config;

    // Default to symbolic HEAD pointing to main
    this.head = options.initialHead ?? {
      type: "symbolic",
      target: "refs/heads/main",
    };
  }

  // ========== HEAD Management ==========

  async getHead(): Promise<HeadValue> {
    return this.head;
  }

  async setHead(value: HeadValue): Promise<void> {
    this.head = value;

    // Update headCommit cache for detached HEAD
    if (value.type === "detached") {
      this.headCommit = value.commitId;
    }
  }

  async getHeadCommit(): Promise<ObjectId | undefined> {
    if (this.head.type === "detached") {
      return this.head.commitId;
    }
    return this.headCommit;
  }

  async getCurrentBranch(): Promise<string | undefined> {
    if (this.head.type === "symbolic") {
      const target = this.head.target;
      if (target.startsWith("refs/heads/")) {
        return target.substring("refs/heads/".length);
      }
    }
    return undefined;
  }

  async isDetached(): Promise<boolean> {
    return this.head.type === "detached";
  }

  // ========== Operation State ==========

  async getOperationState(): Promise<CheckoutOperationState | undefined> {
    if (this.mergeState) return { type: "merge", state: this.mergeState };
    if (this.rebaseState) return { type: "rebase", state: this.rebaseState };
    if (this.cherryPickState) return { type: "cherry-pick", state: this.cherryPickState };
    if (this.revertState) return { type: "revert", state: this.revertState };
    return undefined;
  }

  async hasOperationInProgress(): Promise<boolean> {
    return (
      this.mergeState !== undefined ||
      this.rebaseState !== undefined ||
      this.cherryPickState !== undefined ||
      this.revertState !== undefined
    );
  }

  // -------- Merge --------

  async getMergeState(): Promise<CheckoutMergeState | undefined> {
    return this.mergeState;
  }

  async setMergeState(state: CheckoutMergeState | null): Promise<void> {
    this.mergeState = state ?? undefined;
  }

  async getMergeHead(): Promise<ObjectId | undefined> {
    return this.mergeState?.mergeHead;
  }

  // -------- Rebase --------

  async getRebaseState(): Promise<CheckoutRebaseState | undefined> {
    return this.rebaseState;
  }

  async setRebaseState(state: CheckoutRebaseState | null): Promise<void> {
    this.rebaseState = state ?? undefined;
  }

  // -------- Cherry-pick --------

  async getCherryPickState(): Promise<CheckoutCherryPickState | undefined> {
    return this.cherryPickState;
  }

  async setCherryPickState(state: CheckoutCherryPickState | null): Promise<void> {
    this.cherryPickState = state ?? undefined;
  }

  // -------- Revert --------

  async getRevertState(): Promise<CheckoutRevertState | undefined> {
    return this.revertState;
  }

  async setRevertState(state: CheckoutRevertState | null): Promise<void> {
    this.revertState = state ?? undefined;
  }

  // -------- Abort --------

  async abortOperation(): Promise<void> {
    this.mergeState = undefined;
    this.rebaseState = undefined;
    this.cherryPickState = undefined;
    this.revertState = undefined;

    // Clear staging conflicts
    if (await this.staging.hasConflicts()) {
      await this.staging.clear();
    }
  }

  // ========== Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.staging.read();
    this.initialized = true;
  }

  async refresh(): Promise<void> {
    await this.staging.read();
  }

  async close(): Promise<void> {
    await this.staging.write();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ========== Test Helpers ==========

  /**
   * Set the HEAD commit directly (for testing)
   */
  _setHeadCommit(commitId: ObjectId | undefined): void {
    this.headCommit = commitId;
  }
}

/**
 * Factory function to create a MemoryCheckout
 */
export function createMemoryCheckout(options: MemoryCheckoutOptions): Checkout {
  return new MemoryCheckout(options);
}
