import { parseCoreAbbrev } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  expandFromSource,
  type ForceWithLease,
  formatPushStatus,
  mapRejectReason,
  matchSource,
  type PushClientResult,
  type PushCommandResult,
  type PushRefUpdate,
  PushRefusedByHookError,
  parseRefSpec,
  pushToConnection,
  type PushOptions as TransportPushOptions,
} from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";

import {
  HookFailedError,
  InvalidArgumentError,
  InvalidRemoteError,
  NonFastForwardError,
  PushRejectedException,
} from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type PushResult, PushStatus, type RemoteRefUpdate } from "../results/push-result.js";
import { TransportCommand } from "../transport-command.js";
import { remoteHookSession } from "./local-transport.js";
import { withRemoteReceivePack } from "./remote-transport.js";

/** All-zero object id — Git's "no object", used to express a ref delete. */
const ZERO_OBJECT_ID = "0".repeat(40);

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
  private remote = "origin";
  private refSpecs: string[] = [];
  private force = false;
  private atomic = false;
  private noVerify = false;

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

  /**
   * Set the remote to push to.
   *
   * Can be either a remote name (e.g., "origin") or a URL.
   * Default is "origin".
   *
   * @param remote Remote name or URL
   */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /**
   * Get the remote being pushed to.
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

  private configBool(key: string): boolean | undefined {
    const value = RemoteConfigStore.from(this._workingCopy).value(key);
    return value === undefined ? undefined : (parseGitBool(value) ?? undefined);
  }

  /**
   * Set push options associated with the push operation.
   *
   * Push options are strings passed to the receive-pack on the server
   * side, where they can be used by hooks.
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

    const remoteUrl = await this.resolveRemoteUrl(this.remote);
    if (!remoteUrl) {
      throw new InvalidRemoteError(this.remote);
    }

    // transport_get: the remote's transport is decided (git's errors for one that cannot be
    // reached) before the refspecs are worked out
    const resolved = this.resolveRemote(remoteUrl);
    const refspecs = await this.buildRefSpecs();
    if (refspecs.length === 0) {
      return { uri: remoteUrl, remoteUpdates: [], bytesSent: 0, objectCount: 0, messages: [] };
    }

    const remote = await this.openRemote(resolved);
    const localRemote = remote.kind === "local" ? remote.repository : undefined;
    const history = this._workingCopy.history;
    const tracking = this.trackingRefMapper();
    const messages: string[] = [];
    const leases = this.leases;
    const pushOptions: TransportPushOptions = {
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      repository: createRepositoryFacade({ history, useBitmaps: this.bitmapsInUse() }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      force: this.force,
      atomic: this.atomic,
      thin: this.thin,
      dryRun: this.dryRun,
      prune: this.prune,
      streamRequestBody: this.streamRequestBody,
      pushOptions: this.pushOptions.length > 0 ? this.pushOptions : undefined,
      forceWithLease: leases,
      trackingValue: async (remoteRef) => {
        const local = tracking(remoteRef);
        return local ? (await history.refs.resolve(local))?.objectId : undefined;
      },
      onProgress: (message) => {
        messages.push(message);
        this.progressMessageCallback?.(message);
      },
      abbrev: parseCoreAbbrev(RemoteConfigStore.from(this._workingCopy).value("core.abbrev")) ?? -1,
      ...(!this.noVerify && this.hooks.enabled
        ? {
            prePush: (updates) =>
              this.runPrePush(updates, remoteUrl, (code) => (prePushExit = code)),
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
      );
    } catch (error) {
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

    // git updates the remote-tracking refs of what the server accepted, and of what it had
    // already (transport.c: update_tracking_ref for ok and up-to-date refs)
    if (!this.dryRun) {
      for (const update of result.updates) {
        if (update.status !== "ok" && update.status !== "up-to-date") continue;
        const local = tracking(update.remoteRef);
        if (!local) continue;
        if (update.newOid === ZERO_OBJECT_ID) await history.refs.remove(local);
        // git's update_tracking_ref: "update by push"
        else await history.refs.set(local, update.newOid, this.reflogLine("update by push"));
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
      delete: update.newOid === ZERO_OBJECT_ID,
    }));

    return {
      uri: remoteUrl,
      remoteUpdates,
      bytesSent: result.bytesSent,
      objectCount: result.packObjects,
      messages,
      display: formatPushStatus(result, { dest: remoteUrl }),
    };
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
    const skipped = new Set(["rejected-nonfastforward", "rejected-stale", "up-to-date"]);
    const zero = "0".repeat(40);
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
   * Push and throw on failure.
   */
  async callOrThrow(): Promise<PushResult> {
    const result = await this.call();

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
   * The refspecs to push: the explicit ones, `--all` (every branch), `--tags` (every tag);
   * else the remote's configured push refspecs; else what `push.default` says (git's
   * builtin/push.c `setup_default_push_refspecs`, default `simple`):
   *
   * - `simple`: the current branch to its upstream of the same name when pushing to the
   *   branch's own remote (refused without an upstream, or with one of another name); to the
   *   same name when pushing elsewhere (a URL, another remote)
   * - `current`: the current branch to the same name
   * - `upstream` (`tracking`): the current branch to its upstream, on its remote only
   * - `matching`: `:` (the branches both sides have)
   * - `nothing`: refused
   *
   * A detached HEAD is refused, except with `matching`.
   */
  private async buildRefSpecs(): Promise<string[]> {
    const specs = [...this.refSpecs];
    if (this.pushAll) specs.push("refs/heads/*:refs/heads/*");
    if (this.pushTags) specs.push("refs/tags/*:refs/tags/*");
    if (specs.length > 0) return specs;

    const store = RemoteConfigStore.from(this.workingCopy);
    if (store.isConfigured(this.remote)) {
      const configured = store.read(this.remote).pushRefspecs;
      if (configured.length > 0) return configured;
    }
    const mode = (store.value("push.default") ?? "simple").toLowerCase();
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
        "You are not currently on a branch. To push the history leading to the current " +
          "(detached HEAD) state now, use git push <remote> HEAD:<name-of-remote-branch>",
      );
    }
    const branch = ref.slice("refs/heads/".length);
    if (mode === "current") return [`${ref}:${ref}`];

    // the branch's remote (git: branch.<name>.remote, else "origin") and upstream
    const branchRemote = store.value(`branch.${branch}.remote`) ?? "origin";
    const merge = store.value(`branch.${branch}.merge`);
    const triangular = this.remote !== branchRemote;
    const noUpstream = () =>
      new InvalidArgumentError(
        "refspecs",
        undefined,
        `The current branch ${branch} has no upstream branch. To push the current branch and ` +
          `set the remote as upstream, use git push --set-upstream ${this.remote} ${branch}`,
      );
    if (mode === "upstream" || mode === "tracking") {
      if (triangular) {
        throw new InvalidArgumentError(
          "refspecs",
          undefined,
          `You are pushing to remote '${this.remote}', which is not the upstream of your ` +
            `current branch '${branch}', without telling me what to push to update which ` +
            "remote branch.",
        );
      }
      if (!merge) throw noUpstream();
      return [`${ref}:${merge}`];
    }
    // simple (and anything unknown, as git's default)
    if (triangular) return [`${ref}:${ref}`];
    if (!merge) throw noUpstream();
    if (merge !== ref) {
      throw new InvalidArgumentError(
        "refspecs",
        undefined,
        "The upstream branch of your current branch does not match\n" +
          `the name of your current branch. To push to the upstream branch on the remote, use\n` +
          `    git push ${this.remote} HEAD:${merge.replace(/^refs\/heads\//, "")}`,
      );
    }
    return [`${ref}:${ref}`];
  }

  /**
   * The remote-tracking ref of a remote ref (`refs/heads/main` → `refs/remotes/origin/main`)
   * through the named remote's fetch refspecs; none for a URL.
   */
  private trackingRefMapper(): (remoteRef: string) => string | undefined {
    const store = RemoteConfigStore.from(this.workingCopy);
    if (!store.isConfigured(this.remote)) return () => undefined;
    const specs = store
      .read(this.remote)
      .fetchRefspecs.map((spec) => parseRefSpec(spec))
      .filter((spec) => !spec.negative && spec.source && spec.destination);
    return (remoteRef) => {
      const spec = specs.find((s) => matchSource(s, remoteRef));
      return spec ? (expandFromSource(spec, remoteRef).destination ?? undefined) : undefined;
    };
  }
}
