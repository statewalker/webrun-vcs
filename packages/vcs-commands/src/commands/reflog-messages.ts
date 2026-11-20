/**
 * The reflog lines our porcelain writes, as native git writes them: one place for the
 * messages of each command (checked against git 2.43 and git's sources: `builtin/*.c`,
 * `sequencer.c`, `reset.c`), and the identity and time of a line (`git_committer_info`).
 *
 * @example
 * ```typescript
 * const log = reflogLine(workingCopy, reflogMessages.reset("HEAD~1"));
 * await updateHead(refs, targetId, log); // the branch and HEAD: "reset: moving to HEAD~1"
 * ```
 */

import {
  formatPersonIdent,
  isSymbolicRef,
  type ObjectId,
  type PersonIdent,
  type RefLogOptions,
  type Refs,
} from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { findIdent, hostEnvironmentOf, identConfigOf } from "./git-ident.js";

/**
 * The identity and time of a reflog line written now, as git's `git_committer_info` builds
 * it (not strict): `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` / `GIT_COMMITTER_DATE` (the
 * host environment's `committer`, on the working copy's configuration), else
 * `committer.name` / `committer.email`, `user.name` / `user.email` and the clock (`now`, in
 * seconds, when the caller read it once for all its lines, as git reads its default date
 * once per process). Undefined when neither names anyone: the ref store's own identity is
 * used then.
 */
export function committerIdent(workingCopy: WorkingCopy, now?: number): PersonIdent | undefined {
  return findIdent("committer", hostEnvironmentOf(workingCopy), identConfigOf(workingCopy), {
    now,
    strict: false,
  });
}

/**
 * A reflog line's options: `message`, with `who` as its identity (a commit's committer),
 * else {@link committerIdent} at `now` (seconds; the clock when omitted).
 */
export function reflogLine(
  workingCopy: WorkingCopy,
  message: string,
  who?: PersonIdent,
  now?: number,
): RefLogOptions {
  const ident = who ?? committerIdent(workingCopy, now);
  return { message, ...(ident ? { ident: formatPersonIdent(ident) } : {}) };
}

/**
 * The first line of a commit message as git's commit and sequencer put it in a reflog line:
 * leading blank lines skipped (git's cleanup), whitespace collapsed.
 */
export function reflogSubject(message: string): string {
  const line = message.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/\s+/g, " ").trim();
}

/** What a commit records in `commit (<kind>): <subject>` (git's builtin/commit.c). */
export type CommitReflogKind = "initial" | "amend" | "merge" | "cherry-pick" | undefined;

/** git's reflog messages, per command. */
export const reflogMessages = {
  /**
   * `git checkout` / `git switch`: `from` is the branch left (short name) or, detached, the
   * full id of HEAD; `to` the argument as given (`feat`, `HEAD~1`, `v1.0`).
   */
  checkout: (from: string, to: string) => `checkout: moving from ${from} to ${to}`,
  /** `git commit`: `commit: <subject>`, `commit (initial): ...`, `commit (amend): ...` */
  commit: (kind: CommitReflogKind, message: string, action?: string) =>
    `${action ?? (kind ? `commit (${kind})` : "commit")}: ${reflogSubject(message)}`,
  /** `git reset <rev>`: the revision as given, `HEAD` by default. */
  reset: (rev: string) => `reset: moving to ${rev}`,
  /** `git merge <names>`: `merge feat: Fast-forward`, `merge feat: Merge made by ...`. */
  merge: (action: string, outcome: string) => `${action}: ${outcome}`,
  /** The action of `git merge <names>`, with the names as given. */
  mergeAction: (names: string[]) => ["merge", ...names].join(" "),
  /** The outcome of a merge that made a commit. */
  mergeMade: (strategy: string) => `Merge made by the '${strategy}' strategy.`,
  /** `git cherry-pick` / `git revert` (and a rebase's pick): `<action>: <subject>`. */
  pick: (action: string, message: string) => `${action}: ${reflogSubject(message)}`,
  /** A rebase detaching HEAD at what it rebases onto, named as given. */
  rebaseStart: (action: string, ontoName: string) => `${action} (start): checkout ${ontoName}`,
  /** A rebase's `<action> (pick)`, `(continue)`, `(abort)`, `(finish)`. */
  rebaseStep: (action: string, step: string) => `${action} (${step})`,
  /** The branch a finished rebase moves. */
  rebaseFinishBranch: (action: string, headName: string, onto: ObjectId) =>
    `${action} (finish): ${headName} onto ${onto}`,
  /** HEAD attached to that branch again. */
  rebaseFinishHead: (action: string, headName: string) =>
    `${action} (finish): returning to ${headName}`,
  /** HEAD back on the branch an aborted rebase started from. */
  rebaseAbort: (action: string, headName: string) => `${action} (abort): returning to ${headName}`,
  /** A rebase that only switches to the branch named (it is up to date). */
  rebaseCheckout: (action: string, branch: string) => `${action}: checkout ${branch}`,
  /** `git clone <url>`: HEAD, the branch and `refs/remotes/<remote>/HEAD`. */
  clone: (url: string) => `clone: from ${url}`,
  /**
   * `git fetch`: `<action>: fast-forward`, `forced-update`, `storing head` (a new ref the
   * remote has under refs/heads/), `storing tag`, `storing ref`, `updating tag`.
   */
  fetch: (action: string, what: string) => `${action}: ${what}`,
  /** `git branch <name> [<start>]` and `checkout -b`: the start point as given, `HEAD` by default. */
  branchCreated: (start: string) => `branch: Created from ${start}`,
  /** `git branch -f` / `checkout -B` of a branch that exists. */
  branchReset: (start: string) => `branch: Reset to ${start}`,
  /** `git branch -m`. */
  branchRenamed: (from: string, to: string) => `Branch: renamed ${from} to ${to}`,
  /** `git branch -c`. */
  branchCopied: (from: string, to: string) => `Branch: copied ${from} to ${to}`,
};

/**
 * Move HEAD to `id` as git's `update_ref("HEAD", ...)` does: through a symbolic HEAD its
 * branch moves (logged in the branch's reflog and HEAD's), a detached HEAD moves itself.
 */
export async function updateHead(refs: Refs, id: ObjectId, log?: RefLogOptions): Promise<void> {
  const head = await refs.get("HEAD");
  if (head && isSymbolicRef(head)) await refs.set(head.target, id, log);
  else await refs.set("HEAD", id, log);
}

/**
 * Move HEAD to `id` as git's `refs_update_ref("HEAD", id, old)` does: one transaction on
 * HEAD expecting `old` (unchecked when undefined), through a symbolic HEAD to its branch
 * unless `noDeref` (a detached HEAD written as itself), as the reference-transaction hook
 * sees it (`<old> <new> HEAD`). A store whose batches cannot take HEAD sets it plainly; a
 * refusal (HEAD moved meanwhile, its lock held) throws.
 */
export async function updateHeadExpecting(
  refs: Refs,
  id: ObjectId,
  old: ObjectId | undefined,
  log: RefLogOptions | undefined,
  options: { noDeref?: boolean } = {},
): Promise<void> {
  const result = await refs.batch(
    [
      {
        name: "HEAD",
        ...(old !== undefined ? { old } : {}),
        new: id,
        ...(options.noDeref ? { noDeref: true } : {}),
      },
    ],
    log,
  );
  if (result.ok) return;
  if (result.rejected.every((r) => r.reason === "unsupported" || r.reason === "invalid-name")) {
    if (options.noDeref) await refs.set("HEAD", id, log);
    else await updateHead(refs, id, log);
    return;
  }
  // UPDATE_REFS_DIE_ON_ERR: git's lock_ref_for_update message
  const mismatch = result.rejected.find((r) => r.reason === "mismatch");
  const current =
    mismatch && old !== undefined
      ? (await refs.resolve("HEAD").catch(() => undefined))?.objectId
      : undefined;
  const detail =
    mismatch && old !== undefined
      ? current
        ? `is at ${current} but expected ${old}`
        : "unable to resolve reference 'HEAD'"
      : result.rejected.some((r) => r.reason === "locked")
        ? "HEAD.lock is held by another writer"
        : result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ");
  throw Object.assign(new GitApiError(`fatal: cannot lock ref 'HEAD': ${detail}`), {
    rejected: result.rejected,
  });
}
