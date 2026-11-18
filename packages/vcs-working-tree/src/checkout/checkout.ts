/**
 * Checkout - Mutable local state (Part 3 of Three-Part Architecture)
 *
 * Checkout manages:
 * - HEAD pointer (current branch/commit)
 * - Staging area
 * - In-progress operation state (merge, rebase, cherry-pick, revert)
 * - Stash (saved work-in-progress)
 * - Local configuration
 *
 * @see History for immutable repository history (Part 1)
 * @see Worktree for working directory access (Part 2)
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { Staging } from "../staging/staging.js";

/**
 * HEAD value - either symbolic (branch) or detached (commit)
 */
export type HeadValue =
  | { type: "symbolic"; target: string }
  | { type: "detached"; commitId: ObjectId };

/**
 * Merge state for the new Checkout interface.
 */
export interface CheckoutMergeState {
  /** Commit being merged */
  mergeHead: ObjectId;
  /** Original commit before merge started */
  originalHead: ObjectId;
  /** Merge message (from MERGE_MSG) */
  message?: string;
  /** Whether this is a squash merge */
  squash?: boolean;
}

/**
 * Rebase state for the new Checkout interface.
 */
export interface CheckoutRebaseState {
  /** Type of rebase */
  type: "merge" | "apply";
  /** Current commit being rebased */
  currentCommit?: ObjectId;
  /** Target branch/commit to rebase onto */
  onto: ObjectId;
  /** Original branch before rebase */
  originalBranch?: string;
  /** Original HEAD before rebase */
  originalHead: ObjectId;
  /** Total number of commits to rebase */
  totalCommits: number;
  /** Current commit index (1-based) */
  currentIndex: number;
  /** Commits to rebase */
  commits: ObjectId[];
}

/**
 * Cherry-pick state for the new Checkout interface.
 */
export interface CheckoutCherryPickState {
  /** Commits being cherry-picked */
  commits: ObjectId[];
  /** Current commit index */
  currentIndex: number;
  /** Original HEAD before cherry-pick */
  originalHead: ObjectId;
}

/**
 * Revert state for the new Checkout interface.
 */
export interface CheckoutRevertState {
  /** Commits being reverted */
  commits: ObjectId[];
  /** Current commit index */
  currentIndex: number;
  /** Original HEAD before revert */
  originalHead: ObjectId;
}

/**
 * Union type for all operation states.
 */
export type CheckoutOperationState =
  | { type: "merge"; state: CheckoutMergeState }
  | { type: "rebase"; state: CheckoutRebaseState }
  | { type: "cherry-pick"; state: CheckoutCherryPickState }
  | { type: "revert"; state: CheckoutRevertState };

/**
 * Stash interface for saved work-in-progress.
 */
export interface CheckoutStash {
  push(message?: string, includeUntracked?: boolean): Promise<ObjectId>;
  apply(entryId?: ObjectId, remove?: boolean): Promise<void>;
  drop(entryId?: ObjectId): Promise<void>;
  list(): AsyncIterable<{ id: ObjectId; message: string; timestamp: number }>;
  clear(): Promise<void>;
}

/**
 * Configuration interface for local repository settings.
 */
export interface CheckoutConfig {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<boolean>;
  list(section?: string): AsyncIterable<{ key: string; value: string }>;
}

/** What {@link Checkout.lstatStateFile} finds at a path of git's directory. */
export interface StateFileStat {
  /** A file, a directory, a symbolic link, or anything else (a FIFO, socket, device) */
  readonly kind: "file" | "directory" | "symlink" | "other";
  /** A symbolic link's target, as stored */
  readonly target?: string;
}

/**
 * Checkout interface - mutable local state
 *
 * This is the primary interface for working with checkout state.
 */
export interface Checkout {
  readonly staging: Staging;
  readonly stash?: CheckoutStash;
  readonly config?: CheckoutConfig;

  // ========== HEAD Management ==========

  getHead(): Promise<HeadValue>;
  setHead(value: HeadValue): Promise<void>;
  getHeadCommit(): Promise<ObjectId | undefined>;
  getCurrentBranch(): Promise<string | undefined>;
  isDetached(): Promise<boolean>;

  // ========== Operation State ==========

  getOperationState(): Promise<CheckoutOperationState | undefined>;
  hasOperationInProgress(): Promise<boolean>;

  // -------- Merge --------
  getMergeState(): Promise<CheckoutMergeState | undefined>;
  setMergeState(state: CheckoutMergeState | null): Promise<void>;
  getMergeHead(): Promise<ObjectId | undefined>;

  // -------- Rebase --------
  getRebaseState(): Promise<CheckoutRebaseState | undefined>;
  setRebaseState(state: CheckoutRebaseState | null): Promise<void>;

  // -------- Cherry-pick --------
  getCherryPickState(): Promise<CheckoutCherryPickState | undefined>;
  setCherryPickState(state: CheckoutCherryPickState | null): Promise<void>;

  // -------- Revert --------
  getRevertState(): Promise<CheckoutRevertState | undefined>;
  setRevertState(state: CheckoutRevertState | null): Promise<void>;

  // -------- Abort --------
  abortOperation(): Promise<void>;

  // -------- FETCH_HEAD --------
  /**
   * The refs the last fetch took (git's `FETCH_HEAD`), as git writes the file: one
   * `<oid>\t[not-for-merge]\t<description>` line per ref. Undefined when no fetch wrote it.
   * Optional: a checkout without it keeps no `FETCH_HEAD`.
   */
  readFetchHead?(): Promise<string | undefined>;
  /**
   * Replace `FETCH_HEAD` with `content` (git truncates it at the start of each fetch), or
   * add `content` after what it holds (`git fetch --append`).
   */
  writeFetchHead?(content: string, options?: { append?: boolean }): Promise<void>;

  // -------- Operation state files --------
  /**
   * A file of the repository's operation state, by its path in git's directory: `MERGE_MSG`,
   * `MERGE_MODE`, `SQUASH_MSG`, `sequencer/todo`, `rebase-merge/onto`, ... (the pseudo refs
   * `MERGE_HEAD`, `ORIG_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `AUTO_MERGE` go
   * through the ref store). Undefined when there is no such file. Optional: a checkout
   * without these keeps no state a merge, cherry-pick, revert or rebase can resume from.
   */
  readStateFile?(name: string): Promise<Uint8Array | undefined>;
  /**
   * What is at a path of git's directory (named as {@link readStateFile} names it; `..`
   * climbs out of the directory), a final symbolic link not followed (`lstat`): its kind,
   * and for a link its target as stored (`readlink`). Undefined when nothing is there.
   * Optional: a checkout without it cannot tell a link from what it points at.
   */
  lstatStateFile?(name: string): Promise<StateFileStat | undefined>;
  /** Writes a state file (as git writes them: in place, parent directories created). */
  writeStateFile?(name: string, content: Uint8Array | string): Promise<void>;
  /**
   * Appends to a state file, creating it, as git appends `rebase-merge/done` and
   * `rewritten-list` (O_APPEND: the file is not rewritten). Optional: without it a caller
   * writes the whole file.
   */
  appendStateFile?(name: string, content: Uint8Array | string): Promise<void>;
  /** Removes a state file or directory (recursively); nothing there is no error. */
  removeStateFile?(name: string): Promise<void>;
  /** The names in a state directory (e.g. `rebase-merge`), sorted; empty if there is none. */
  listStateDir?(name: string): Promise<string[]>;

  // ========== Lifecycle ==========
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
  isInitialized(): boolean;
}

/**
 * Extended Checkout interface with additional capabilities.
 */
export interface CheckoutExtended extends Checkout {
  getOrigHead?(): Promise<ObjectId | undefined>;
  setOrigHead?(commitId: ObjectId | null): Promise<void>;
  getFetchHead?(): Promise<Array<{ commitId: ObjectId; remote: string; branch: string }>>;
}
