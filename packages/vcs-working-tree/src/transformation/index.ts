/**
 * Transformation operations state management.
 *
 * Types and interfaces for merge, rebase, cherry-pick, and revert operations.
 * File-based implementations moved to @statewalker/vcs-store-files.
 */

// Resolution store interface
export type { ResolutionStore } from "./resolution-store.js";
// Resolution types
export type {
  ConflictEntry,
  ConflictInfo,
  ConflictStats,
  ConflictType,
  RecordedResolution,
  Resolution,
  ResolutionEvent,
  ResolutionStrategy,
} from "./resolution-types.js";
// Types
export type {
  CherryPickState,
  MergeState,
  OperationState,
  OperationType,
  RebaseState,
  RebaseTodoAction,
  RebaseTodoItem,
  RebaseType,
  RevertState,
  SequencerOptions,
  SequencerState,
  SequencerTodoItem,
  TransformationCapabilities,
  TransformationState,
} from "./types.js";
