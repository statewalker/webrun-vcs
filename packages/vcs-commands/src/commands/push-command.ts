import {
  createRepositoryFacade,
  createTransportRefStore,
  expandFromSource,
  type ForceWithLease,
  mapRejectReason,
  matchSource,
  type PushCommandResult,
  type PushRefUpdate,
  parseRefSpec,
  push as transportPush,
} from "@statewalker/vcs-transport";

import { InvalidRemoteError, NonFastForwardError, PushRejectedException } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type PushResult, PushStatus, type RemoteRefUpdate } from "../results/push-result.js";
import { TransportCommand } from "../transport-command.js";

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
  private thin = true;
  private dryRun = false;
  private pushAll = false;
  private pushTags = false;
  private useBitmaps = true;
  private pushOptions: string[] = [];
  private receivePack?: string;
  private prune = false;
  /** Leases; empty: every pushed ref at its remote-tracking value; undefined: none */
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
   * ref is leased at its remote-tracking value. A lease that does not hold is
   * REJECTED_REMOTE_CHANGED; {@link setForce} overrides it, as in git.
   *
   * @param ref The remote ref (full or short name)
   * @param expect The value it must have
   */
  setForceWithLease(ref?: string, expect?: string): this {
    this.checkCallable();
    this.leases ??= [];
    if (ref !== undefined) this.leases.push({ ref, ...(expect !== undefined ? { expect } : {}) });
    return this;
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
   * Default is true.
   *
   * @param useBitmaps Whether to use bitmaps
   */
  setUseBitmaps(useBitmaps: boolean): this {
    this.checkCallable();
    this.useBitmaps = useBitmaps;
    return this;
  }

  /**
   * Whether bitmaps are used for push.
   */
  isUseBitmaps(): boolean {
    return this.useBitmaps;
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
   * refspecs are used, else the current branch is pushed to the same name (git's
   * `push.default=current`; `simple`/`matching`/`upstream` are not modelled).
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

    const refspecs = await this.buildRefSpecs();
    if (refspecs.length === 0) {
      return { uri: remoteUrl, remoteUpdates: [], bytesSent: 0, objectCount: 0, messages: [] };
    }

    const history = this._workingCopy.history;
    const tracking = this.trackingRefMapper();
    const messages: string[] = [];
    const leases = this.leases;
    const result = await transportPush({
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      force: this.force,
      atomic: this.atomic,
      thin: this.thin,
      dryRun: this.dryRun,
      prune: this.prune,
      pushOptions: this.pushOptions.length > 0 ? this.pushOptions : undefined,
      forceWithLease: leases === undefined ? undefined : leases.length === 0 ? true : leases,
      trackingValue: async (remoteRef) => {
        const local = tracking(remoteRef);
        return local ? (await history.refs.resolve(local))?.objectId : undefined;
      },
      onProgress: (message) => {
        messages.push(message);
        this.progressMessageCallback?.(message);
      },
    });

    // git updates the remote-tracking refs of what the server accepted
    if (!this.dryRun) {
      for (const update of result.updates) {
        if (update.status !== "ok") continue;
        const local = tracking(update.remoteRef);
        if (!local) continue;
        if (update.newOid === ZERO_OBJECT_ID) await history.refs.remove(local);
        else await history.refs.set(local, update.newOid);
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
    };
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
      if (update.status === PushStatus.REJECTED_OTHER || update.status === PushStatus.FAILED) {
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
   * Resolve remote name to URL.
   *
   * A named remote resolves through the working copy configuration, preferring
   * `remote.<name>.pushurl` over `remote.<name>.url` as git does; an
   * unconfigured name is passed through unchanged.
   */
  private async resolveRemoteUrl(remote: string): Promise<string | undefined> {
    // If it looks like a URL, use it directly
    if (remote.includes("://") || remote.includes("@")) {
      return remote;
    }

    return RemoteConfigStore.from(this.workingCopy).urlFor(remote, { push: true }) ?? remote;
  }

  /**
   * The refspecs to push: the explicit ones, `--all` (every branch), `--tags` (every tag);
   * else the remote's configured push refspecs; else the current branch to the same name.
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
    const currentBranch = await this.getCurrentBranch();
    return currentBranch ? [`${currentBranch}:${currentBranch}`] : [];
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
