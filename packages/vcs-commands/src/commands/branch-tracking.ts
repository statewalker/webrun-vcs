/**
 * Upstream tracking of new branches, as git's `branch.c` sets it up (`setup_tracking`,
 * `install_branch_config_multiple_remotes`), and the remote-tracking branch git's checkout
 * and switch guess for a name no ref has (`checkout.c` `parse_remote_branch`,
 * `checkout.c`/`remote.c` `unique_tracking_name`). Checked against git 2.43 and 2.56.
 *
 * @example
 * ```typescript
 * // `git switch -c topic origin/topic`: branch.topic.remote=origin, .merge=refs/heads/topic
 * const { plan } = planTracking(workingCopy, "topic", "refs/remotes/origin/topic", TrackMode.DEFAULT);
 * if (plan) await installTracking(workingCopy, "topic", plan); // ["branch 'topic' set up to track 'origin/topic'."]
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
  return applyRefspecs(config.configuredFetchRefspecs(remote), src);
}

/**
 * git's `apply_refspecs`: the destination the refspecs map the ref `src` onto (the first
 * that matches it, a wildcard's `*` carried over), undefined when none does or a negative
 * refspec excludes it.
 *
 * @example
 * ```typescript
 * applyRefspecs(["+refs/heads/*:refs/remotes/origin/*"], "refs/heads/main"); // "refs/remotes/origin/main"
 * ```
 */
export function applyRefspecs(specStrings: string[], src: string): string | undefined {
  const specs = specStrings.map((spec) => parseRefSpec(spec));
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

/** The git version whose wording a tracking message follows (hints differ). */
export type TrackingCompatibility = "2.43" | "2.56";

/**
 * git's `advise()` lines of `text`: `hint: <line>`, an empty line `hint:` (2.43 wrote
 * `hint: ` with the space).
 */
export function hintLines(text: string, compatibility: TrackingCompatibility = "2.56"): string[] {
  return text
    .split("\n")
    .map((line) => (line === "" && compatibility !== "2.43" ? "hint:" : `hint: ${line}`));
}

/** The closing line of `advise_if_enabled`, as the version words it. */
export function disableHint(name: string, compatibility: TrackingCompatibility = "2.56"): string {
  const command = compatibility === "2.43" ? "git config" : "git config set";
  return `hint: Disable this message with "${command} advice.${name} false"`;
}

/** Whether an advice is enabled (`advice.<name>`, on unless set false). */
function adviceEnabled(config: RemoteConfigStore, name: string): boolean {
  const value = config.value(`advice.${name}`);
  return value === undefined ? true : (parseGitBool(value) ?? true);
}

/**
 * git's `upstream_missing` death of `dwim_branch_start` under `--track` /
 * `--set-upstream-to`: `fatal: the requested upstream branch '<start>' does not exist`,
 * with the `advice.setUpstreamFailure` hint.
 */
export function upstreamMissingError(
  workingCopy: WorkingCopy,
  start: string,
  compatibility: TrackingCompatibility = "2.56",
): InvalidArgumentError {
  const config = RemoteConfigStore.from(workingCopy);
  const lines = [`fatal: the requested upstream branch '${start}' does not exist`];
  if (adviceEnabled(config, "setUpstreamFailure")) {
    lines.push(
      ...hintLines(
        [
          "",
          "If you are planning on basing your work on an upstream",
          "branch that already exists at the remote, you may need to",
          'run "git fetch" to retrieve it.',
          "",
          "If you are planning to push out a new local branch that",
          "will track its remote counterpart, you may want to use",
          '"git push -u" to set the upstream config as you push.',
        ].join("\n"),
        compatibility,
      ),
      disableHint("setUpstreamFailure", compatibility),
    );
  }
  return new InvalidArgumentError("upstream", start, lines.join("\n"));
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
 * What {@link planTracking} decided: the plan (none when nothing is tracked) and the
 * warnings git prints instead (`warning: asked to inherit tracking from '<b>', but no
 * remote is set`, `warning: not setting branch '<b>' as its own upstream`).
 */
export interface TrackingDecision {
  readonly plan?: TrackingPlan;
  readonly warnings: string[];
}

/** Options of {@link planTracking}. */
export interface PlanTrackingOptions {
  /** The git version whose hints the refusals follow (default 2.56). */
  compatibility?: TrackingCompatibility;
}

/**
 * git's `setup_tracking` up to the point it writes: what a new branch that starts at the
 * branch `startRef` (a full ref name, see {@link trackableStart}) tracks, as `mode` and
 * `branch.autoSetupMerge` say. Nothing is written; {@link installTracking} does that.
 *
 * @returns the plan (none when nothing is tracked) with git's warnings
 * @throws RefNotFoundError when several remotes fetch into `startRef` (git's `not
 *   tracking: ambiguous information for ref '<ref>'` and the `advice.ambiguousFetchRefspec`
 *   hint)
 * @throws InvalidArgumentError when several refs are inherited and `branch.autoSetupRebase`
 *   asks for rebasing (`cannot inherit upstream tracking configuration of multiple refs
 *   when rebasing is requested`)
 */
export function planTracking(
  workingCopy: WorkingCopy,
  newBranch: string,
  startRef: string,
  mode: TrackMode,
  options: PlanTrackingOptions = {},
): TrackingDecision {
  const config = RemoteConfigStore.from(workingCopy);
  const track = effectiveTrack(config, mode);
  const none: TrackingDecision = { warnings: [] };
  if (track === "never") return none;

  let remote: string | undefined;
  let merges: string[] = [];
  let matches = 0;
  if (track === "inherit") {
    // inherit_tracking: branch_get(<bare>)'s remote and merge configuration
    const bare = startRef.replace(/^refs\/heads\//, "");
    remote = config.value(`branch.${bare}.remote`);
    merges = config.values(`branch.${bare}.merge`);
    if (!remote) {
      return {
        warnings: [`warning: asked to inherit tracking from '${bare}', but no remote is set`],
      };
    }
    if (merges.length === 0) {
      return {
        warnings: [
          `warning: asked to inherit tracking from '${bare}', but no merge configuration is set`,
        ],
      };
    }
  } else {
    const ambiguous: string[] = [];
    for (const name of config.configuredNames()) {
      const src = sourceForTracking(config, name, startRef);
      if (!src) continue;
      matches++;
      if (matches === 2 && remote) ambiguous.push(remote);
      if (matches >= 2) ambiguous.push(name);
      remote = name;
      merges = [src];
    }
    if (matches === 0 && track !== "always" && track !== "explicit") return none;
    if (matches > 1) {
      const lines = [`fatal: not tracking: ambiguous information for ref '${startRef}'`];
      if (adviceEnabled(config, "ambiguousFetchRefspec")) {
        lines.push(
          ...hintLines(
            [
              "There are multiple remotes whose fetch refspecs map to the remote",
              `tracking ref '${startRef}':`,
              ...ambiguous.map((name) => `  ${name}`),
              "",
              "This is typically a configuration error.",
              "",
              "To support setting up tracking branches, ensure that",
              "different remotes' fetch refspecs map into different",
              "tracking namespaces.",
            ].join("\n"),
            options.compatibility,
          ),
        );
      }
      throw new RefNotFoundError(startRef, lines.join("\n"));
    }
    if (track === "simple") {
      const tracked = merges[0]?.startsWith("refs/heads/") ? merges[0].slice(11) : undefined;
      if (tracked !== newBranch) return none;
    }
    if (merges.length === 0) merges = [startRef];
  }

  // install_branch_config_multiple_remotes
  const autoRebase = (config.value("branch.autoSetupRebase") ?? "never").toLowerCase();
  const rebase =
    autoRebase === "always" ||
    (autoRebase === "local" && remote === undefined) ||
    (autoRebase === "remote" && remote !== undefined);
  if (rebase && merges.length > 1) {
    throw new InvalidArgumentError(
      "track",
      startRef,
      "fatal: cannot inherit upstream tracking configuration of multiple refs when rebasing is requested",
    );
  }
  // never a branch as its own upstream
  if (!remote && merges.some((m) => m === `refs/heads/${newBranch}`)) {
    return { warnings: [`warning: not setting branch '${newBranch}' as its own upstream`] };
  }
  return { plan: { remote, merges, rebase }, warnings: [] };
}

/**
 * What git prints once it wrote a {@link TrackingPlan} (`BRANCH_CONFIG_VERBOSE`):
 * `branch '<b>' set up to track '<remote>/<branch>'.` (`... by rebasing.`), the local
 * branch's name alone for `remote = .` set up by `--track`, `./<branch>` for one inherited,
 * one line per upstream after `branch '<b>' set up to track:` for several.
 */
export function trackingMessage(newBranch: string, plan: TrackingPlan): string[] {
  const names = plan.merges.map((merge) => {
    const short = merge.replace(/^refs\/heads\//, "");
    return plan.remote !== undefined ? `${plan.remote}/${short}` : short;
  });
  if (names.length === 1) {
    return [
      plan.rebase
        ? `branch '${newBranch}' set up to track '${names[0]}' by rebasing.`
        : `branch '${newBranch}' set up to track '${names[0]}'.`,
    ];
  }
  return [`branch '${newBranch}' set up to track:`, ...names.map((name) => `  ${name}`)];
}

/**
 * Write a {@link TrackingPlan} as `branch.<newBranch>.*` and save the configuration, as
 * git's `install_branch_config_multiple_remotes`: `.remote` set, every `.merge` replaced,
 * `.rebase = true` when rebasing.
 *
 * @returns what git prints (see {@link trackingMessage})
 */
export async function installTracking(
  workingCopy: WorkingCopy,
  newBranch: string,
  plan: TrackingPlan,
): Promise<string[]> {
  const config = RemoteConfigStore.from(workingCopy);
  const { remote, merges } = plan;
  config.setValue(`branch.${newBranch}.remote`, remote ?? ".");
  // the merges replaced: every old one unset, the new ones added at the section's end
  config.unset(`branch.${newBranch}.merge`);
  for (const merge of merges) config.addValue(`branch.${newBranch}.merge`, merge);
  if (plan.rebase) config.setValue(`branch.${newBranch}.rebase`, "true");
  await config.save();
  return trackingMessage(newBranch, plan);
}
