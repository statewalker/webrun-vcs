/**
 * What the `git worktree` commands, and the commands that respect other worktrees
 * (`branch -d`, `branch -f`, `checkout`), share: git's `die_if_checked_out`,
 * `is_shared_symref`, `check_candidate_path` and expiry dates.
 *
 * @module
 */

import type { LinkedWorktrees, WorkingCopy, WorktreeInfo } from "@statewalker/vcs-working-tree";

import {
  BranchUsedByWorktreeError,
  WorktreeError,
  WorktreesUnsupportedError,
} from "../errors/index.js";

/** The working copy's worktrees, or WorktreesUnsupportedError for a backend without them. */
export function requireWorktrees(workingCopy: WorkingCopy, operation: string): LinkedWorktrees {
  const worktrees = workingCopy.worktrees;
  if (!worktrees) throw new WorktreesUnsupportedError(operation);
  return worktrees;
}

/**
 * git's `find_worktree` with the refusals every subcommand makes: `'<arg>' is not a working
 * tree`, and `mainMessage` (its `%s` the argument) for the main worktree.
 */
export async function findLinkedWorktree(
  worktrees: LinkedWorktrees,
  arg: string | undefined,
  mainMessage: string,
): Promise<WorktreeInfo> {
  if (arg === undefined) throw new WorktreeError("<worktree> is required");
  const wt = await worktrees.find(arg);
  if (!wt) throw new WorktreeError(`'${arg}' is not a working tree`);
  if (wt.id === undefined) throw new WorktreeError(mainMessage.replace("%s", arg));
  return wt;
}

/** `refs/heads/x` as `x`. */
export function shortBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * git's `is_shared_symref(wt, "HEAD", ref)`: the worktree's HEAD points at `ref`, or, with
 * HEAD detached, a rebase or bisect in progress there works on it. A bare main worktree
 * uses no branch.
 */
export function usesBranch(wt: WorktreeInfo, ref: string): boolean {
  if (wt.bare) return false;
  if (wt.detached && (wt.rebasing === ref || wt.bisecting === ref)) return true;
  return wt.headRef === ref;
}

/** The first worktree that uses the branch `ref` (git's `find_shared_symref`). */
export async function worktreeUsingBranch(
  worktrees: LinkedWorktrees,
  ref: string,
  options: { ignoreCurrent?: boolean } = {},
): Promise<WorktreeInfo | undefined> {
  for (const wt of await worktrees.list()) {
    if (options.ignoreCurrent && wt.current) continue;
    if (usesBranch(wt, ref)) return wt;
  }
  return undefined;
}

/**
 * git's `die_if_checked_out`: `'x' is already used by worktree at '<path>'` when another
 * worktree (or, unless `ignoreCurrent`, this one) uses the branch `ref`.
 */
export async function refuseIfCheckedOut(
  worktrees: LinkedWorktrees,
  ref: string,
  ignoreCurrent: boolean,
): Promise<void> {
  const wt = await worktreeUsingBranch(worktrees, ref, { ignoreCurrent });
  if (!wt) return;
  const name = shortBranchName(ref);
  throw new BranchUsedByWorktreeError(
    name,
    wt.path,
    `'${name}' is already used by worktree at '${wt.path}'`,
  );
}

/**
 * git's `check_candidate_path` for `worktree add` and `worktree move`: refuses a path that
 * exists and is not an empty directory, and a missing path a worktree is still registered
 * at, unless forced (once for an unlocked one, twice for a locked one: its administrative
 * directory is then deleted).
 */
export async function checkCandidatePath(
  worktrees: LinkedWorktrees,
  path: string,
  force: number,
  command: "add" | "move",
): Promise<void> {
  const state = await worktrees.pathState(path);
  if (state !== "missing" && state !== "empty-directory") {
    throw new WorktreeError(`'${path}' already exists`);
  }
  const wt = await worktrees.findByPath(path);
  if (!wt) return;
  const locked = wt.lockReason !== undefined;
  if ((!locked && force > 0) || (locked && force > 1)) {
    if (wt.id === undefined) throw new WorktreeError(`unusable worktree destination '${path}'`);
    try {
      await worktrees.deleteAdminDir(wt.id);
    } catch {
      throw new WorktreeError(`unusable worktree destination '${path}'`);
    }
    return;
  }
  if (locked) {
    throw new WorktreeError(
      `'${path}' is a missing but locked worktree;\nuse '${command} -f -f' to override, or 'unlock' and 'prune' or 'remove' to clear`,
    );
  }
  throw new WorktreeError(
    `'${path}' is a missing but already registered worktree;\nuse '${command} -f' to override, or 'prune' or 'remove' to clear`,
  );
}

/** An expiry as `--expire` takes it: a date, seconds since the epoch, or git's words. */
export type WorktreeExpiry = Date | number | string;

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 7 * 86400,
};

/**
 * git's `parse_expiry_date` (seconds since the epoch): `never`/`false` expire nothing (0),
 * `now`/`all` everything (`Infinity`, git's TIME_MAX); `<n>.<unit>[s].ago` (seconds to
 * years, a month and a year counted on the calendar), a date `Date.parse` reads, or a
 * number of seconds.
 */
export function parseExpiry(value: WorktreeExpiry, now: Date = new Date()): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return value;
  const text = value.trim().toLowerCase();
  if (text === "never" || text === "false") return 0;
  if (text === "now" || text === "all") return Number.POSITIVE_INFINITY;
  const relative = /^(\d+)[. ](second|minute|hour|day|week|month|year)s?[. ]ago$/.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    if (unit === "month" || unit === "year") {
      const date = new Date(now.getTime());
      date.setMonth(date.getMonth() - (unit === "year" ? 12 * n : n));
      return Math.floor(date.getTime() / 1000);
    }
    return Math.floor(now.getTime() / 1000) - n * UNIT_SECONDS[unit];
  }
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new WorktreeError(`malformed expiration date '${value}'`);
  return Math.floor(parsed / 1000);
}
