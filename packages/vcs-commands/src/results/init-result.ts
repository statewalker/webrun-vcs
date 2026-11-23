import type { History } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import type { Git } from "../git.js";

/**
 * Result of repository initialization.
 *
 * Based on JGit's InitCommand result (returns Git instance).
 */
export interface InitResult {
  /** Git facade for command execution */
  git: Git;

  /** WorkingCopy for direct repository access */
  workingCopy: WorkingCopy;

  /** The underlying History (repository) */
  repository: History;

  /** Initial branch name */
  initialBranch: string;

  /**
   * git's `advice.defaultBranchName` hint (stderr lines), when the branch is the built-in
   * default: no `--initial-branch`, no `init.defaultBranch`, the advice not turned off
   */
  hints?: string[];

  /** git's warnings (stderr lines): `re-init: ignored --initial-branch=<name>` */
  warnings?: string[];

  /** Whether this is a bare repository */
  bare: boolean;

  /** Path to the .git directory */
  gitDir: string;
}
