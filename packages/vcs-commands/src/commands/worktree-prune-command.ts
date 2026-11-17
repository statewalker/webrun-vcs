import { GitCommand } from "../git-command.js";
import { parseExpiry, requireWorktrees, type WorktreeExpiry } from "./worktree-support.js";

/** One administrative directory `git worktree prune` removed (or would remove). */
export interface PrunedWorktree {
  /** The name under `.git/worktrees`. */
  id: string;
  /** git's reason (`gitdir file points to non-existent location`, `duplicate entry`, ...). */
  reason: string;
}

/** What {@link WorktreePruneCommand} did. */
export interface WorktreePruneResult {
  /** The pruned administrative directories, in the order git reports them. */
  pruned: PrunedWorktree[];
  /** What git prints on stderr with `-n` or `-v`: `Removing worktrees/<id>: <reason>`. */
  messages: string[];
}

/**
 * Prune the administrative files of worktrees that are gone.
 *
 * Equivalent to `git worktree prune [-n] [-v] [--expire <expire>]`.
 *
 * @example
 * ```typescript
 * const { pruned } = await git.worktreePrune().setDryRun(true).call();
 * await git.worktreePrune().setExpire("3.months.ago").call();
 * ```
 *
 * As git's `should_prune_worktree`, `.git/worktrees/<id>` goes when it is not a directory,
 * has no `gitdir` file, an empty one, or one naming a place that no longer exists and whose
 * `index` is not newer than `--expire` (default: every such worktree). A locked worktree is
 * kept whatever its state. Of the kept worktrees, those whose `gitdir` names the same
 * place as another (or as the repository) are pruned as `duplicate entry`, the first by
 * name kept. The empty `.git/worktrees` goes too. `git gc` runs this with
 * `gc.worktreePruneExpire` (default `3.months.ago`).
 */
export class WorktreePruneCommand extends GitCommand<WorktreePruneResult> {
  private dryRun = false;
  private verbose = false;
  private expire: WorktreeExpiry = Number.POSITIVE_INFINITY;

  /** `-n`: report, remove nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `-v`: report what is removed. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `--expire <time>`: missing worktrees whose index is newer are kept. */
  setExpire(expire: WorktreeExpiry): this {
    this.checkCallable();
    this.expire = expire;
    return this;
  }

  async call(): Promise<WorktreePruneResult> {
    this.checkCallable();
    this.setCallable(false);
    const worktrees = requireWorktrees(this.workingCopy, "prune");
    const expire = parseExpiry(this.expire);
    const pruned: PrunedWorktree[] = [];
    const messages: string[] = [];
    const prune = async (id: string, reason: string) => {
      if (this.dryRun || this.verbose) messages.push(`Removing worktrees/${id}: ${reason}`);
      if (!this.dryRun) await worktrees.deleteAdminDir(id).catch(() => undefined);
      pruned.push({ id, reason });
    };

    const kept: { path: string; id?: string }[] = [];
    for (const id of await worktrees.adminIds()) {
      const check = await worktrees.pruneCheck(id, expire);
      if (check.reason !== undefined) await prune(id, check.reason);
      else if (check.gitdirPath !== undefined) kept.push({ path: check.gitdirPath, id });
    }
    // prune_dups: the main worktree sorts first among equal paths, then by id
    kept.push({ path: worktrees.commonDirPath().replace(/\/\.$/, "") });
    kept.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.id === undefined) return -1;
      if (b.id === undefined) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (let i = 1; i < kept.length; i++) {
      const id = kept[i].id;
      if (kept[i].path === kept[i - 1].path && id !== undefined) await prune(id, "duplicate entry");
    }
    if (!this.dryRun) await worktrees.deleteAdminRootIfEmpty();
    return { pruned, messages };
  }
}
