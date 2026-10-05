/**
 * Core types for transformation operations (merge, rebase, cherry-pick, revert).
 *
 * These types define the state management interfaces for multi-step operations
 * that can be interrupted and resumed, supporting crash recovery.
 */

import type { ObjectId } from "@statewalker/vcs-core";

// === Base Types ===

/**
 * Operation types that can be in progress
 */
export type OperationType = "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * Rebase variants
 */
export type RebaseType = "rebase" | "rebase-merge" | "rebase-apply" | "rebase-interactive";

/**
 * Base interface for all operation states
 */
export interface OperationState {
  /** Type of operation */
  readonly type: OperationType;

  /** When the operation started */
  readonly startedAt: Date;

  /** Original HEAD before operation */
  readonly origHead: ObjectId;

  /** Optional message for the operation */
  readonly message?: string;
}

// === Merge State ===

/**
 * State for merge operation in progress
 */
export interface MergeState extends OperationState {
  readonly type: "merge";

  /** Commit being merged */
  readonly mergeHead: ObjectId;

  /** Whether this is a squash merge */
  readonly squash: boolean;

  /** Whether fast-forward is allowed */
  readonly noFastForward: boolean;

  /** Merge strategy being used */
  readonly strategy?: string;
}

// === Rebase State ===

/**
 * State for rebase operation in progress
 */
export interface RebaseState extends OperationState {
  readonly type: "rebase";

  /** Rebase variant */
  readonly rebaseType: RebaseType;

  /** Branch being rebased (or HEAD if detached) */
  readonly headName: string;

  /** Commit to rebase onto */
  readonly onto: ObjectId;

  /** Upstream commit (for calculating todo list) */
  readonly upstream?: ObjectId;

  /** Current step number (1-indexed) */
  readonly currentStep: number;

  /** Total number of steps */
  readonly totalSteps: number;

  /** Current commit being applied */
  readonly currentCommit?: ObjectId;

  /** Whether this is an interactive rebase */
  readonly interactive: boolean;

  /** Todo list for remaining commits */
  readonly todoList?: RebaseTodoItem[];
}

/**
 * Single item in rebase todo list
 */
export interface RebaseTodoItem {
  /** Action to perform */
  action: RebaseTodoAction;

  /** Commit to apply */
  commit: ObjectId;

  /** Short commit message */
  message: string;
}

/**
 * Rebase todo actions
 */
export type RebaseTodoAction =
  | "pick"
  | "reword"
  | "edit"
  | "squash"
  | "fixup"
  | "drop"
  | "exec"
  | "break"
  | "label"
  | "reset"
  | "merge";

// === Cherry-Pick State ===

/**
 * State for cherry-pick operation in progress
 */
export interface CherryPickState extends OperationState {
  readonly type: "cherry-pick";

  /** Commit being cherry-picked */
  readonly cherryPickHead: ObjectId;

  /** Whether to skip committing (--no-commit) */
  readonly noCommit: boolean;

  /** Parent number for merge commits */
  readonly mainlineParent?: number;
}

// === Revert State ===

/**
 * State for revert operation in progress
 */
export interface RevertState extends OperationState {
  readonly type: "revert";

  /** Commit being reverted */
  readonly revertHead: ObjectId;

  /** Whether to skip committing (--no-commit) */
  readonly noCommit: boolean;

  /** Parent number for merge commits */
  readonly mainlineParent?: number;
}

// === Sequencer State ===

/**
 * State for multi-commit operations (cherry-pick/revert with multiple commits)
 */
export interface SequencerState {
  /** Type of sequenced operation */
  readonly operation: "cherry-pick" | "revert";

  /** Head before sequencer started */
  readonly head: ObjectId;

  /** Remaining commits to process */
  readonly todo: SequencerTodoItem[];

  /** Completed commits */
  readonly done: SequencerTodoItem[];

  /** Current commit being processed (if any) */
  readonly current?: SequencerTodoItem;

  /** Options for the operation */
  readonly options: SequencerOptions;
}

/**
 * Item in sequencer todo/done list
 */
export interface SequencerTodoItem {
  /** Action (pick for cherry-pick, revert for revert) */
  action: "pick" | "revert";

  /** Commit to process */
  commit: ObjectId;

  /** Commit message (for reference) */
  message: string;
}

/**
 * Options for sequencer operations
 */
export interface SequencerOptions {
  /** Skip commits that result in empty changes */
  skipEmpty?: boolean;

  /** Don't commit after applying */
  noCommit?: boolean;

  /** Mainline parent for merge commits */
  mainlineParent?: number;

  /** Strategy for conflict resolution */
  strategy?: string;
}

// === Unified State ===

/**
 * Union of all operation states
 */
export type TransformationState = MergeState | RebaseState | CherryPickState | RevertState;

/**
 * Capabilities for current state (what actions are allowed)
 */
export interface TransformationCapabilities {
  /** Can continue the operation */
  canContinue: boolean;

  /** Can skip current step */
  canSkip: boolean;

  /** Can abort the operation */
  canAbort: boolean;

  /** Can quit preserving state */
  canQuit: boolean;

  /** Has conflicts that need resolution */
  hasConflicts: boolean;
}
