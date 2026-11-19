/**
 * How a branch compares with its upstream (and the other refs `status.compareBranches`
 * names), as remote.c's `stat_tracking_info` counts it and `format_tracking_info` words it
 * for `git status` and the commit template.
 *
 * @example
 * ```typescript
 * const info = await formatTrackingInfo(source, "refs/heads/main", { quick: false, divergenceAdvice: true, hints: true });
 * // info.text: "Your branch is ahead of 'origin/main' by 1 commit.\n  (use \"git push\" to publish your local commits)\n"
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

/** What the comparison reads of the repository. */
export interface TrackingSource {
  /** A configuration value (the last one) */
  config(key: string): string | undefined;
  /** The ref `branch@{upstream}` names (undefined: none configured) */
  upstreamOf(branch: string): Promise<string | undefined>;
  /** The ref `branch@{push}` names (undefined: none) */
  pushOf(branch: string): Promise<string | undefined>;
  /** The remote a push of the branch goes to (`pushremote_for_branch`) */
  pushRemoteOf(branch: string): Promise<string | undefined>;
  /** The commit a ref names (tags peeled), undefined when there is none */
  refCommit(ref: string): Promise<ObjectId | undefined>;
  /** `refs_shorten_unambiguous_ref` */
  shortenRef(ref: string): Promise<string>;
  /** The commits only `ours` reaches and those only `theirs` reaches (`rev-list --left-right`) */
  aheadBehind(ours: ObjectId, theirs: ObjectId): Promise<{ ahead: number; behind: number }>;
}

/** `stat_tracking_info` / `stat_branch_pair`: how the branch stands against `base`. */
export interface TrackingStat {
  /** The ref compared with (full name), undefined when the branch has no upstream */
  base?: string;
  /** -1: cannot compare (no base, or a side is gone); 0: the same commit; 1: different */
  result: -1 | 0 | 1;
  ahead: number;
  behind: number;
}

/** remote.c's `stat_branch_pair` of `branchRef` against `base` (`quick`: AHEAD_BEHIND_QUICK). */
export async function statBranchPair(
  source: TrackingSource,
  branchRef: string,
  base: string,
  quick: boolean,
): Promise<TrackingStat> {
  const theirs = await source.refCommit(base);
  const ours = theirs ? await source.refCommit(branchRef) : undefined;
  if (!theirs || !ours) return { base, result: -1, ahead: 0, behind: 0 };
  if (theirs === ours) return { base, result: 0, ahead: 0, behind: 0 };
  if (quick) return { base, result: 1, ahead: 0, behind: 0 };
  const { ahead, behind } = await source.aheadBehind(ours, theirs);
  return { base, result: 1, ahead, behind };
}

/** remote.c's `stat_tracking_info` (not for push): the branch against its upstream. */
export async function statTrackingInfo(
  source: TrackingSource,
  branchRef: string,
  quick: boolean,
): Promise<TrackingStat> {
  const branch = branchRef.replace(/^refs\/heads\//, "");
  const base = await source.upstreamOf(branch);
  if (!base) return { result: -1, ahead: 0, behind: 0 };
  return statBranchPair(source, branchRef, base, quick);
}

/** What {@link formatTrackingInfo} prints besides the comparison. */
export interface TrackingFormatOptions {
  /** AHEAD_BEHIND_QUICK (`status.aheadBehind=false`, `--no-ahead-behind`) */
  quick: boolean;
  /** show_divergence_advice: the `git pull` advice of diverged branches (not in a commit template) */
  divergenceAdvice: boolean;
  /** `advice.statusHints` */
  hints: boolean;
}

/**
 * remote.c's `format_tracking_info` (git 2.5x): one report per ref `status.compareBranches`
 * names (`@{upstream}` alone when unset), a blank line between reports. `text` is empty
 * when there is nothing to report; `warnings` are the values the setting cannot name.
 */
export async function formatTrackingInfo(
  source: TrackingSource,
  branchRef: string,
  options: TrackingFormatOptions,
): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  const branch = branchRef.replace(/^refs\/heads\//, "");
  const setting = source.config("status.compareBranches");
  const names =
    setting === undefined ? ["@{upstream}"] : setting.split(" ").filter((n) => n.length > 0);
  const upstreamRef = await source.upstreamOf(branch);
  const pushRef = await source.pushOf(branch);
  const processed = new Set<string>();
  let sb = "";
  let reported = false;
  for (const name of names) {
    let fullRef: string | undefined;
    const lower = name.toLowerCase();
    if (lower === "@{upstream}") fullRef = upstreamRef;
    else if (lower === "@{push}") fullRef = pushRef;
    else {
      warnings.push(
        `warning: ignoring value '${name}' for status.compareBranches, only @{upstream} and @{push} are supported`,
      );
    }
    if (!fullRef || processed.has(fullRef)) continue;
    processed.add(fullRef);
    const short = await source.shortenRef(fullRef);
    const isUpstream = fullRef === upstreamRef;
    let isPush = fullRef === pushRef;
    if (isUpstream && (!pushRef || upstreamRef === pushRef)) isPush = true;
    const stat = await statBranchPair(source, branchRef, fullRef, options.quick);
    if (stat.result < 0) {
      if (isUpstream) {
        sb += `Your branch is based on '${short}', but the upstream is gone.\n`;
        if (options.hints) sb += '  (use "git branch --unset-upstream" to fixup)\n';
        reported = true;
      }
      continue;
    }
    if (reported) sb += "\n";
    let pushAdvice = false;
    let pullAdvice = isUpstream;
    const divergenceAdvice = options.divergenceAdvice && isUpstream;
    let pushRemote: string | undefined;
    let pushBranch: string | undefined;
    if (isPush) {
      pushAdvice = true;
      if (!upstreamRef || upstreamRef !== fullRef) {
        const remote = await source.pushRemoteOf(branch);
        const prefix = `refs/remotes/${remote}/`;
        if (remote && fullRef.startsWith(prefix)) {
          pushRemote = remote;
          pushBranch = fullRef.slice(prefix.length);
          pullAdvice = true;
        }
      } else {
        pullAdvice = true;
      }
    }
    sb += formatBranchComparison(stat, short, options, {
      push: pushAdvice,
      pull: pullAdvice,
      divergence: divergenceAdvice,
      pushRemote,
      pushBranch,
    });
    reported = true;
  }
  return { text: sb, warnings };
}

/** remote.c's `format_branch_comparison`. */
function formatBranchComparison(
  stat: TrackingStat,
  short: string,
  options: TrackingFormatOptions,
  advice: {
    push: boolean;
    pull: boolean;
    divergence: boolean;
    pushRemote?: string;
    pushBranch?: string;
  },
): string {
  const { ahead: ours, behind: theirs } = stat;
  const hints = options.hints;
  const plural = (n: number) => (n === 1 ? "commit" : "commits");
  const pull =
    advice.pushRemote && advice.pushBranch
      ? `git pull ${advice.pushRemote} ${advice.pushBranch}`
      : "git pull";
  if (stat.result === 0) return `Your branch is up to date with '${short}'.\n`;
  if (options.quick) {
    let out = `Your branch and '${short}' refer to different commits.\n`;
    if (advice.push && hints) out += '  (use "git status --ahead-behind" for details)\n';
    return out;
  }
  if (!theirs) {
    let out = `Your branch is ahead of '${short}' by ${ours} ${plural(ours)}.\n`;
    if (advice.push && hints) out += '  (use "git push" to publish your local commits)\n';
    return out;
  }
  if (!ours) {
    let out = `Your branch is behind '${short}' by ${theirs} ${plural(theirs)}, and can be fast-forwarded.\n`;
    if (advice.pull && hints) out += `  (use "${pull}" to update your local branch)\n`;
    return out;
  }
  let out =
    `Your branch and '${short}' have diverged,\n` +
    `and have ${ours} and ${theirs} different ${plural(ours + theirs)} each, respectively.\n`;
  if (advice.divergence && hints) {
    out += `  (use "${pull}" if you want to integrate the remote branch with yours)\n`;
  }
  return out;
}
