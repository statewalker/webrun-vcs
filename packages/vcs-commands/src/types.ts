/**
 * Reset mode for ResetCommand.
 *
 * Based on JGit's ResetCommand.ResetType enum.
 */
export enum ResetMode {
  /** Move HEAD only */
  SOFT = "soft",
  /** Move HEAD and reset staging (default) */
  MIXED = "mixed",
  /** Move HEAD, reset staging, and reset working tree */
  HARD = "hard",
  /** Keep local changes if they're not in the way */
  KEEP = "keep",
  /** Like --hard but preserves untracked files */
  MERGE = "merge",
}

/**
 * Branch listing mode for ListBranchCommand.
 *
 * Based on JGit's ListBranchCommand.ListMode enum.
 */
export enum ListBranchMode {
  /** List local branches only (refs/heads/) */
  LOCAL = "local",
  /** List remote tracking branches only (refs/remotes/) */
  REMOTE = "remote",
  /** List both local and remote branches */
  ALL = "all",
}

// ============ Core Type Re-exports ============

/**
 * Re-export WorkingCopy and related types from core for convenience.
 *
 * @example
 * ```typescript
 * import { WorkingCopy, History, Checkout, Worktree, Blobs, Trees, Commits } from "@statewalker/vcs-commands";
 *
 * // Or import directly from core:
 * import { WorkingCopy } from "@statewalker/vcs-working-tree";
 * ```
 */
export type {
  /** Blobs interface - file content storage */
  Blobs,
  /** Commits interface - commit object storage */
  Commits,
  /** History interface - immutable repository objects */
  History,
  /** Refs interface - branch and tag references */
  Refs,
  /** Tags interface - annotated tag storage */
  Tags,
  /** Trees interface - directory structure storage */
  Trees,
} from "@statewalker/vcs-core";
// Working-tree symbols were relocated out of vcs-core into vcs-working-tree.
export type {
  /** Checkout interface - mutable local state */
  Checkout,
  /** Staging interface - index/staging area */
  Staging,
  /** WorkingCopy interface - unified repository access */
  WorkingCopy,
  /** Worktree interface - filesystem access */
  Worktree,
} from "@statewalker/vcs-working-tree";
