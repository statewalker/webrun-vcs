import type { WorktreeRepairReport } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { requireWorktrees } from "./worktree-support.js";

/** What {@link WorktreeRepairCommand} found and fixed. */
export interface WorktreeRepairResult {
  /** Each repair or error, in git's order. */
  reports: WorktreeRepairReport[];
  /** What git prints on stderr: `repair: <message>: <path>`, `error: <message>: <path>`. */
  messages: string[];
  /** No error was reported (git exits 0). */
  ok: boolean;
}

/**
 * Repair the links between worktrees and the repository.
 *
 * Equivalent to `git worktree repair [<path>...]`.
 *
 * @example
 * ```typescript
 * // after moving a linked worktree by hand
 * await git.worktreeRepair().addPath("../moved-wt").call();
 * ```
 *
 * For each path (default: the current worktree) the `gitdir` back-link is rewritten when
 * missing or wrong (`gitdir unreadable`, `gitdir incorrect`); a `.git` file naming another
 * copy of the repository is pointed at this one. Then every linked worktree's `.git` file
 * is rewritten when broken or not pointing back (`.git file broken`, `.git file
 * incorrect`). A worktree that cannot be located is reported as an error.
 */
export class WorktreeRepairCommand extends GitCommand<WorktreeRepairResult> {
  private paths: string[] = [];

  /** A worktree path whose back-link to check. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  async call(): Promise<WorktreeRepairResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "repair");
    let paths = this.paths;
    if (paths.length === 0) {
      const current = (await worktrees.list()).find((wt) => wt.current);
      paths = current ? [current.path] : [];
    }
    const reports = await worktrees.repair(paths);
    return {
      reports,
      messages: reports.map((r) => `${r.error ? "error" : "repair"}: ${r.message}: ${r.path}`),
      ok: reports.every((r) => !r.error),
    };
  }
}
