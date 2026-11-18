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
  /** `GIT_PRINT_SHA1_ELLIPSIS=yes`: describe_detached_head puts `...` after the id */
  printSha1Ellipsis?: boolean;
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
  /** The remote `git push` of the branch pushes to (pushremote_for_branch) */
  pushRemoteOf(branch: string): Promise<string | undefined>;
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
  const describe = (msg: string, id: ObjectId) => describeDetachedHead(host, msg, id);
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
  if (now.path || name === "HEAD") {
    const tracking = await reportTracking(host, now.path);
    stdout += tracking.stdout;
    stderr += tracking.stderr;
  }
  return { ok: true, stdout, stderr };
}

/** checkout.c's describe_detached_head: `<msg> <abbrev>[...] <subject>` */
async function describeDetachedHead(
  host: GitCheckoutHost,
  msg: string,
  id: ObjectId,
): Promise<string> {
  const dots = host.printSha1Ellipsis ? "..." : "";
  return `${msg} ${await host.abbreviate(id)}${dots} ${await host.subject(id)}\n`;
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
    return describeDetachedHead(host, "Previous HEAD position was", oldId);
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
 * checkout.c's report_tracking, remote.c's format_tracking_info: the branch against each
 * ref `status.compareBranches` names (`@{upstream}` and `@{push}`, split at spaces, each
 * resolved ref compared once; `@{upstream}` alone when unset), the reports a blank line
 * apart. The push advice goes with the push ref; a push ref that is not the upstream gets
 * `git pull <remote> <branch>` advice when it follows a branch of the push remote.
 */
async function reportTracking(
  host: GitCheckoutHost,
  path: string | undefined,
): Promise<{ stdout: string; stderr: string }> {
  let sb = "";
  let stderr = "";
  if (!path?.startsWith("refs/heads/")) return { stdout: sb, stderr };
  const branch = path.slice("refs/heads/".length);
  const setting = host.config("status.compareBranches");
  const names =
    setting === undefined ? ["@{upstream}"] : setting.split(" ").filter((n) => n.length > 0);
  const upstreamRef = await host.upstreamOf(branch);
  const pushRef = await host.pushOf(branch);
  const hints = bool(host.config("advice.statusHints"), true);
  const processed = new Set<string>();
  let reported = false;
  for (const name of names) {
    let fullRef: string | undefined;
    const lower = name.toLowerCase();
    if (lower === "@{upstream}") fullRef = upstreamRef;
    else if (lower === "@{push}") fullRef = pushRef;
    else {
      stderr += `warning: ignoring value '${name}' for status.compareBranches, only @{upstream} and @{push} are supported\n`;
    }
    if (!fullRef || processed.has(fullRef)) continue;
    processed.add(fullRef);
    const short = await host.shortenRef(fullRef);
    const isUpstream = fullRef === upstreamRef;
    const isPush = fullRef === pushRef || (isUpstream && (!pushRef || upstreamRef === pushRef));
    const theirs = await host.refCommit(fullRef);
    const ours = await host.refCommit(path);
    if (!theirs || !ours) {
      if (isUpstream) {
        sb += `Your branch is based on '${short}', but the upstream is gone.\n`;
        if (hints) sb += '  (use "git branch --unset-upstream" to fixup)\n';
        reported = true;
      }
      continue;
    }
    if (reported) sb += "\n";
    let pushAdvice = false;
    let pullAdvice = isUpstream;
    let pull = "git pull";
    if (isPush) {
      pushAdvice = true;
      if (fullRef !== upstreamRef) {
        const remote = await host.pushRemoteOf(branch);
        const prefix = `refs/remotes/${remote}/`;
        if (remote && fullRef.startsWith(prefix)) {
          pull = `git pull ${remote} ${fullRef.slice(prefix.length)}`;
          pullAdvice = true;
        }
      } else {
        pullAdvice = true;
      }
    }
    sb += await formatBranchComparison(host, ours, theirs, short, hints, {
      push: pushAdvice,
      pull: pullAdvice ? pull : undefined,
      // checkout passes show_divergence_advice: the advice goes with the upstream
      divergence: isUpstream ? "git pull" : undefined,
    });
    reported = true;
  }
  return { stdout: sb, stderr };
}

/** remote.c's format_branch_comparison (AHEAD_BEHIND_FULL). */
async function formatBranchComparison(
  host: GitCheckoutHost,
  ours: ObjectId,
  theirs: ObjectId,
  short: string,
  hints: boolean,
  advice: { push: boolean; pull?: string; divergence?: string },
): Promise<string> {
  if (theirs === ours) return `Your branch is up to date with '${short}'.\n`;
  const nOurs = await countOnly(host, ours, theirs);
  const nTheirs = await countOnly(host, theirs, ours);
  if (!nTheirs) {
    let out = `Your branch is ahead of '${short}' by ${nOurs} ${nOurs === 1 ? "commit" : "commits"}.\n`;
    if (advice.push && hints) out += '  (use "git push" to publish your local commits)\n';
    return out;
  }
  if (!nOurs) {
    let out = `Your branch is behind '${short}' by ${nTheirs} ${nTheirs === 1 ? "commit" : "commits"}, and can be fast-forwarded.\n`;
    if (advice.pull && hints) out += `  (use "${advice.pull}" to update your local branch)\n`;
    return out;
  }
  let out =
    `Your branch and '${short}' have diverged,\n` +
    `and have ${nOurs} and ${nTheirs} different ${nOurs + nTheirs === 1 ? "commit" : "commits"} each, respectively.\n`;
  if (advice.divergence && hints) {
    out += `  (use "${advice.divergence}" if you want to integrate the remote branch with yours)\n`;
  }
  return out;
}
