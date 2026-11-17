/**
 * Upstream tracking of new branches, as git's `branch.c` sets it up (`setup_tracking`,
 * `install_branch_config_multiple_remotes`), and the remote-tracking branch git's checkout
 * and switch guess for a name no ref has (`checkout.c` `parse_remote_branch`,
 * `checkout.c`/`remote.c` `unique_tracking_name`). Checked against git 2.43 and 2.56.
 *
 * @example
 * ```typescript
 * // `git switch -c topic origin/topic`: branch.topic.remote=origin, .merge=refs/heads/topic
 * await setupTracking(workingCopy, refs, "topic", "refs/remotes/origin/topic", TrackMode.DEFAULT);
 * ```
 */

import { isSymbolicRef, type Refs } from "@statewalker/vcs-core";
import { matchDestination, matchSource, parseRefSpec } from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { InvalidArgumentError, RefNotFoundError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * How a new branch tracks its start point (git's `--track`, `--no-track`,
 * `branch.autoSetupMerge`).
 */
export enum TrackMode {
  /** Neither option: `branch.autoSetupMerge` decides (by default a remote-tracking start is tracked). */
  DEFAULT = "default",
  /** `--track` (`--track=direct`): the start point is tracked, also a local branch (remote `.`). */
  DIRECT = "direct",
  /** `--track=inherit`: the start branch's own upstream configuration is copied. */
  INHERIT = "inherit",
  /** `--no-track`: nothing is set up, whatever the configuration says. */
  NONE = "none",
}

/** git's `enum branch_track`, once `DEFAULT` has read the configuration. */
type Track = "never" | "remote" | "always" | "explicit" | "inherit" | "simple";

/** `branch.autoSetupMerge` (git's `git_branch_track`): `remote` when unset or true. */
function configuredTrack(config: RemoteConfigStore): Track {
  const value = config.value("branch.autoSetupMerge");
  if (value === undefined) return "remote";
  const lower = value.toLowerCase();
  if (lower === "always" || lower === "inherit" || lower === "simple") return lower;
  return (parseGitBool(value) ?? true) ? "remote" : "never";
}

function effectiveTrack(config: RemoteConfigStore, mode: TrackMode): Track {
  switch (mode) {
    case TrackMode.DIRECT:
      return "explicit";
    case TrackMode.INHERIT:
      return "inherit";
    case TrackMode.NONE:
      return "never";
    default:
      return configuredTrack(config);
  }
}

/** A remote's fetch refspecs (git's default when none is configured: none, for a URL-only remote). */
function fetchSpecs(config: RemoteConfigStore, remote: string) {
  return config.configuredFetchRefspecs(remote).map((spec) => parseRefSpec(spec));
}

/**
 * git's `remote_find_tracking` by destination: the source ref the remote's fetch refspecs
 * map onto `dst`, unless a negative refspec excludes it.
 */
function sourceForTracking(config: RemoteConfigStore, remote: string, dst: string) {
  const specs = fetchSpecs(config, remote);
  for (const spec of specs) {
    if (spec.negative || !spec.source || !spec.destination) continue;
    if (!matchDestination(spec, dst)) continue;
    let src = spec.source;
    if (spec.wildcard) {
      const [dPrefix = "", dSuffix = ""] = spec.destination.split("*");
      const middle = dst.slice(dPrefix.length, dst.length - dSuffix.length);
      src = spec.source.replace("*", middle);
    }
    if (specs.some((n) => n.negative && matchSource(n, src))) continue;
    return src;
  }
  return undefined;
}

/**
 * git's `remote_find_tracking` by source: the tracking ref the remote's fetch refspecs map
 * `src` onto.
 */
function trackingForSource(config: RemoteConfigStore, remote: string, src: string) {
  const specs = fetchSpecs(config, remote);
  if (specs.some((n) => n.negative && matchSource(n, src))) return undefined;
  for (const spec of specs) {
    if (spec.negative || !spec.source || !spec.destination) continue;
    if (!matchSource(spec, src)) continue;
    if (!spec.wildcard) return spec.destination;
    const [sPrefix = "", sSuffix = ""] = spec.source.split("*");
    const middle = src.slice(sPrefix.length, src.length - sSuffix.length);
    return spec.destination.replace("*", middle);
  }
  return undefined;
}

/**
 * git's `validate_remote_tracking_branch`: whether some remote fetches into `ref`
 * (a `refs/remotes/...` ref no remote writes is not tracked as a branch).
 */
export function isRemoteTrackingBranch(workingCopy: WorkingCopy, ref: string): boolean {
  const config = RemoteConfigStore.from(workingCopy);
  return config.configuredNames().some((remote) => !!sourceForTracking(config, remote, ref));
}

/**
 * The remote-tracking branch git's checkout and switch turn `name` into when no ref has
 * that name (`--guess`, on by default): the one `refs/remotes/<remote>/...` ref that some
 * remote fetches `refs/heads/<name>` into; with several, the one of `checkout.defaultRemote`.
 *
 * @returns the full name of the tracking ref, or undefined when no remote has the branch
 * @throws InvalidArgumentError when several remotes have it (git's `'<name>' matched
 *   multiple (<n>) remote tracking branches`)
 */
export async function guessRemoteBranch(
  workingCopy: WorkingCopy,
  refs: Refs,
  name: string,
): Promise<string | undefined> {
  const config = RemoteConfigStore.from(workingCopy);
  const defaultRemote = config.value("checkout.defaultRemote");
  const found: string[] = [];
  let preferred: string | undefined;
  for (const remote of config.configuredNames()) {
    const dst = trackingForSource(config, remote, `refs/heads/${name}`);
    if (!dst || !(await refs.has(dst))) continue;
    found.push(dst);
    if (remote === defaultRemote) preferred = dst;
  }
  if (found.length === 1) return found[0];
  if (preferred) return preferred;
  if (found.length > 1) {
    throw new InvalidArgumentError(
      "name",
      name,
      `fatal: '${name}' matched multiple (${found.length}) remote tracking branches`,
    );
  }
  return undefined;
}

/**
 * The start point's full ref name when it names a branch git would track (git's
 * `dwim_branch_start`): a local branch, or a remote-tracking branch some remote fetches
 * into. Undefined for anything else (a commit, a tag, a ref no remote writes); with
 * `--track` such a start point is refused.
 */
export async function trackableStart(
  workingCopy: WorkingCopy,
  refs: Refs,
  start: string,
  mode: TrackMode,
): Promise<string | undefined> {
  const explicit = mode === TrackMode.DIRECT;
  // git's dwim_ref rules, a symbolic ref named by the ref it ends at (`HEAD` is the
  // current branch, `origin` origin's HEAD's branch)
  const candidates = [
    start,
    `refs/${start}`,
    `refs/tags/${start}`,
    `refs/heads/${start}`,
    `refs/remotes/${start}`,
    `refs/remotes/${start}/HEAD`,
  ];
  let real: string | undefined;
  for (const candidate of candidates) {
    if (!candidate.startsWith("refs/") && !/^[A-Z_]+$/.test(candidate)) continue;
    real = await endOfSymbolicChain(refs, candidate);
    if (real) break;
  }
  const tracked =
    real !== undefined &&
    (real.startsWith("refs/heads/") ||
      (real.startsWith("refs/remotes/") && isRemoteTrackingBranch(workingCopy, real)));
  if (!tracked) {
    if (explicit) {
      throw new InvalidArgumentError(
        "track",
        start,
        `fatal: cannot set up tracking information; starting point '${start}' is not a branch`,
      );
    }
    return undefined;
  }
  return real;
}

/** The ref a (possibly symbolic) ref ends at, when that one exists. */
export async function endOfSymbolicChain(refs: Refs, name: string): Promise<string | undefined> {
  let ref = name;
  for (let depth = 0; depth < 5; depth++) {
    const found = await refs.get(ref).catch(() => undefined);
    if (!found) return undefined;
    if (!isSymbolicRef(found)) return found.objectId ? ref : undefined;
    ref = found.target;
  }
  return undefined;
}

/**
 * The upstream configuration {@link planTracking} decided on: `branch.<name>.remote` (none
 * for a local start, written as `.`), `.merge` and whether `.rebase` is set.
 */
export interface TrackingPlan {
  readonly remote: string | undefined;
  readonly merges: string[];
  readonly rebase: boolean;
}

/**
 * git's `setup_tracking` up to the point it writes: what a new branch that starts at the
 * branch `startRef` (a full ref name, see {@link trackableStart}) tracks, as `mode` and
 * `branch.autoSetupMerge` say. Nothing is written; {@link installTracking} does that.
 *
 * @returns the plan, or undefined when nothing is tracked
 * @throws RefNotFoundError when several remotes fetch into `startRef` (git's `not
 *   tracking: ambiguous information for ref '<ref>'`)
 */
export function planTracking(
  workingCopy: WorkingCopy,
  newBranch: string,
  startRef: string,
  mode: TrackMode,
): TrackingPlan | undefined {
  const config = RemoteConfigStore.from(workingCopy);
  const track = effectiveTrack(config, mode);
  if (track === "never") return undefined;

  let remote: string | undefined;
  let merges: string[] = [];
  let matches = 0;
  if (track === "inherit") {
    const bare = startRef.replace(/^refs\/heads\//, "");
    remote = config.value(`branch.${bare}.remote`);
    merges = config.values(`branch.${bare}.merge`);
    // git warns (asked to inherit tracking from '<b>', but no remote/merge is set) and
    // sets nothing up
    if (!remote || merges.length === 0) return undefined;
  } else {
    for (const name of config.configuredNames()) {
      const src = sourceForTracking(config, name, startRef);
      if (!src) continue;
      matches++;
      remote = name;
      merges = [src];
    }
    if (matches === 0 && track !== "always" && track !== "explicit") return undefined;
    if (matches > 1) {
      throw new RefNotFoundError(
        startRef,
        `fatal: not tracking: ambiguous information for ref '${startRef}'`,
      );
    }
    if (track === "simple") {
      const tracked = merges[0]?.startsWith("refs/heads/") ? merges[0].slice(11) : undefined;
      if (tracked !== newBranch) return undefined;
    }
    if (merges.length === 0) merges = [startRef];
  }

  // install_branch_config_multiple_remotes: never a branch as its own upstream
  if (!remote && merges.some((m) => m === `refs/heads/${newBranch}`)) return undefined;
  const autoRebase = (config.value("branch.autoSetupRebase") ?? "never").toLowerCase();
  const rebase =
    autoRebase === "always" ||
    (autoRebase === "local" && remote === undefined) ||
    (autoRebase === "remote" && remote !== undefined);
  return { remote, merges, rebase };
}

/**
 * Write a {@link TrackingPlan} as `branch.<newBranch>.*` and save the configuration.
 *
 * @returns the upstream set up (`origin/topic`, a local `main`)
 */
export async function installTracking(
  workingCopy: WorkingCopy,
  newBranch: string,
  plan: TrackingPlan,
): Promise<string> {
  const config = RemoteConfigStore.from(workingCopy);
  const { remote, merges } = plan;
  config.setValue(`branch.${newBranch}.remote`, remote ?? ".");
  config.setValues(`branch.${newBranch}.merge`, merges);
  if (plan.rebase) config.setValue(`branch.${newBranch}.rebase`, "true");
  await config.save();
  const first = merges[0] ?? "";
  const short = first.replace(/^refs\/heads\//, "");
  return remote && remote !== "." ? `${remote}/${short}` : short;
}

/**
 * git's `setup_tracking`: `branch.<name>.remote` and `branch.<name>.merge` (and
 * `branch.<name>.rebase` as `branch.autoSetupRebase` asks) for a new branch that starts at
 * the branch `startRef` (a full ref name, see {@link trackableStart}), as `mode` and
 * `branch.autoSetupMerge` say. The configuration is saved.
 *
 * @returns the upstream set up (`origin/topic`, a local `main`), or undefined when none
 */
export async function setupTracking(
  workingCopy: WorkingCopy,
  newBranch: string,
  startRef: string,
  mode: TrackMode,
): Promise<string | undefined> {
  const plan = planTracking(workingCopy, newBranch, startRef, mode);
  return plan ? installTracking(workingCopy, newBranch, plan) : undefined;
}
