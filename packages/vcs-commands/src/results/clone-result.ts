import type { ObjectId } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import type { FetchResult } from "./fetch-result.js";

/**
 * Result of a clone operation.
 *
 * Based on JGit's CloneCommand result (returns Git instance).
 */
export interface CloneResult {
  /** The fetch result containing refs and pack data */
  fetchResult: FetchResult;
  /**
   * Default branch that was checked out, as a bare branch name (`main`), so
   * it can be handed straight to a branch or checkout command. The advertised
   * form is on {@link FetchResult.defaultBranch}.
   */
  defaultBranch: string;
  /** Remote name used (typically "origin") */
  remoteName: string;
  /** Whether this was a bare clone */
  bare: boolean;
  /** Head commit after clone */
  headCommit?: ObjectId;
  /**
   * Files of the checked-out tree whose paths differ only in case (`README`, `readme`),
   * on a worktree that folds case (`core.ignorecase`): only one of each group is in the
   * worktree, as with git's "the following paths have collided" warning.
   */
  collidedPaths?: string[];

  /**
   * The post-checkout hook's exit code when it failed: git's clone exits with it (the clone
   * itself stands)
   */
  hookExitCode?: number;

  /**
   * What git prints on stderr besides progress: `--reference-if-able`'s "info: Could not add
   * alternate for '<path>': <reason>" lines, each with its newline
   */
  messages?: string[];

  /**
   * The repository's working copy when the clone switched it to the remote's object format
   * (git's clone takes the hash the remote names: a SHA-256 remote makes a SHA-256
   * repository): the working copy the command was made for still names objects with the old
   * hash and must not be used any more. `Git.clone()` takes this one as its own.
   */
  workingCopy?: WorkingCopy;
}
