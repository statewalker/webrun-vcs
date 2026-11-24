import { isValidRefName, parseCoreAbbrev } from "@statewalker/vcs-core";
import {
  countRefspecMatch,
  createRepositoryFacade,
  createTransportRefStore,
  expandFromSource,
  type ForceWithLease,
  formatPushStatus,
  mapRejectReason,
  matchSource,
  ObjectFormatMismatchError,
  objectSource,
  PushCertificateError,
  type PushClientResult,
  type PushCommandResult,
  PushRefspecError,
  type PushRefUpdate,
  PushRefusedByHookError,
  parseRefSpec,
  pushToConnection,
  type PushOptions as TransportPushOptions,
} from "@statewalker/vcs-transport";
import { parseGitBool, parseGitInt } from "@statewalker/vcs-utils/encoding";
import { isNullObjectId } from "@statewalker/vcs-utils/hash";

import {
  GitApiError,
  HookFailedError,
  IncompatibleOptionsError,
  InvalidArgumentError,
  InvalidConfigError,
  InvalidRemoteError,
  NonFastForwardError,
  PushRejectedException,
  TransportError,
} from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type PushResult, PushStatus, type RemoteRefUpdate } from "../results/push-result.js";
import { TransportCommand } from "../transport-command.js";
import { endOfSymbolicChain, installTracking, pushTrackingPlan } from "./branch-tracking.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { remoteHookSession } from "./local-transport.js";
import { withRemoteReceivePack } from "./remote-transport.js";
import { SIGNING_FAILED_LINES, SigningFailedError } from "./signing.js";
import {
  createSubmoduleAuthPolicy,
  guardSubmoduleTransports,
  strictUrlOrigin,
} from "./submodule-auth.js";
import { findUnpushedSubmodules, SubmoduleFetchRepository } from "./submodule-fetch.js";

/**
 * How a server's rejection reason (`ng <ref> <reason>`) lands on the statuses this package
 * reports. PushStatus, following JGit's RemoteRefUpdate, keeps only the non-fast-forward case
 * separate (callOrThrow raises NonFastForwardError for it); every other refusal is
 * REJECTED_OTHER with the server's message. Spelled out per reason so that a new transport
 * reason is a compile error here.
 */
const REJECT_REASON_STATUS: Record<PushCommandResult, PushStatus> = {
  NOT_ATTEMPTED: PushStatus.NOT_ATTEMPTED,
  OK: PushStatus.OK,
  REJECTED_NONFASTFORWARD: PushStatus.REJECTED_NONFASTFORWARD,
  REJECTED_NOCREATE: PushStatus.REJECTED_OTHER,
  REJECTED_NODELETE: PushStatus.REJECTED_OTHER,
  REJECTED_CURRENT_BRANCH: PushStatus.REJECTED_OTHER,
  REJECTED_MISSING_OBJECT: PushStatus.REJECTED_OTHER,
  REJECTED_OTHER_REASON: PushStatus.REJECTED_OTHER,
  LOCK_FAILURE: PushStatus.REJECTED_OTHER,
  ATOMIC_REJECTED: PushStatus.REJECTED_OTHER,
};

/**
 * The status of a transport update. git's local refusals map as JGit's: "fetch first" (the
 * remote has a commit we lack) and "non-fast-forward" are both REJECTED_NONFASTFORWARD, a
 * stale lease is REJECTED_REMOTE_CHANGED, a remote ref the server did not report is FAILED.
 */
function toPushStatus(update: PushRefUpdate): PushStatus {
  switch (update.status) {
    case "ok":
      return PushStatus.OK;
    case "up-to-date":
      return PushStatus.UP_TO_DATE;
    case "rejected-nonfastforward":
    case "rejected-fetch-first":
      return PushStatus.REJECTED_NONFASTFORWARD;
    case "rejected-stale":
    case "rejected-remote-updated":
      return PushStatus.REJECTED_REMOTE_CHANGED;
    case "remote-rejected":
      return REJECT_REASON_STATUS[mapRejectReason(update.message ?? "")];
    case "remote-failure":
      return PushStatus.FAILED;
    default:
      return PushStatus.REJECTED_OTHER;
  }
}

/**
 * Push objects and refs to a remote repository.
 *
 * Equivalent to `git push`.
 *
 * Based on JGit's PushCommand.
 *
 * @example
 * ```typescript
 * // Push current branch to origin
 * const result = await git.push().call();
 *
 * // Push to specific remote
 * const result = await git.push()
 *   .setRemote("upstream")
 *   .call();
 *
 * // Push specific refs
 * const result = await git.push()
 *   .add("refs/heads/feature:refs/heads/feature")
 *   .call();
 *
 * // Force push
 * const result = await git.push()
 *   .setForce(true)
 *   .call();
 *
 * // Delete remote branch (empty source ref). The resulting RemoteRefUpdate has
 * // `delete: true` and an all-zero `newObjectId`.
 * const result = await git.push()
 *   .add(":refs/heads/old-branch")
 *   .call();
 *
 * // Atomic push (all-or-nothing)
 * const result = await git.push()
 *   .setAtomic(true)
 *   .call();
 * ```
 */
export class PushCommand extends TransportCommand<PushResult> {
  /** The remote, once set or resolved in `call` (git's `pushremote_for_branch`) */
  private remote = "origin";
  private remoteGiven = false;
  /** Whether the remote was set or came from the configuration (git's `explicit`) */
  private remoteExplicit = false;
  private refSpecs: string[] = [];
  private force = false;
  private atomic = false;
  /** `--[no-]signed[=if-asked]` (undefined: `push.gpgSign`) */
  private signed?: boolean | "if-asked";
  private noVerify = false;
  /** `--recurse-submodules=<mode>`; unset: the configuration's */
  private recurseSubmodules?: PushRecurseSubmodules;
  /** `--recurse-submodules=only-is-on-demand`: a superproject's push of this submodule */
  private recurseFromSuperproject = false;

  /**
   * `--recurse-submodules=check|on-demand|only|no` (`--no-recurse-submodules` is `no`):
   * before the refs are sent, the submodules whose recorded commits (in the commits pushed,
   * not on the remote's tracking refs) are on none of the submodule's remote-tracking refs
   * are `check`ed (the push dies listing them), pushed first (`on-demand`: `git push` in each,
   * to the remote and refspecs given here when the remote is configured; then checked again
   * unless a dry run), or pushed alone (`only`: the superproject's refs are not sent). Unset,
   * `push.recurseSubmodules` and `submodule.recurse` (on-demand or no) decide, in config
   * order. What the submodules' pushes printed is {@link PushResult.submoduleOutput}.
   * A bare repository never recurses.
   */
  setRecurseSubmodules(mode: PushRecurseSubmodules | boolean): this {
    this.checkCallable();
    // option_parse_recurse_submodules: true, `yes` and other spellings die
    this.recurseSubmodules =
      mode === false ? "no" : parsePushRecurseSubmodules("recurse-submodules", String(mode));
    return this;
  }

  /** @internal `--recurse-submodules=only-is-on-demand`: run by a superproject's push. */
  setRecurseFromSuperproject(child: boolean): this {
    this.checkCallable();
    this.recurseFromSuperproject = child;
    return this;
  }

  /** `--no-verify`: the pre-push hook does not run. */
  setNoVerify(noVerify: boolean): this {
    this.checkCallable();
    this.noVerify = noVerify;
    return this;
  }
  private thin = true;
  private dryRun = false;
  private pushAll = false;
  private pushTags = false;
  private useBitmaps?: boolean;
  private pushOptions: string[] = [];
  private receivePack?: string;
  private prune = false;
  private streamRequestBody?: boolean;
  /** Leases (an entry without a ref: every other pushed ref at its tracking value) */
  private leases?: ForceWithLease[];
  /** `-u` / `--set-upstream` */
  private setUpstream = false;
  /** `--[no-]follow-tags` (undefined: `push.followTags`) */
  private followTags?: boolean;
  /** `--[no-]force-if-includes` (undefined: `push.useForceIfIncludes`) */
  private forceIfIncludes?: boolean;
  /** `--mirror` (undefined: `remote.<name>.mirror`) */
  private mirror?: boolean;
  /** `-d` / `--delete` */
  private deleteRefs = false;
  /** Whose messages to give where git 2.43 and 2.5x differ (undefined: the hook runner's) */
  private compatibility?: "2.43" | "2.56";

  /**
   * `--mirror` (true): every local ref (`refs/*`) is pushed to the same name, forced, and every
   * remote ref without a local one is deleted, as git's `TRANSPORT_PUSH_MIRROR`. Undefined
   * (the default) reads `remote.<name>.mirror` of a configured remote; false is no mirror,
   * whatever that says. A mirror push takes no refspecs, nor `setPushAll`, `setPushTags` or
   * `setDelete` (git's refusals).
   */
  setMirror(mirror: boolean | undefined): this {
    this.checkCallable();
    this.mirror = mirror;
    return this;
  }

  /** `--mirror` as set (undefined: `remote.<name>.mirror` decides in `call`). */
  isMirror(): boolean | undefined {
    return this.mirror;
  }

  /**
   * `-d` / `--delete`: each refspec is a remote ref to delete (`main` as `:main`, `tag v1` as
   * `:refs/tags/v1`); a `src:dst` refspec or an empty one is refused, and so is a delete with
   * no refspec, `setPushAll`, `setPushTags` or `setMirror`, as git refuses them.
   */
  setDelete(deleteRefs: boolean): this {
    this.checkCallable();
    this.deleteRefs = deleteRefs;
    return this;
  }

  /** Whether `setDelete` is on. */
  isDelete(): boolean {
    return this.deleteRefs;
  }

  /**
   * Whose messages to give where git 2.43 and 2.5x differ (the incompatible options of
   * `--delete`, `--tags`, `--all` and `--mirror`, and when they are checked). Default: the hook
   * runner's compatibility, else 2.56.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /**
   * `-u` / `--set-upstream`: each local branch pushed to a remote branch (accepted or already
   * up to date, not deleted) gets that branch of this remote as its upstream
   * (`branch.<name>.remote` = the remote's name, or the URL as given; `.merge` = the remote
   * ref), written as `git branch --set-upstream-to` writes it; git's `branch '<b>' set up to
   * track '<remote>/<branch>'.` lines are {@link PushResult.upstreamMessages}. A dry run
   * writes nothing and tells `Would set upstream of '<b>' to '<branch>' of '<remote>'`.
   */
  setSetUpstream(setUpstream: boolean): this {
    this.checkCallable();
    this.setUpstream = setUpstream;
    return this;
  }

  /**
   * `--follow-tags` (true) / `--no-follow-tags` (false); undefined (the default) reads
   * `push.followTags`. Also pushes every local annotated tag the remote lacks whose commit
   * the pushed refs reach (or the remote's refs that are not pushed), as git's
   * `add_missing_tags`; lightweight tags and tags of trees or blobs are never followed.
   */
  setFollowTags(followTags: boolean | undefined): this {
    this.checkCallable();
    this.followTags = followTags;
    return this;
  }

  /**
   * `--force-if-includes` (true) / `--no-force-if-includes` (false); undefined (the default)
   * reads `push.useForceIfIncludes`. With a `--force-with-lease` that expects a
   * remote-tracking value (no explicit value), a ref whose remote value is in no reflog entry
   * of the local ref of the same name, nor reachable from one made since the tracking ref's
   * last update, is refused ("remote ref updated since checkout",
   * {@link PushStatus.REJECTED_REMOTE_CHANGED}). Without a lease it does nothing, as in git.
   */
  setForceIfIncludes(forceIfIncludes: boolean | undefined): this {
    this.checkCallable();
    this.forceIfIncludes = forceIfIncludes;
    return this;
  }

  /**
   * Set the remote to push to.
   *
   * Can be either a remote name (e.g., "origin") or a URL. When none is set, `call` picks
   * the remote as `git push` does (`pushremote_for_branch`): `branch.<current>.pushRemote`,
   * `remote.pushDefault`, `branch.<current>.remote`, the one configured remote, else `origin`
   * (a detached HEAD skips the branch's settings).
   *
   * @param remote Remote name or URL
   */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    this.remoteGiven = true;
    this.remoteExplicit = true;
    return this;
  }

  /**
   * Get the remote being pushed to: the one set, or after `call` the one it chose (`origin`
   * before then).
   */
  getRemote(): string {
    return this.remote;
  }

  /**
   * Add a refspec to push.
   *
   * @param refSpec Refspec string (e.g., "refs/heads/main:refs/heads/main")
   */
  add(refSpec: string): this {
    this.checkCallable();
    this.refSpecs.push(refSpec);
    return this;
  }

  /**
   * Set refspecs to push.
   *
   * @param refSpecs Refspec strings
   */
  setRefSpecs(...refSpecs: string[]): this {
    this.checkCallable();
    this.refSpecs = refSpecs;
    return this;
  }

  /**
   * Set force push mode.
   *
   * When enabled, allows non-fast-forward updates.
   *
   * @param force Whether to force push
   */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /**
   * Whether force push is enabled.
   */
  isForce(): boolean {
    return this.force;
  }

  /**
   * `--force-with-lease`: allow a non-fast-forward of `ref` only while the remote ref still
   * has `expect` (`""` or the zero id: it must not exist). Without `expect` the remote ref's
   * remote-tracking value is expected (`refs/remotes/<remote>/...`). Without `ref` every pushed
   * ref (that no explicit lease names) is leased at its remote-tracking value; `expect` may be
   * a revision or an abbreviated id. A lease that does not hold is
   * REJECTED_REMOTE_CHANGED; {@link setForce} overrides it, as in git.
   *
   * @param ref The remote ref (full or short name)
   * @param expect The value it must have
   */
  setForceWithLease(ref?: string, expect?: string): this {
    this.checkCallable();
    this.leases ??= [];
    // without a ref: every other pushed ref at its remote-tracking value (git's bare
    // --force-with-lease, which explicit ones combine with)
    this.leases.push(ref === undefined ? {} : { ref, ...(expect !== undefined ? { expect } : {}) });
    return this;
  }

  /**
   * Stream the smart-HTTP request body (default: outside browsers, where supported); `false`
   * collects it first, so the request has a `Content-Length` (servers or proxies that refuse
   * chunked requests).
   */
  setStreamRequestBody(stream: boolean): this {
    this.checkCallable();
    this.streamRequestBody = stream;
    return this;
  }

  /** Whether the request body streams (undefined: the transport decides). */
  isStreamRequestBody(): boolean | undefined {
    return this.streamRequestBody;
  }

  /**
   * `--prune`: delete remote refs a pattern refspec's destination covers whose local source is
   * gone (with `+refs/*:refs/*`, `--mirror`).
   */
  setPrune(prune: boolean): this {
    this.checkCallable();
    this.prune = prune;
    return this;
  }

  /**
   * Set atomic push mode.
   *
   * When enabled, either all refs update or none do.
   *
   * @param atomic Whether to use atomic push
   */
  setAtomic(atomic: boolean): this {
    this.checkCallable();
    this.atomic = atomic;
    return this;
  }

  /**
   * `--signed` (true), `--no-signed` (false) or `--signed=if-asked`: whether to sign a push
   * certificate; undefined (the default) leaves it to `push.gpgSign` (a boolean or
   * `if-asked`). A server that takes no certificate refuses a signed push (`fatal: the
   * receiving end does not support --signed push`) and gets an `if-asked` one unsigned,
   * with git's warning ({@link PushResult.warnings}). Not signed yet: a certificate
   * the server takes fails as git fails when gpg cannot sign (`error: gpg failed to sign
   * the data:`, `fatal: failed to sign the push certificate`, exit 128:
   * {@link SigningFailedError}), before anything is sent.
   */
  setSigned(signed: boolean | "if-asked" | undefined): this {
    this.checkCallable();
    this.signed = signed;
    return this;
  }

  /**
   * The push certificate asked for (git's SEND_PACK_PUSH_CERT_*): the option, else
   * `push.gpgSign` (a boolean or `if-asked`, case-insensitive; another value signs nothing).
   */
  private pushCertMode(): "always" | "if-asked" | undefined {
    let value: boolean | "if-asked" | undefined = this.signed;
    if (value === undefined) {
      const raw = RemoteConfigStore.from(this.workingCopy).value("push.gpgSign");
      if (raw !== undefined) {
        value = raw.trim().toLowerCase() === "if-asked" ? "if-asked" : parseGitBool(raw);
      }
    }
    return value === true ? "always" : value === "if-asked" ? "if-asked" : undefined;
  }

  /**
   * Whether atomic push is enabled.
   */
  isAtomic(): boolean {
    return this.atomic;
  }

  /**
   * Set thin-pack preference.
   *
   * @param thin Whether to use thin packs
   */
  setThin(thin: boolean): this {
    this.checkCallable();
    this.thin = thin;
    return this;
  }

  /**
   * Whether thin packs are enabled.
   */
  isThin(): boolean {
    return this.thin;
  }

  /**
   * Set dry run mode.
   *
   * In dry run mode, refs are not actually updated on remote.
   *
   * @param dryRun Whether to do a dry run
   */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /**
   * Whether dry run mode is enabled.
   */
  isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * Set whether to push all branches.
   *
   * @param pushAll Whether to push all branches
   */
  setPushAll(pushAll: boolean): this {
    this.checkCallable();
    this.pushAll = pushAll;
    return this;
  }

  /**
   * Set whether to push all tags.
   *
   * @param pushTags Whether to push all tags
   */
  setPushTags(pushTags: boolean): this {
    this.checkCallable();
    this.pushTags = pushTags;
    return this;
  }

  /**
   * Set whether to use bitmaps for push.
   *
   * Default: `push.useBitmaps` (default true), which git's send-pack turns into
   * `--no-use-bitmap-index` when false. Either way pack-objects uses them only while the
   * repository's `pack.useBitmaps` (default true) allows.
   *
   * @param useBitmaps Whether to use bitmaps
   */
  setUseBitmaps(useBitmaps: boolean): this {
    this.checkCallable();
    this.useBitmaps = useBitmaps;
    return this;
  }

  /**
   * Whether bitmaps are used for push: `setUseBitmaps`, else `push.useBitmaps` (default true).
   */
  isUseBitmaps(): boolean {
    return this.useBitmaps ?? this.configBool("push.useBitmaps") ?? true;
  }

  /** Whether pack-objects lists the pushed objects through a bitmap (see `setUseBitmaps`). */
  private bitmapsInUse(): boolean {
    return this.isUseBitmaps() && (this.configBool("pack.useBitmaps") ?? true);
  }

  /** `core.maxTreeDepth` (git's default 2048 when unset or unreadable). */
  private maxTreeDepth(): number | undefined {
    const value = RemoteConfigStore.from(this._workingCopy).value("core.maxTreeDepth");
    return value === undefined ? undefined : parseGitInt(value);
  }

  private configBool(key: string): boolean | undefined {
    const value = RemoteConfigStore.from(this._workingCopy).value(key);
    return value === undefined ? undefined : (parseGitBool(value) ?? undefined);
  }

  /**
   * Set push options associated with the push operation.
   *
   * Push options are strings passed to the receive-pack on the server
   * side, where they can be used by hooks (`GIT_PUSH_OPTION_COUNT`, `GIT_PUSH_OPTION_<n>`).
   * As git's `-o`: when none are given, `push.pushOption` gives them (each value added in
   * order, an empty value clearing the list). A server that does not advertise them
   * (`receive.advertisePushOptions`) refuses the push before anything is sent.
   *
   * @param options Push option strings
   */
  setPushOptions(options: string[]): this {
    this.checkCallable();
    this.pushOptions = [...options];
    return this;
  }

  /**
   * Get push options.
   */
  getPushOptions(): string[] {
    return [...this.pushOptions];
  }

  /**
   * Set the remote executable providing receive-pack service.
   *
   * @param receivePack Name of the remote executable
   */
  setReceivePack(receivePack: string): this {
    this.checkCallable();
    this.receivePack = receivePack;
    return this;
  }

  /**
   * Get the receive-pack executable name.
   */
  getReceivePack(): string | undefined {
    return this.receivePack;
  }

  /**
   * Execute the push.
   *
   * Runs the transport's push client (git's send-pack): the refspecs are mapped onto the
   * remote refs as `git push` does (short names, `HEAD`, patterns, `:dst` deletes); each ref
   * is checked first (fast-forward, "fetch first", tags, `--force-with-lease`) and refused
   * refs are not sent; the pack is thin against the remote refs here. Once the server accepts
   * a ref, the remote-tracking ref of a named remote follows it (`refs/remotes/<remote>/…`).
   *
   * Without refspecs (nor `setPushAll`/`setPushTags`), the configured `remote.<name>.push`
   * refspecs are used, else `push.default` decides (default `simple`: the current branch to
   * its upstream of the same name on its own remote, to the same name elsewhere; see
   * `buildRefSpecs`). A detached HEAD is refused.
   *
   * @returns Push result with each remote ref's status
   * @throws InvalidRemoteError if remote cannot be resolved
   */
  async call(): Promise<PushResult> {
    this.checkCallable();
    this.setCallable(false);
    const compatibility = this.compatibility ?? this.hooks.compatibility;

    // git_push_config: push.pushOption is read (and a bad one dies) before anything else;
    // the command line's options replace the configured ones
    const configuredOptions = this.configuredPushOptions();
    const submoduleWarnings: string[] = [];
    const recurse = this.pushRecursion(submoduleWarnings);
    const transmitted = this.pushOptions.length > 0 ? this.pushOptions : configuredOptions;
    this.checkOptionCombinations(compatibility);
    if (this.deleteRefs && this.refSpecs.length === 0) {
      throw new InvalidArgumentError(
        "refspecs",
        undefined,
        "--delete doesn't make sense without any refs",
      );
    }
    // 2.43 checks the refspecs given before it looks the remote up
    if (compatibility === "2.43") this.checkRefspecArguments();

    // pushremote_get(NULL): the push remote the configuration names for the current branch
    if (!this.remoteGiven) {
      const ref = await this.getCurrentBranch();
      const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
      const choice = RemoteConfigStore.from(this.workingCopy).pushRemoteChoiceForBranch(branch);
      this.remote = choice.name;
      this.remoteExplicit = choice.explicit;
    }
    // pushremote_get: a remote the configuration gives no URL may come from .git/remotes/ or
    // .git/branches/ (git 2.x)
    const legacyWarnings = await this.loadLegacyRemote(this.remote);
    const warnings = legacyWarnings.length > 0 ? { warnings: legacyWarnings } : {};
    // git's push.c: a fallback remote (the one configured, origin) must be configured
    // (remote_get(NULL) gives no remote otherwise); a name given or taken from the
    // configuration is also tried as a URL or path (remotes_remote_get_1's add_url_alias)
    if (
      !this.remoteExplicit &&
      !RemoteConfigStore.from(this.workingCopy).isConfigured(this.remote)
    ) {
      throw new InvalidRemoteError(
        this.remote,
        "No configured push destination.\nEither specify the URL from the command-line or " +
          "configure a remote repository using\n\n    git remote add <name> <url>\n\n" +
          "and then push using the remote name\n\n    git push <name>" +
          // 2.5x's remote groups
          (compatibility === "2.43"
            ? ""
            : "\n\nTo push to multiple remotes at once, configure a remote group using\n\n" +
              '    git config remotes.<groupname> "<remote1> <remote2>"\n\n' +
              "and then push using the group name\n\n    git push <groupname>"),
      );
    }
    const remoteUrl = await this.resolveRemoteUrl(this.remote);
    if (!remoteUrl) {
      throw new InvalidRemoteError(this.remote);
    }
    // a mirror remote (remote.<name>.mirror) pushes as --mirror; --mirror implies --force
    const mirror = this.mirror ?? this.remoteMirror();
    const checks = this.remoteChecks(compatibility, mirror);
    if (compatibility === "2.43") checks();
    for (const option of transmitted) {
      if (option.includes("\n")) {
        throw new InvalidArgumentError(
          "pushOptions",
          option,
          "push options must not have new line characters",
        );
      }
    }
    if (compatibility !== "2.43") {
      checks();
      this.checkRefspecArguments();
    }

    // transport_get: the remote's transport is decided (git's errors for one that cannot be
    // reached) before the refspecs are worked out
    const resolved = this.resolveRemote(remoteUrl);
    const defaults = { setUpstream: false };
    const refspecs = await this.buildRefSpecs(mirror, defaults, compatibility);
    const setUpstream = this.setUpstream || defaults.setUpstream;
    if (refspecs.length === 0) {
      return {
        uri: remoteUrl,
        remoteUpdates: [],
        bytesSent: 0,
        objectCount: 0,
        messages: [],
        ...warnings,
      };
    }

    const remote = await this.openRemote(resolved);
    const localRemote = remote.kind === "local" ? remote.repository : undefined;
    const history = this._workingCopy.history;
    const tracking = this.trackingRefMapper(remoteUrl, compatibility);
    const messages: string[] = [];
    const leases = this.leases;
    const repository = createRepositoryFacade({
      history,
      useBitmaps: this.bitmapsInUse(),
      // send-pack's pack-objects reads core.maxTreeDepth
      maxTreeDepth: this.maxTreeDepth(),
    });
    // builtin/push.c: --force-if-includes counts only with a lease
    const forceIfIncludes =
      leases !== undefined &&
      leases.length > 0 &&
      (this.forceIfIncludes ?? this.configBool("push.useForceIfIncludes") ?? false);
    // transport_push: the submodules (not of a bare repository) once the hook passed
    const recurseOnPush =
      recurse !== undefined && new SubmoduleFetchRepository(this.workingCopy).hasWorktree();
    const submoduleOutput = { text: submoduleWarnings.map((w) => `${w}\n`).join("") };
    const pushOptions: TransportPushOptions = {
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      repository,
      refStore: createTransportRefStore(history.refs),
      refspecs,
      force: this.force || mirror,
      atomic: this.atomic,
      ...(this.pushCertMode() ? { signed: this.pushCertMode() } : {}),
      thin: this.thin,
      dryRun: this.dryRun,
      prune: this.prune,
      mirror,
      streamRequestBody: this.streamRequestBody,
      pushOptions: transmitted.length > 0 ? transmitted : undefined,
      forceWithLease: leases,
      trackingValue: async (remoteRef) => {
        const local = tracking(remoteRef);
        return local ? (await history.refs.resolve(local))?.objectId : undefined;
      },
      ...(forceIfIncludes
        ? {
            includesRemote: (remoteRef: string, remoteOid: string) =>
              this.isReachableInReflog(remoteRef, tracking(remoteRef), remoteOid, repository),
          }
        : {}),
      followTags: this.followTags ?? this.configBool("push.followTags") ?? false,
      onProgress: (message) => {
        messages.push(message);
        this.progressMessageCallback?.(message);
      },
      abbrev: parseCoreAbbrev(RemoteConfigStore.from(this._workingCopy).value("core.abbrev")) ?? -1,
      ...((!this.noVerify && this.hooks.enabled) || recurseOnPush
        ? {
            prePush: async (updates) => {
              if (
                !this.noVerify &&
                this.hooks.enabled &&
                !(await this.runPrePush(updates, remoteUrl, (code) => (prePushExit = code)))
              ) {
                return false;
              }
              if (recurseOnPush) {
                await this.pushSubmodulesFirst(
                  recurse,
                  updates,
                  refspecs,
                  transmitted,
                  remoteUrl,
                  submoduleOutput,
                );
              }
              return true;
            },
          }
        : {}),
    };
    let prePushExit = 0;
    // git's local transport (receive-pack of the repository at the path, in process), or the
    // connector the transport registry names (smart HTTP by default)
    let result: PushClientResult;
    // the remote's reference-transaction hook writes to the pushing user's stderr directly
    const transactionHooks =
      localRemote === undefined
        ? undefined
        : remoteHookSession(this.workingCopy, localRemote, { localPush: true });
    const environment = hostEnvironmentOf(this.workingCopy);
    const receiveWarnings: string[] = [];
    // --receive-pack, else remote.<name>.receivepack
    const receivePack = this.receivePack ?? this.remoteProgram(this.remote, "receivepack");
    try {
      result = await withRemoteReceivePack(
        remote,
        {
          ...this.remoteSessionOptions(),
          streamRequestBody: this.streamRequestBody,
          ...(receivePack !== undefined ? { program: receivePack } : {}),
        },
        (connection) => pushToConnection(connection, pushOptions),
        // receive-pack runs the remote repository's hooks
        localRemote === undefined
          ? undefined
          : remoteHookSession(this.workingCopy, localRemote, { localPush: true }),
        transactionHooks,
        {
          host: {
            ...(environment ? { environment } : {}),
            compatibility: this.hooks.compatibility,
          },
          // receive-pack's config warnings reach the shared stderr
          onWarning: (line) => receiveWarnings.push(line),
        },
      );
    } catch (error) {
      // match_push_refs' refusals: errors (git exits 1 with "failed to push some refs"), or
      // deaths for a refspec or a lease it cannot parse
      if (error instanceof PushRefspecError) {
        if (/^(invalid refspec|cannot parse expected object name) /.test(error.message)) {
          throw new TransportError(`fatal: ${error.message}`, undefined, { cause: error });
        }
        throw new TransportError(
          `error: ${error.message}\nerror: failed to push some refs to '${remoteUrl}'`,
          undefined,
          { cause: error, exitCode: 1 },
        );
      }
      // send_pack dies: --atomic or push options the server does not advertise
      if (
        error instanceof Error &&
        !(error instanceof TransportError) &&
        /^the receiving end does not support (--atomic push|push options)$/.test(error.message)
      ) {
        throw new TransportError(`fatal: ${error.message}`, undefined, { cause: error });
      }
      // send_pack dies: the remote's repository names objects with another hash
      if (error instanceof ObjectFormatMismatchError) {
        throw new TransportError(`fatal: ${error.message}`, undefined, { cause: error });
      }
      // send_pack dies: no push certificate for this server, or none could be signed
      if (error instanceof PushCertificateError) {
        if (error.reason === "unsupported") {
          throw new TransportError(`fatal: ${error.message}`, undefined, { cause: error });
        }
        throw new SigningFailedError(
          [...SIGNING_FAILED_LINES, `fatal: ${error.message}`].join("\n"),
          "",
          128,
        );
      }
      // --recurse-submodules=only: the submodules pushed, nothing sent for the superproject
      if (error instanceof SubmodulesOnlyPushed) {
        return {
          uri: remoteUrl,
          remoteUpdates: [],
          bytesSent: 0,
          objectCount: 0,
          messages,
          ...warnings,
          display: this.quietOutput ? [] : ["Everything up-to-date"],
          ...(submoduleOutput.text ? { submoduleOutput: submoduleOutput.text } : {}),
        };
      }
      if (
        error instanceof GitApiError &&
        submoduleOutput.text &&
        !error.message.startsWith(submoduleOutput.text)
      ) {
        error.message = `${submoduleOutput.text}${error.message}`;
      }
      if (error instanceof PushRefusedByHookError) {
        throw new HookFailedError(
          "pre-push",
          prePushExit,
          `error: failed to push some refs to '${remoteUrl}'`,
          this.hooks.output,
        );
      }
      throw error;
    } finally {
      if (transactionHooks) this.hooks.append(transactionHooks.output);
    }

    // transport_push: set_upstreams, before the remote-tracking refs are updated
    const upstreamMessages = setUpstream ? await this.setUpstreams(result.updates) : [];

    // git updates the remote-tracking refs of what the server accepted, and of what it had
    // already (transport.c: update_tracking_ref for ok and up-to-date refs)
    // receive_status's lines (read with the report), then the tracking refs' errors
    const trackingErrors: string[] = [...(result.reportErrors ?? [])];
    const objects = history.objects;
    // odb_has_object; a store without its object kernel asks the typed stores
    const objectExists = async (id: string): Promise<boolean> => {
      if (objects) return objects.has(id).catch(() => false);
      for (const s of [this.commits, this.trees, this.blobs, this.tagsStore]) {
        if (s && (await s.has(id).catch(() => false))) return true;
      }
      return false;
    };
    if (!this.dryRun) {
      for (const update of result.updates) {
        if (update.status !== "ok" && update.status !== "up-to-date") continue;
        // transport_update_tracking_ref: one per report of the server (its ref and new id
        // where it names them), else the update's own
        const targets = update.reports?.length
          ? update.reports.map((r) => ({
              ref: r.refName ?? update.remoteRef,
              oid: r.newOid ?? update.newOid,
            }))
          : [{ ref: update.remoteRef, oid: update.newOid }];
        for (const target of targets) {
          const local = tracking(target.ref);
          if (!local) continue;
          // update_one_tracking_ref: refs_delete_ref / refs_update_ref, whose refusals are
          // error lines (the push is done: git exits 0). The names and ids come from the
          // server (a proc-receive hook's `option refname` / `new-oid`): a bad name or an
          // object we lack is refused, as refs.c's transaction refuses it
          if (isNullObjectId(target.oid)) {
            if (!refNameIsSafe(local)) {
              trackingErrors.push(`error: refusing to update ref with bad name '${local}'`);
              continue;
            }
            // a safe name no ref store holds (`a..b`) has nothing to delete
            if (!isValidRefName(local, { allowOneLevel: true })) continue;
            try {
              await history.refs.remove(local);
            } catch (e) {
              trackingErrors.push(`error: ${errorText(e)}`);
            }
            continue;
          }
          const failed = (reason: string) =>
            trackingErrors.push(`error: update_ref failed for ref '${local}': ${reason}`);
          if (!isValidRefName(local, { allowOneLevel: true })) {
            failed(`refusing to update ref with bad name '${local}'`);
            continue;
          }
          if (!(await objectExists(target.oid))) {
            // 2.43's files backend wraps the error in "cannot update ref"; 2.5x's
            // ref_transaction_update says it alone
            const reason = `trying to write ref '${local}' with nonexistent object ${target.oid}`;
            failed(
              this.hooks.compatibility !== "2.43"
                ? reason
                : `cannot update ref '${local}': ${reason}`,
            );
            continue;
          }
          try {
            // git's update_tracking_ref: "update by push"
            await history.refs.set(local, target.oid, this.reflogLine("update by push"));
          } catch (e) {
            failed(errorText(e));
          }
        }
      }
    }

    const remoteUpdates: RemoteRefUpdate[] = result.updates.map((update) => ({
      ...(update.localRef ? { srcRef: update.localRef } : {}),
      remoteName: update.remoteRef,
      expectedOldObjectId: update.expectedOid ?? update.oldOid,
      newObjectId: update.newOid,
      status: toPushStatus(update),
      message: update.message ?? (update.status === "ok" ? undefined : update.summary),
      summary: update.summary,
      forceUpdate: update.force,
      delete: isNullObjectId(update.newOid),
      ...(update.reports?.length
        ? {
            reports: update.reports.map((r) => ({
              ...(r.refName !== undefined ? { refName: r.refName } : {}),
              ...(r.oldOid !== undefined ? { oldObjectId: r.oldOid } : {}),
              ...(r.newOid !== undefined ? { newObjectId: r.newOid } : {}),
              ...(r.forcedUpdate ? { forcedUpdate: true } : {}),
            })),
          }
        : {}),
    }));

    return {
      uri: remoteUrl,
      remoteUpdates,
      bytesSent: result.bytesSent,
      objectCount: result.packObjects,
      messages,
      // git's order: the legacy-remote deprecation, receive-pack's startup warnings (a local
      // push), then send-pack's (an unsent push certificate)
      ...(legacyWarnings.length + receiveWarnings.length + (result.warnings?.length ?? 0) > 0
        ? { warnings: [...legacyWarnings, ...receiveWarnings, ...(result.warnings ?? [])] }
        : {}),
      display: formatPushStatus(result, { dest: remoteUrl }),
      porcelain: formatPushStatus(result, { dest: remoteUrl, porcelain: true }),
      ...(trackingErrors.length ? { errors: trackingErrors } : {}),
      ...(upstreamMessages.length ? { upstreamMessages } : {}),
      // send_pack left at once (nothing to push to a remote without refs): the receiving end
      // hung up, and git fails
      ...(result.reportFailed || result.noRefsInCommon ? { failed: true } : {}),
      ...(submoduleOutput.text ? { submoduleOutput: submoduleOutput.text } : {}),
    };
  }

  /**
   * builtin/push.c's `recurse_submodules`: `push.recurseSubmodules` and `submodule.recurse`
   * in config order, then the command line; undefined for none (`no`). A superproject's push
   * of this submodule takes `only` as `on-demand`, with git's warning.
   */
  private pushRecursion(warnings: string[]): Exclude<PushRecurseSubmodules, "no"> | undefined {
    let mode: PushRecurseSubmodules | undefined;
    const store = RemoteConfigStore.from(this._workingCopy);
    for (const entry of store.entriesWithOriginFor([
      "push.recursesubmodules",
      "submodule.recurse",
    ]) ?? []) {
      if (entry.key === "submodule.recurse") {
        const bool = entry.text === undefined ? true : parseGitBool(entry.text);
        if (bool === undefined) {
          throw new GitApiError(
            `fatal: bad boolean config value '${entry.text}' for 'submodule.recurse'`,
            { exitCode: 128 },
          );
        }
        mode = bool ? "on-demand" : "no";
      } else mode = parsePushRecurseSubmodules("push.recursesubmodules", entry.text);
    }
    if (this.recurseFromSuperproject) {
      if (mode === "only") {
        warnings.push(
          "warning: recursing into submodule with push.recurseSubmodules=only; using on-demand instead",
        );
        mode = "on-demand";
      }
    } else if (this.recurseSubmodules !== undefined) mode = this.recurseSubmodules;
    return mode === undefined || mode === "no" ? undefined : mode;
  }

  /** git's `-q`: never set here (the report is the caller's to print) */
  private readonly quietOutput = false;

  /**
   * transport.c's submodule steps of `transport_push`: `push_unpushed_submodules` for
   * on-demand and only, then the `find_unpushed_submodules` check for check (and on-demand
   * and only unless a dry run); `only` then stops the push ({@link SubmodulesOnlyPushed}).
   */
  private async pushSubmodulesFirst(
    mode: Exclude<PushRecurseSubmodules, "no">,
    updates: readonly PushRefUpdate[],
    refspecs: readonly string[],
    pushOptions: readonly string[],
    remoteUrl: string,
    output: { text: string },
  ): Promise<void> {
    const commits = updates.map((u) => u.newOid).filter((id) => id && !isNullObjectId(id));
    const store = RemoteConfigStore.from(this._workingCopy);
    const configured = store.isConfigured(this.remote);
    const remoteName = configured ? this.remote : remoteUrl;
    const warn = (line: string) => {
      output.text += `${line}\n`;
    };
    const die = (message: string): never => {
      throw new GitApiError(`${output.text}${message}`, { exitCode: 128 });
    };
    if (mode === "on-demand" || mode === "only") {
      const needs = await findUnpushedSubmodules(this.workingCopy, commits, remoteName, warn);
      if (needs.length > 0) {
        if (configured) {
          const head = await this.refsStore.get("HEAD").catch(() => undefined);
          const headName =
            head && "target" in head && typeof head.target === "string" ? head.target : "HEAD";
          for (const path of needs) {
            const refusal = await this.submodulePushCheck(path, headName, refspecs);
            if (refusal !== undefined) {
              output.text += `${refusal}\n`;
              die(`fatal: process for submodule '${path}' failed`);
            }
          }
        }
        let ok = true;
        for (const path of needs) {
          output.text += `Pushing submodule '${path}'\n`;
          if (!(await this.pushSubmodule(path, configured, refspecs, pushOptions, output))) {
            output.text += `Unable to push submodule '${path}'\n`;
            ok = false;
          }
        }
        if (!ok) die("fatal: failed to push all needed submodules");
      }
    }
    if (mode === "check" || !this.dryRun) {
      const needs = await findUnpushedSubmodules(this.workingCopy, commits, remoteName, warn);
      if (needs.length > 0) {
        die(
          [
            "The following submodule paths contain changes that can",
            "not be found on any remote:",
            ...needs.map((p) => `  ${p}`),
            "",
            "Please try",
            "",
            "\tgit push --recurse-submodules=on-demand",
            "",
            "or cd to the path and use",
            "",
            "\tgit push",
            "",
            "to push them to a remote.",
            "",
            "fatal: Aborting.",
          ].join("\n"),
        );
      }
    }
    if (mode === "only") throw new SubmodulesOnlyPushed();
  }

  /** The submodule's repository at `path` (populated). */
  private async openSubmodulePath(path: string) {
    return this.worktreeAccess?.openGitlink?.(path).catch(() => undefined);
  }

  /**
   * submodule.c's `push_submodule`: `git push --recurse-submodules=only-is-on-demand
   * [--dry-run] [--push-option=...] [<remote> <refspec>...]` in the submodule, when it has
   * remote-tracking refs; false when that push failed.
   */
  private async pushSubmodule(
    path: string,
    configured: boolean,
    refspecs: readonly string[],
    pushOptions: readonly string[],
    output: { text: string },
  ): Promise<boolean> {
    const inner = await this.openSubmodulePath(path);
    if (!inner) return true;
    const remotes = await new SubmoduleFetchRepository(inner).refTipsUnder("refs/remotes/");
    if (remotes.length === 0) return true;
    const child = new PushCommand(inner).setRecurseFromSuperproject(true);
    child.shareHooksOf(this);
    child.setTransports(this.submoduleTransports());
    if (this.timeout !== undefined) child.setTimeout(this.timeout);
    if (this.dryRun) child.setDryRun(true);
    if (pushOptions.length > 0) child.setPushOptions([...pushOptions]);
    if (configured) {
      child.setRemote(this.remote);
      if (refspecs.length > 0) child.setRefSpecs(...refspecs);
    }
    if (this.compatibility) child.setCompatibility(this.compatibility);
    try {
      const result = await child.call();
      output.text += pushOutputText(result);
      return pushSucceeded(result);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      output.text += `${error.message.replace(/\n$/, "")}\n`;
      return false;
    }
  }

  /**
   * The transports a submodule's push goes through: a submodule's URL is repository content,
   * so this push's credentials and headers go only to its own remote's origin.
   */
  private submoduleTransports() {
    const transports = this.getTransports();
    if (!this.credentials && !this.headers) return transports;
    const url = RemoteConfigStore.from(this._workingCopy).remoteUrlOf(this.remote);
    const origin = strictUrlOrigin(url);
    return guardSubmoduleTransports(
      transports,
      createSubmoduleAuthPolicy({
        ...(this.credentials ? { credentials: this.credentials } : {}),
        ...(this.headers ? { headers: this.headers } : {}),
        origins: origin !== undefined ? [origin] : [],
      }),
    );
  }

  /**
   * `git submodule--helper push-check <head> <remote> <refspec>...` in the submodule: its
   * `fatal:` line when the remote is not configured there or a refspec's source names no
   * single ref (`HEAD` only when the submodule is on the superproject's branch).
   */
  private async submodulePushCheck(
    path: string,
    superHead: string,
    refspecs: readonly string[],
  ): Promise<string | undefined> {
    const inner = await this.openSubmodulePath(path);
    if (!inner) return undefined;
    const repo = new SubmoduleFetchRepository(inner);
    const head = await repo.headRef();
    if (head === undefined) return "fatal: Failed to resolve HEAD as a valid ref.";
    if (!RemoteConfigStore.from(inner).isConfigured(this.remote)) {
      return `fatal: remote '${this.remote}' not configured`;
    }
    const names = [...(await repo.refTips()).keys()];
    for (const raw of refspecs) {
      const spec = raw.startsWith("+") ? raw.slice(1) : raw;
      if (spec === ":" || spec.includes("*")) continue;
      const colon = spec.indexOf(":");
      const src = colon < 0 ? spec : spec.slice(0, colon);
      if (src === "") continue;
      const candidates = [
        src,
        `refs/${src}`,
        `refs/tags/${src}`,
        `refs/heads/${src}`,
        `refs/remotes/${src}`,
        `refs/remotes/${src}/HEAD`,
      ];
      const count = new Set(candidates.filter((c) => names.includes(c))).size;
      if (count === 1) continue;
      if (count === 0 && src === "HEAD") {
        if (head !== "HEAD" && head === superHead) continue;
        return "fatal: HEAD does not match the named branch in the superproject";
      }
      return `fatal: src refspec '${src}' must name a ref`;
    }
    return undefined;
  }

  /**
   * transport.c's pre-push hook: told the remote's name (its URL when pushed to by URL) and
   * URL, with a `<local ref> <local id> <remote ref> <remote id>` line on stdin for each ref
   * to be pushed (not those up to date, non-fast-forward or with a stale lease). Its stdout
   * stays git's stdout (`getHookStdout`). Whether the push may go on.
   */
  private async runPrePush(
    updates: readonly PushRefUpdate[],
    remoteUrl: string,
    exit: (code: number) => void,
  ): Promise<boolean> {
    const skipped = new Set([
      "rejected-nonfastforward",
      "rejected-remote-updated",
      "rejected-stale",
      "up-to-date",
    ]);
    const zero = this.objectFormat.nullId;
    const stdin = updates
      .filter((u) => !skipped.has(u.status))
      .map((u) => {
        const local = u.localRef ?? u.source ?? (/^0+$/.test(u.newOid) ? "(delete)" : u.newOid);
        return `${local} ${u.newOid || zero} ${u.remoteRef} ${u.oldOid || zero}\n`;
      })
      .join("");
    const result = await this.hooks.run("pre-push", {
      args: [this.remote, remoteUrl],
      stdin,
      keepStdout: true,
    });
    if (!result || result.exitCode === 0) return true;
    exit(result.exitCode);
    return false;
  }

  /**
   * transport.c's `set_upstreams`: each update accepted or up to date, not a delete, whose
   * local side is a branch (a symbolic ref such as HEAD followed to its branch) and whose
   * remote side is a branch, sets that branch's upstream through `installTracking`; a dry run
   * only says what it would set. git's stdout lines.
   */
  private async setUpstreams(updates: readonly PushRefUpdate[]): Promise<string[]> {
    const lines: string[] = [];
    for (const update of updates) {
      if (update.status !== "ok" && update.status !== "up-to-date") continue;
      if (isNullObjectId(update.newOid)) continue;
      // the peer ref: the local ref matched, else HEAD for a `HEAD` source
      let local = update.localRef ?? (update.source === "HEAD" ? "HEAD" : undefined);
      if (!local) continue;
      const end = await endOfSymbolicChain(this.refsStore, local);
      if (end?.startsWith("refs/heads/")) local = end;
      if (!local.startsWith("refs/heads/") || !update.remoteRef.startsWith("refs/heads/")) {
        continue;
      }
      const branch = local.slice("refs/heads/".length);
      if (this.dryRun) {
        lines.push(
          `Would set upstream of '${branch}' to '${update.remoteRef.slice("refs/heads/".length)}' of '${this.remote}'`,
        );
        continue;
      }
      const plan = pushTrackingPlan(this.workingCopy, this.remote, update.remoteRef);
      lines.push(...(await installTracking(this.workingCopy, branch, plan)));
    }
    return lines;
  }

  /**
   * remote.c's `is_reachable_in_reflog` for `--force-if-includes`: whether the remote's value
   * (peeled to a commit) is the new value of an entry of the local ref's reflog (the local ref
   * of the remote ref's name), or an ancestor of one of the entries read until one older than
   * the remote-tracking ref's latest reflog entry.
   */
  private async isReachableInReflog(
    localRef: string,
    trackingRef: string | undefined,
    remoteOid: string,
    repository: ReturnType<typeof createRepositoryFacade>,
  ): Promise<boolean> {
    const objects = objectSource(repository);
    const commit = await objects.peelToCommit(remoteOid);
    if (!commit) return false;
    const refs = this.refsStore;
    // git leaves the date unset without a tracking reflog: nothing stops the walk early
    const latest = trackingRef
      ? (await (await refs.getReflog?.(trackingRef))?.getLastEntry())?.who.timestamp
      : undefined;
    const since = latest ?? Number.NEGATIVE_INFINITY;
    const entries = (await (await refs.getReflog?.(localRef))?.getReverseEntries()) ?? [];
    const collected: string[] = [];
    for (const entry of entries) {
      if (entry.newId === commit) return true;
      const entryCommit = isNullObjectId(entry.newId)
        ? undefined
        : await objects.peelToCommit(entry.newId);
      if (entryCommit) collected.push(entryCommit);
      if (entry.who.timestamp < since) break;
    }
    for (const c of collected) {
      if (await objects.isAncestor(commit, c)) return true;
    }
    return false;
  }

  /**
   * Push and throw on failure.
   */
  async callOrThrow(): Promise<PushResult> {
    const result = await this.call();
    if (result.failed) {
      // git's "failed to push some refs to '<url>'"
      throw new TransportError("failed to push some refs", result.uri, { exitCode: 1 });
    }

    for (const update of result.remoteUpdates) {
      if (update.status === PushStatus.REJECTED_NONFASTFORWARD) {
        throw new NonFastForwardError(update.remoteName, result.uri);
      }
      if (
        update.status === PushStatus.REJECTED_OTHER ||
        update.status === PushStatus.REJECTED_REMOTE_CHANGED ||
        update.status === PushStatus.FAILED
      ) {
        throw new PushRejectedException(
          update.remoteName,
          update.message || "rejected",
          result.uri,
        );
      }
    }

    return result;
  }

  /**
   * Resolve remote name to its push URL, as git's `pushremote_get` and `push_url_of_remote`:
   * a configured remote's `pushurl` (else its `url`), rewritten by `url.<base>.insteadOf`, or
   * by `pushInsteadOf` where it has no `pushurl`; anything else is a URL or path itself,
   * rewritten by `pushInsteadOf`, else `insteadOf`.
   */
  private async resolveRemoteUrl(remote: string): Promise<string | undefined> {
    return RemoteConfigStore.from(this.workingCopy).remoteUrlOf(remote, { push: true });
  }

  /**
   * `push.pushOption` in config order (git's `parse_transport_option`): each value added, an
   * empty one clearing the list; a value-less one dies as git's config reader dies.
   */
  private configuredPushOptions(): string[] {
    const key = "push.pushoption";
    const out: string[] = [];
    for (const { text, file, line } of RemoteConfigStore.from(this._workingCopy).valuesWithOrigin(
      "push.pushOption",
    )) {
      if (text === undefined) {
        const fatal =
          file !== undefined && line !== undefined
            ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
            : `fatal: unable to parse '${key}' from command-line config`;
        throw new InvalidConfigError(key, `error: missing value for '${key}'\n${fatal}`);
      }
      if (text === "") out.length = 0;
      else out.push(text);
    }
    return out;
  }

  /**
   * The options that cannot go together: 2.5x's `die_for_incompatible_opt4` (`--delete`,
   * `--tags`, `--all/--branches`, `--mirror`, all named), 2.43's `--delete` with any of the
   * others (the rest it checks once the remote is known, `remoteChecks`).
   */
  private checkOptionCombinations(compatibility: "2.43" | "2.56"): void {
    if (compatibility === "2.43") {
      if (this.deleteRefs && (this.pushTags || this.pushAll || this.mirror)) {
        throw new IncompatibleOptionsError(
          ["--delete", "--all/--branches/--mirror/--tags"],
          "options '--delete' and '--all/--branches/--mirror/--tags' cannot be used together",
        );
      }
      return;
    }
    const given = [
      this.deleteRefs && "--delete",
      this.pushTags && "--tags",
      this.pushAll && "--all/--branches",
      this.mirror && "--mirror",
    ].filter((o): o is string => typeof o === "string");
    if (given.length < 2) return;
    const quoted = given.map((o) => `'${o}'`);
    const list =
      quoted.length === 2
        ? `${quoted[0]} and ${quoted[1]}`
        : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
    throw new IncompatibleOptionsError(given, `options ${list} cannot be used together`);
  }

  /** `remote.<name>.mirror` of a configured remote (git_config_bool). */
  private remoteMirror(): boolean {
    const store = RemoteConfigStore.from(this._workingCopy);
    if (!store.isConfigured(this.remote)) return false;
    const value = store.value(`remote.${this.remote}.mirror`);
    return value === undefined ? false : (parseGitBool(value) ?? false);
  }

  /**
   * The checks git makes once the remote is known (a mirror remote counts as `--mirror`):
   * `--all` or `--mirror` with refspecs, and in 2.43 their combinations with `--tags` and
   * each other.
   */
  private remoteChecks(compatibility: "2.43" | "2.56", mirror: boolean): () => void {
    const refused = (options: string[], message: string) => {
      throw new IncompatibleOptionsError(options, message);
    };
    const together = (a: string, b: string) =>
      refused([a, b], `options '${a}' and '${b}' cannot be used together`);
    return () => {
      const legacy = compatibility === "2.43";
      if (this.pushAll) {
        if (legacy && this.pushTags) together("--all", "--tags");
        if (this.refSpecs.length > 0) {
          refused(["--all"], "--all can't be combined with refspecs");
        }
      }
      if (mirror) {
        if (legacy && this.pushTags) together("--mirror", "--tags");
        if (this.refSpecs.length > 0) {
          refused(["--mirror"], "--mirror can't be combined with refspecs");
        }
      }
      if (legacy && this.pushAll && mirror) together("--all", "--mirror");
    };
  }

  /** set_refspecs' refusals of the refspecs given: `tag` without a name, `--delete` of `a:b`. */
  private checkRefspecArguments(): void {
    const refs = this.refSpecs;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i] as string;
      if (ref === "tag") {
        if (++i >= refs.length) {
          throw new InvalidArgumentError("refspecs", ref, "tag shorthand without <tag>");
        }
      } else if (this.deleteRefs && (ref === "" || ref.includes(":"))) {
        throw new InvalidArgumentError(
          "refspecs",
          ref,
          "--delete only accepts plain target ref names",
        );
      }
    }
  }

  /**
   * git's `set_refspecs`: the refspecs given, `tag <name>` as `refs/tags/<name>`, each a
   * deletion under `--delete`; a name without `:` that names exactly one local ref goes where
   * `remote.<name>.push` maps that ref, else (`push.default=upstream`) a branch to its single
   * upstream (`refspec_append_mapped`).
   */
  private async givenRefspecs(): Promise<string[]> {
    const out: string[] = [];
    const refs = this.refSpecs;
    let local: string[] | undefined;
    for (let i = 0; i < refs.length; i++) {
      let ref = refs[i] as string;
      if (ref === "tag") {
        ref = refs[++i] as string;
        out.push(this.deleteRefs ? `:refs/tags/${ref}` : `refs/tags/${ref}`);
      } else if (this.deleteRefs) {
        out.push(`:${ref}`);
      } else if (!ref.includes(":")) {
        local ??= [...(await createTransportRefStore(this._workingCopy.history.refs).listAll())]
          .map(([name]) => name)
          .filter((name) => name.startsWith("refs/"));
        const { count, match } = countRefspecMatch(ref, local);
        out.push(count === 1 && match ? this.mappedRefspec(ref, match) : ref);
      } else {
        out.push(ref);
      }
    }
    return out;
  }

  /** git's `refspec_append_mapped`: where `ref` (naming the local ref `matched`) is pushed. */
  private mappedRefspec(ref: string, matched: string): string {
    const store = RemoteConfigStore.from(this._workingCopy);
    if (store.isConfigured(this.remote)) {
      for (const text of store.pushRefspecs(this.remote)) {
        const spec = parseRefSpec(text);
        if (spec.negative || !spec.source || !matchSource(spec, matched)) continue;
        const dst = spec.wildcard
          ? expandFromSource(spec, matched).destination
          : (spec.destination ?? spec.source);
        if (dst) return `${spec.force ? "+" : ""}${matched}:${dst}`;
      }
    }
    if (this.pushDefault() === "upstream" && matched.startsWith("refs/heads/")) {
      const merges = this.upstreamsOf(matched.slice("refs/heads/".length));
      if (merges.length === 1) return `${ref}:${merges[0]}`;
    }
    return ref;
  }

  /**
   * `push.default` as git reads it: `tracking` is `upstream`; undefined when unset (git's
   * `PUSH_DEFAULT_UNSPECIFIED`, which acts as `simple`).
   */
  private pushDefault(): string | undefined {
    const value = RemoteConfigStore.from(this._workingCopy).value("push.default");
    return value === "tracking" ? "upstream" : value;
  }

  /**
   * A branch's upstream merges (`branch.<name>.merge`), counted only while it has a remote
   * (`branch.<name>.remote`), as remote.c's `set_merge`.
   */
  private upstreamsOf(branch: string): string[] {
    const store = RemoteConfigStore.from(this._workingCopy);
    if (!store.value(`branch.${branch}.remote`)) return [];
    return store.values(`branch.${branch}.merge`);
  }

  /**
   * The refspecs to push: `--mirror` (`remote.<name>.push`, else `:` over every ref; see
   * `PushClientOptions.mirror`),
   * `--tags`, the refspecs
   * given (`givenRefspecs`), `--all` (every branch); else the remote's configured push
   * refspecs; else what `push.default` says (git's builtin/push.c
   * `setup_default_push_refspecs`, default `simple`):
   *
   * - `simple`: the current branch to its upstream of the same name when pushing to the
   *   branch's own remote (refused without an upstream, or with one of another name); to the
   *   same name when pushing elsewhere (a URL, another remote)
   * - `current`: the current branch to the same name
   * - `upstream` (`tracking`): the current branch to its upstream, on its remote only
   * - `matching`: `:` (the branches both sides have)
   * - `nothing`: refused
   *
   * A detached HEAD is refused, except with `matching`. Under `push.autoSetupRemote` a branch
   * without an upstream is pushed to its own name and gets it as its upstream
   * (`defaults.setUpstream`).
   */
  private async buildRefSpecs(
    mirror: boolean,
    defaults: { setUpstream: boolean },
    compatibility: "2.43" | "2.56",
  ): Promise<string[]> {
    const store = RemoteConfigStore.from(this.workingCopy);
    // --mirror: do_push's refspecs (a mirror remote's --tags in 2.5x, else remote.<name>.push),
    // else ":" over every ref; send_mirror then deletes every remote ref they leave out
    if (mirror) {
      if (this.pushTags) return ["refs/tags/*:refs/tags/*"];
      const configured = store.isConfigured(this.remote) ? store.pushRefspecs(this.remote) : [];
      return configured.length > 0 ? configured : [":"];
    }
    if (this.pushAll) return ["refs/heads/*:refs/heads/*"];
    const specs: string[] = [];
    if (this.pushTags) specs.push("refs/tags/*:refs/tags/*");
    specs.push(...(await this.givenRefspecs()));
    if (specs.length > 0) return specs;

    if (store.isConfigured(this.remote)) {
      const configured = store.pushRefspecs(this.remote);
      if (configured.length > 0) return configured;
    }
    const mode = this.pushDefault();
    if (mode === "matching") return [":"];
    if (mode === "nothing") {
      throw new InvalidArgumentError(
        "refspecs",
        undefined,
        'You didn\'t specify any refspecs to push, and push.default is "nothing".',
      );
    }
    const ref = await this.getCurrentBranch();
    // a repository without HEAD (nothing committed, nothing checked out) has nothing to push
    if (!ref && !(await this.refsStore.get("HEAD"))) return [];
    if (!ref?.startsWith("refs/heads/")) {
      throw new InvalidArgumentError(
        "refspecs",
        undefined,
        "You are not currently on a branch.\n" +
          "To push the history leading to the current (detached HEAD)\n" +
          "state now, use\n\n" +
          `    git push ${this.remote} HEAD:<name-of-remote-branch>\n`,
      );
    }
    const branch = ref.slice("refs/heads/".length);
    const autoUpstream = this.configBool("push.autoSetupRemote") ?? false;
    const merges = this.upstreamsOf(branch);
    // get_upstream_ref
    const upstreamRef = (): string => {
      if (merges.length === 0 && autoUpstream) return ref;
      if (merges.length === 0) {
        throw new InvalidArgumentError(
          "refspecs",
          undefined,
          `The current branch ${branch} has no upstream branch.\n` +
            "To push the current branch and set the remote as upstream, use\n\n" +
            `    git push --set-upstream ${this.remote} ${branch}\n` +
            (autoUpstream
              ? ""
              : "\nTo have this happen automatically for branches without a tracking\n" +
                "upstream, see 'push.autoSetupRemote' in 'git help config'.\n"),
        );
      }
      if (merges.length !== 1) {
        throw new InvalidArgumentError(
          "refspecs",
          undefined,
          `The current branch ${branch} has multiple upstream branches, refusing to push.`,
        );
      }
      return merges[0] as string;
    };
    // 2.5x: remote_for_branch (branch.<name>.remote, the one configured remote, else
    // "origin") names the pushed-to remote; 2.43's is_workflow_triangular: the fetch remote
    // (remote_get(NULL)) exists and is another one
    // remote_state's remotes are the configured ones and the one pushed to (a URL is made a
    // remote of its own by remote_get), so pushing to a URL from a repository without
    // remotes counts that URL as "the one remote"
    const own = store.value(`branch.${branch}.remote`);
    const known = new Set(store.configuredNames());
    known.add(this.remote);
    const fetchName = own ?? (known.size === 1 ? this.remote : "origin");
    const fetchValid =
      own !== undefined || fetchName === this.remote || store.isConfigured(fetchName);
    const sameRemote =
      compatibility === "2.43"
        ? !(fetchValid && fetchName !== this.remote)
        : this.remote === fetchName;
    let dst = ref;
    if (mode === "current") {
      // the same name
    } else if (mode === "upstream") {
      if (!sameRemote) {
        throw new InvalidArgumentError(
          "refspecs",
          undefined,
          `You are pushing to remote '${this.remote}', which is not the upstream of\n` +
            `your current branch '${branch}', without telling me what to push\n` +
            "to update which remote branch.",
        );
      }
      dst = upstreamRef();
    } else if (sameRemote) {
      // simple, unspecified (and anything git does not know)
      const upstream = upstreamRef();
      if (upstream !== ref) throw this.simpleRefusal(upstream, mode === undefined);
    }
    if (autoUpstream && merges.length === 0) defaults.setUpstream = true;
    return [`${ref}:${dst}`];
  }

  /** builtin/push.c's `die_push_simple`: an upstream of another name than the branch. */
  private simpleRefusal(upstream: string, unspecified: boolean): InvalidArgumentError {
    const short = upstream.startsWith("refs/heads/")
      ? upstream.slice("refs/heads/".length)
      : upstream;
    const autoSetupMerge = RemoteConfigStore.from(this._workingCopy).value("branch.autoSetupMerge");
    return new InvalidArgumentError(
      "refspecs",
      undefined,
      "The upstream branch of your current branch does not match\n" +
        "the name of your current branch.  To push to the upstream branch\n" +
        "on the remote, use\n\n" +
        `    git push ${this.remote} HEAD:${short}\n\n` +
        "To push to the branch of the same name on the remote, use\n\n" +
        `    git push ${this.remote} HEAD\n` +
        (unspecified
          ? "\nTo choose either option permanently, see push.default in 'git help config'.\n"
          : "") +
        (autoSetupMerge !== "simple"
          ? "\nTo avoid automatically configuring an upstream branch when its name\n" +
            "won't match the local branch, see option 'simple' of branch.autoSetupMerge\n" +
            "in 'git help config'.\n"
          : ""),
    );
  }

  /**
   * The remote-tracking ref of a remote ref (`refs/heads/main` → `refs/remotes/origin/main`)
   * through the named remote's fetch refspecs; for a URL, none (2.5x: those of the one remote
   * pushing to that URL).
   */
  private trackingRefMapper(
    remoteUrl: string,
    compatibility: "2.43" | "2.56",
  ): (remoteRef: string) => string | undefined {
    const store = RemoteConfigStore.from(this.workingCopy);
    let tracking = this.remote;
    if (!store.isConfigured(this.remote)) {
      // 2.5x's remote_for_push_tracking: a URL that is the push URL of exactly one configured
      // remote updates that remote's tracking refs
      if (compatibility === "2.43") return () => undefined;
      const matches = store
        .configuredNames()
        .filter((name) => store.remotePushUrls(name).includes(remoteUrl));
      if (matches.length !== 1) return () => undefined;
      tracking = matches[0] as string;
    }
    const specs = store
      .read(tracking)
      .fetchRefspecs.map((spec) => parseRefSpec(spec))
      .filter((spec) => !spec.negative && spec.source && spec.destination);
    return (remoteRef) => {
      const spec = specs.find((s) => matchSource(s, remoteRef));
      return spec ? (expandFromSource(spec, remoteRef).destination ?? undefined) : undefined;
    };
  }
}

/** An error's message, as git's strbuf of a failed ref update. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * refs.c's `refname_is_safe`, which a deletion's name must pass: under `refs/`, a name that
 * stays under it as written (no empty, `.` or `..` component, no leading or trailing `/`);
 * outside it, uppercase letters and `_` only (`ORIG_HEAD`).
 */
function refNameIsSafe(name: string): boolean {
  if (name.startsWith("refs/")) {
    const rest = name.slice(5);
    if (!rest) return false;
    return rest.split("/").every((c) => c !== "" && c !== "." && c !== "..");
  }
  return /^[A-Z_]+$/.test(name);
}

/** `--recurse-submodules=only` stopped the push once the submodules were pushed. */
class SubmodulesOnlyPushed extends Error {}

/**
 * builtin/push.c's `--recurse-submodules` modes (git's `RECURSE_SUBMODULES_CHECK`,
 * `_ON_DEMAND`, `_ONLY`, `_OFF`).
 */
export type PushRecurseSubmodules = "check" | "on-demand" | "only" | "no";

/**
 * submodule-config.c's `parse_push_recurse_submodules_arg`: false, `on-demand`, `check` or
 * `only`; true (there is no plain "on" for a push) and anything else die.
 */
export function parsePushRecurseSubmodules(
  key: string,
  value: string | undefined,
): PushRecurseSubmodules {
  const bool = value === undefined ? true : parseGitBool(value);
  if (bool === false) return "no";
  if (bool === undefined && (value === "on-demand" || value === "check" || value === "only")) {
    return value;
  }
  throw new GitApiError(`fatal: bad ${key} argument: ${value ?? "true"}`, { exitCode: 128 });
}

/** What a push prints on stderr: its warnings, its report, its errors, its submodules'. */
export function pushOutputText(result: PushResult): string {
  const lines = [
    ...(result.warnings ?? []),
    ...(result.display ?? []),
    ...(result.errors ?? []),
    ...(pushSucceeded(result) ? [] : [`error: failed to push some refs to '${result.uri}'`]),
  ];
  return `${result.submoduleOutput ?? ""}${lines.map((l) => `${l}\n`).join("")}`;
}

/** Whether git's push exits 0: every ref pushed or up to date, the report sound. */
export function pushSucceeded(result: PushResult): boolean {
  return (
    !result.failed &&
    result.remoteUpdates.every(
      (u) => u.status === PushStatus.OK || u.status === PushStatus.UP_TO_DATE,
    )
  );
}
