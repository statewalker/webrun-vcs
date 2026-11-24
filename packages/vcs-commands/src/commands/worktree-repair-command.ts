import {
  WorktreeFormatUpgradeError,
  type WorktreeRepairReport,
} from "@statewalker/vcs-working-tree";

import { WorktreeError } from "../errors/index.js";

import { GitCommand } from "../git-command.js";
import { requireWorktrees, useRelativePaths } from "./worktree-support.js";

/** git's `report_repair` line. */
const reportLine = (r: WorktreeRepairReport) =>
  `${r.error ? "error" : "repair"}: ${r.message}: ${r.path}`;

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
 * Equivalent to `git worktree repair [--[no-]relative-paths] [<path>...]`.
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
 *
 * As git 2.48+, both link files are rewritten together, absolute or relative as
 * {@link setRelativePaths} (default `worktree.useRelativePaths`, false) says, and links of the
 * other kind are repaired too (`gitdir absolute/relative path mismatch`, `.git file
 * absolute/relative path mismatch`): a repair without the option turns relative links back
 * into absolute ones. Under 2.43 ({@link setCompatibility}) only the file at fault is
 * rewritten.
 */
export class WorktreeRepairCommand extends GitCommand<WorktreeRepairResult> {
  private paths: string[] = [];
  private relativePaths?: boolean;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `--[no-]relative-paths` (git 2.48+; default `worktree.useRelativePaths`). */
  setRelativePaths(relative: boolean): this {
    this.checkCallable();
    this.relativePaths = relative;
    return this;
  }

  /** The git version reproduced (default 2.56): 2.43 rewrites only the file at fault. */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

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
    const relativePaths = useRelativePaths(
      this.workingCopy,
      this.relativePaths,
      this.compatibility,
    );
    let paths = this.paths;
    if (paths.length === 0) {
      const current = (await worktrees.list()).find((wt) => wt.current);
      paths = current ? [current.path] : [];
    }
    let reports: WorktreeRepairReport[];
    try {
      reports = await worktrees.repair(
        paths,
        this.compatibility === "2.43" ? {} : { relativePaths },
      );
    } catch (error) {
      if (!(error instanceof WorktreeFormatUpgradeError)) throw error;
      // what git reported before it died, then its error line
      throw new WorktreeError(error.message, [...error.reports.map(reportLine), error.errorLine]);
    }
    return {
      reports,
      messages: reports.map(reportLine),
      ok: reports.every((r) => !r.error),
    };
  }
}
