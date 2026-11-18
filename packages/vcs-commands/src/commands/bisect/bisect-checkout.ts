/**
 * The `git checkout <name> --` that `git bisect` runs as a child process, and what that child
 * prints: builtin/checkout.c's switch_branches. Unless `-q`: the local changes kept
 * (show_local_changes, `M\t<path>` on stdout), the commit a detached HEAD leaves
 * (orphaned_commit_warning: "Previous HEAD position was", or the warning about commits left
 * behind), where HEAD is now (update_refs_for_switch: "Switched to branch", "Already on",
 * the detached HEAD advice, "HEAD is now at") and how the branch compares with its upstream
 * (report_tracking, stdout). The refusals are the checkout's own.
 *
 * @example
 * ```typescript
 * const done = await gitCheckout(host, "main", { quiet: false });
 * // done.stderr: "Previous HEAD position was 1a2b3c4 Fix\nSwitched to branch 'main'\n"
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { BisectGraph, type BisectGraphSource, UNINTERESTING } from "./bisect-graph.js";

/** What the checkout reads and does. */
export interface GitCheckoutHost {
  /** The checkout itself: false with git's message when refused */
  checkout(name: string, ignoreOtherWorktrees: boolean): Promise<{ ok: boolean; message?: string }>;
  /** HEAD: the branch ref it points to (undefined when detached) and its commit */
  head(): Promise<{ path?: string; id?: ObjectId }>;
  /** `--name-status` of the worktree (through the index) against the commit's tree */
  localChanges(commit: ObjectId): Promise<string>;
  /** The id abbreviated as DEFAULT_ABBREV abbreviates it */
  abbreviate(id: ObjectId): Promise<string>;
  /** The commit's subject as CMIT_FMT_ONELINE shows it */
  subject(id: ObjectId): Promise<string>;
  /** The commits' headers, for the walk of orphaned_commit_warning and the tracking counts */
  commits: BisectGraphSource;
  /** The commits every ref under `refs/` names (tags peeled; other objects left out) */
  refCommits(): Promise<ObjectId[]>;
  /** A configuration value (the last) */
  config(key: string): string | undefined;
  /** The ref `branch@{upstream}` names, undefined when none */
  upstreamOf(branch: string): Promise<string | undefined>;
  /** The ref `branch@{push}` names, undefined when none */
  pushOf(branch: string): Promise<string | undefined>;
  /** The commit a ref points to, undefined when missing */
  refCommit(ref: string): Promise<ObjectId | undefined>;
  /** refs_shorten_unambiguous_ref */
  shortenRef(ref: string): Promise<string>;
}

/** git's ORPHAN_CUTOFF */
const ORPHAN_CUTOFF = 4;

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (v === "" || v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return fallback;
};

/** `git checkout [-q] [--ignore-other-worktrees] <name> --`: whether it worked, what it printed. */
export async function gitCheckout(
  host: GitCheckoutHost,
  name: string,
  options: { quiet: boolean; ignoreOtherWorktrees?: boolean },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const old = await host.head();
  const done = await host.checkout(name, options.ignoreOtherWorktrees === true);
  if (!done.ok) {
    const message = done.message ?? "";
    return {
      ok: false,
      stdout: "",
      stderr: message.length === 0 || message.endsWith("\n") ? message : `${message}\n`,
    };
  }
  if (options.quiet) return { ok: true, stdout: "", stderr: "" };
  const now = await host.head();
  let stdout = "";
  let stderr = "";
  // merge_working_tree's show_local_changes
  if (now.id) stdout += await host.localChanges(now.id);
  // switch_branches: the commit a detached HEAD leaves
  if (!old.path && old.id && now.id !== old.id) {
    stderr += await orphanedCommitWarning(host, old.id, now.id);
  }
  // update_refs_for_switch
  const describe = async (msg: string, id: ObjectId) =>
    `${msg} ${await host.abbreviate(id)} ${await host.subject(id)}\n`;
  if (name === "HEAD" && !now.path) {
    // nothing to do
  } else if (!now.path) {
    if (old.path && bool(host.config("advice.detachedHead"), true)) stderr += detachAdvice(name);
    if (now.id) stderr += await describe("HEAD is now at", now.id);
  } else if (old.path && old.path === now.path) {
    stderr += `Already on '${name}'\n`;
  } else {
    stderr += `Switched to branch '${name}'\n`;
  }
  if (now.path || name === "HEAD") stdout += await reportTracking(host, now.path);
  return { ok: true, stdout, stderr };
}

/** advice.c's detach_advice */
function detachAdvice(name: string): string {
  return (
    `Note: switching to '${name}'.\n\n` +
    "You are in 'detached HEAD' state. You can look around, make experimental\n" +
    "changes and commit them, and you can discard any commits you make in this\n" +
    "state without impacting any branches by switching back to a branch.\n\n" +
    "If you want to create a new branch to retain commits you create, you may\n" +
    "do so (now or later) by using -c with the switch command. Example:\n\n" +
    "  git switch -c <new-branch-name>\n\n" +
    "Or undo this operation with:\n\n" +
    "  git switch -\n\n" +
    "Turn off this advice by setting config variable advice.detachedHead to false\n\n"
  );
}

/**
 * checkout.c's orphaned_commit_warning: the commits the old detached HEAD reaches that no
 * ref (and not the new HEAD) reaches; none: where HEAD was.
 */
async function orphanedCommitWarning(
  host: GitCheckoutHost,
  oldId: ObjectId,
  newId: ObjectId | undefined,
): Promise<string> {
  const graph = new BisectGraph(host.commits);
  const pending = [{ id: oldId, exclude: false }];
  for (const id of await host.refCommits()) pending.push({ id, exclude: true });
  if (newId) pending.push({ id: newId, exclude: true });
  const walked = await graph.walk(pending);
  if (graph.lookup(oldId).flags & UNINTERESTING) {
    return `Previous HEAD position was ${await host.abbreviate(oldId)} ${await host.subject(oldId)}\n`;
  }
  const lost = walked.filter((n) => !(n.flags & UNINTERESTING));
  const describeOne = async (id: ObjectId) =>
    `  ${await host.abbreviate(id)} ${await host.subject(id)}\n`;
  let sb = "";
  for (const n of lost.slice(0, ORPHAN_CUTOFF)) sb += await describeOne(n.id);
  if (lost.length > ORPHAN_CUTOFF) {
    const more = lost.length - ORPHAN_CUTOFF;
    if (more === 1) sb += await describeOne((lost[lost.length - 1] as { id: ObjectId }).id);
    else sb += ` ... and ${more} more.\n`;
  }
  const one = lost.length === 1;
  let out =
    `Warning: you are leaving ${lost.length} ${one ? "commit" : "commits"} behind, not connected to\n` +
    `any of your branches:\n\n${sb}\n`;
  if (bool(host.config("advice.detachedHead"), true)) {
    out +=
      `If you want to keep ${one ? "it" : "them"} by creating a new branch, this may be a good time\n` +
      `to do so with:\n\n git branch <new-branch-name> ${await host.abbreviate(oldId)}\n\n`;
  }
  return out;
}

/** The commits `from` reaches that `not` does not (a limited walk of `from ^not`). */
async function countOnly(host: GitCheckoutHost, from: ObjectId, not: ObjectId): Promise<number> {
  const graph = new BisectGraph(host.commits);
  const walked = await graph.walk([
    { id: from, exclude: false },
    { id: not, exclude: true },
  ]);
  return walked.filter((n) => !(n.flags & UNINTERESTING)).length;
}

/**
 * checkout.c's report_tracking (remote.c's format_tracking_info with its default
 * `@{upstream}`): the branch against its upstream. With `status.compareBranches` set
 * nothing is reported.
 */
async function reportTracking(host: GitCheckoutHost, path: string | undefined): Promise<string> {
  if (!path?.startsWith("refs/heads/")) return "";
  if (host.config("status.compareBranches") !== undefined) return "";
  const branch = path.slice("refs/heads/".length);
  const upstream = await host.upstreamOf(branch);
  if (!upstream) return "";
  const hints = bool(host.config("advice.statusHints"), true);
  const short = await host.shortenRef(upstream);
  const theirs = await host.refCommit(upstream);
  const ours = await host.refCommit(path);
  if (!theirs || !ours) {
    let out = `Your branch is based on '${short}', but the upstream is gone.\n`;
    if (hints) out += '  (use "git branch --unset-upstream" to fixup)\n';
    return out;
  }
  if (theirs === ours) return `Your branch is up to date with '${short}'.\n`;
  const push = await host.pushOf(branch);
  const isPush = !push || push === upstream;
  const nOurs = await countOnly(host, ours, theirs);
  const nTheirs = await countOnly(host, theirs, ours);
  if (!nTheirs) {
    let out = `Your branch is ahead of '${short}' by ${nOurs} ${nOurs === 1 ? "commit" : "commits"}.\n`;
    if (isPush && hints) out += '  (use "git push" to publish your local commits)\n';
    return out;
  }
  if (!nOurs) {
    let out = `Your branch is behind '${short}' by ${nTheirs} ${nTheirs === 1 ? "commit" : "commits"}, and can be fast-forwarded.\n`;
    if (hints) out += '  (use "git pull" to update your local branch)\n';
    return out;
  }
  let out =
    `Your branch and '${short}' have diverged,\n` +
    `and have ${nOurs} and ${nTheirs} different ${nOurs + nTheirs === 1 ? "commit" : "commits"} each, respectively.\n`;
  if (hints) out += '  (use "git pull" if you want to integrate the remote branch with yours)\n';
  return out;
}
