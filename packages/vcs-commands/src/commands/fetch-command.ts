import type { ObjectId } from "@statewalker/vcs-core";
// Import from the package root only: vcs-core ships a single runtime file
// (dist/index.js); its subpaths resolve for types but not at runtime.
import { isSymbolicRef } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  expandFromDestination,
  type FetchRefUpdate,
  matchDestination,
  parseRefSpec,
  type RefSpec,
  type TagMode,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";

import { InvalidArgumentError, InvalidRemoteError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  type FetchResult,
  RefUpdateStatus,
  type TrackingRefUpdate,
} from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";

/**
 * Tag fetching option.
 *
 * Based on JGit's TagOpt.
 */
export enum TagOption {
  /** Automatically follow tags that point to fetched commits */
  AUTO_FOLLOW = "auto-follow",
  /** Fetch all tags */
  FETCH_TAGS = "fetch-tags",
  /** Don't fetch any tags */
  NO_TAGS = "no-tags",
}

/**
 * Fetch objects and refs from a remote repository.
 *
 * Equivalent to `git fetch`.
 *
 * Based on JGit's FetchCommand.
 *
 * @example
 * ```typescript
 * // Fetch from default remote
 * const result = await git.fetch().call();
 *
 * // Fetch from specific remote
 * const result = await git.fetch()
 *   .setRemote("upstream")
 *   .call();
 *
 * // Fetch specific refs
 * const result = await git.fetch()
 *   .setRefSpecs("refs/heads/main:refs/remotes/origin/main")
 *   .call();
 *
 * // Shallow fetch
 * const result = await git.fetch()
 *   .setDepth(10)
 *   .call();
 *
 * // Fetch with authentication
 * const result = await git.fetch()
 *   .setCredentialsProvider("user", "token")
 *   .call();
 * ```
 */
export class FetchCommand extends TransportCommand<FetchResult> {
  private remote = "origin";
  private refSpecs: string[] = [];
  private removeDeletedRefs = false;
  private tagOption: TagOption = TagOption.AUTO_FOLLOW;
  private thin = true;
  private depth?: number;
  private dryRun = false;
  private forceUpdate = false;
  private checkFetchedObjects = false;
  private initialBranch?: string;
  private shallowSince?: Date;
  private shallowExcludes: string[] = [];
  private unshallow = false;

  /**
   * Set the remote to fetch from.
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
   * Get the remote being fetched from.
   */
  getRemote(): string {
    return this.remote;
  }

  /**
   * Set refspecs to fetch.
   *
   * If not set, uses the default refspec for the remote.
   *
   * @param refSpecs Refspec strings
   */
  setRefSpecs(...refSpecs: string[]): this {
    this.checkCallable();
    this.refSpecs = refSpecs;
    return this;
  }

  /**
   * Add a refspec to fetch.
   *
   * @param refSpec Refspec string
   */
  addRefSpec(refSpec: string): this {
    this.checkCallable();
    this.refSpecs.push(refSpec);
    return this;
  }

  /**
   * Set whether to remove refs that no longer exist on the remote.
   *
   * Equivalent to `git fetch --prune`.
   *
   * @param remove Whether to prune deleted refs
   */
  setRemoveDeletedRefs(remove: boolean): this {
    this.checkCallable();
    this.removeDeletedRefs = remove;
    return this;
  }

  /**
   * Whether to remove deleted refs.
   */
  isRemoveDeletedRefs(): boolean {
    return this.removeDeletedRefs;
  }

  setTagOpt(option: TagOption): this {
    this.checkCallable();
    this.tagOption = option;
    return this;
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
   * Set shallow clone depth.
   *
   * @param depth Number of commits to fetch
   */
  setDepth(depth: number): this {
    this.checkCallable();
    if (depth < 1) {
      throw new InvalidArgumentError("depth", depth, "Depth must be at least 1");
    }
    this.depth = depth;
    return this;
  }

  /**
   * Set dry run mode.
   *
   * In dry run mode, refs are not actually updated.
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
   * Set force update mode.
   *
   * When enabled, allows non-fast-forward updates.
   *
   * @param force Whether to force updates
   */
  setForceUpdate(force: boolean): this {
    this.checkCallable();
    this.forceUpdate = force;
    return this;
  }

  /**
   * Whether force update mode is enabled.
   */
  isForceUpdate(): boolean {
    return this.forceUpdate;
  }

  /**
   * Set whether to check received objects for validity.
   *
   * If true, objects received will be verified.
   *
   * @param check Whether to check objects
   */
  setCheckFetchedObjects(check: boolean): this {
    this.checkCallable();
    this.checkFetchedObjects = check;
    return this;
  }

  /**
   * Whether to check received objects for validity.
   */
  isCheckFetchedObjects(): boolean {
    return this.checkFetchedObjects;
  }

  /**
   * Set the initial branch to check out.
   *
   * Can be specified as ref name (refs/heads/main), branch name (main),
   * or tag name (v1.0.0).
   *
   * @param branch Initial branch name
   */
  setInitialBranch(branch: string): this {
    this.checkCallable();
    this.initialBranch = branch;
    return this;
  }

  /**
   * Get the initial branch.
   */
  getInitialBranch(): string | undefined {
    return this.initialBranch;
  }

  /**
   * Deepens or shortens the history of a shallow repository to include
   * all reachable commits after a specified time.
   *
   * Equivalent to `git fetch --shallow-since=<date>`.
   *
   * @param shallowSince The timestamp
   */
  setShallowSince(shallowSince: Date): this {
    this.checkCallable();
    this.shallowSince = shallowSince;
    return this;
  }

  /**
   * Get the shallow-since date.
   */
  getShallowSince(): Date | undefined {
    return this.shallowSince;
  }

  /**
   * Deepens or shortens the history of a shallow repository to exclude
   * commits reachable from a specified remote branch or tag.
   *
   * Equivalent to `git fetch --shallow-exclude=<ref>`.
   *
   * @param shallowExclude The ref or commit to exclude
   */
  addShallowExclude(shallowExclude: string): this {
    this.checkCallable();
    this.shallowExcludes.push(shallowExclude);
    return this;
  }

  /**
   * Get the shallow excludes.
   */
  getShallowExcludes(): string[] {
    return [...this.shallowExcludes];
  }

  /**
   * If the source repository is complete, converts a shallow repository
   * to a complete one, removing all the limitations imposed by shallow
   * repositories.
   *
   * Equivalent to `git fetch --unshallow`.
   *
   * @param unshallow Whether to unshallow
   */
  setUnshallow(unshallow: boolean): this {
    this.checkCallable();
    this.unshallow = unshallow;
    return this;
  }

  /**
   * Whether unshallow mode is enabled.
   */
  isUnshallow(): boolean {
    return this.unshallow;
  }

  /**
   * Execute the fetch operation.
   *
   * Runs the transport's fetch client (git's fetch-pack): the local refs are offered as
   * haves, so only the objects the working copy lacks are downloaded; shallow options and
   * the shallow file are honoured; tags follow the tag option; each tracking ref is
   * updated when it fast-forwards or its refspec (or {@link setForceUpdate}) forces it, and
   * rejected otherwise.
   *
   * @returns Fetch result with updated refs
   * @throws InvalidRemoteError if remote cannot be resolved
   */
  async call(): Promise<FetchResult> {
    this.checkCallable();
    this.setCallable(false);

    // Resolve remote URL
    const remoteUrl = await this.resolveRemoteUrl(this.remote);
    if (!remoteUrl) {
      throw new InvalidRemoteError(this.remote);
    }

    // git: without a refspec the remote's HEAD is fetched, and no ref is written
    const configured = this.effectiveRefSpecs();
    const refspecs = configured.length > 0 ? configured : ["HEAD"];
    const history = this._workingCopy.history;

    const result = await transportFetch({
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      tags: toTagMode(this.tagOption),
      depth: this.depth,
      deepenSince: this.shallowSince,
      deepenNot: this.shallowExcludes.length > 0 ? this.shallowExcludes : undefined,
      unshallow: this.unshallow || undefined,
      force: this.forceUpdate,
      dryRun: this.dryRun,
      onProgress: this.progressMessageCallback,
      reflogMessage: `fetch: ${remoteUrl}`,
    });

    const advertisedRefs = new Map<string, ObjectId>();
    for (const ref of result.remoteRefs) {
      if (ref.oid) advertisedRefs.set(ref.name, ref.oid);
    }
    const trackingUpdates = result.refUpdates.map(toTrackingRefUpdate);

    // Handle prune
    if (!this.dryRun && this.removeDeletedRefs) {
      const parsed = refspecs.map((s) => parseRefSpec(s));
      trackingUpdates.push(
        ...(await this.pruneDeletedRefs(new Set(advertisedRefs.keys()), parsed)),
      );
    }

    return {
      uri: remoteUrl,
      advertisedRefs,
      trackingRefUpdates: trackingUpdates,
      defaultBranch: result.defaultBranch,
      bytesReceived: result.packBytes,
      isEmpty: result.isEmpty,
      messages: [],
    };
  }

  /**
   * The refspecs this fetch runs with.
   *
   * Explicit refspecs win; otherwise a configured remote contributes its
   * `remote.<name>.fetch` lines, which is what makes `fetch().setRemote("origin")`
   * update tracking refs without being told how. A remote given as a bare URL
   * has no config and so still needs its refspecs spelled out.
   */
  private effectiveRefSpecs(): string[] {
    if (this.refSpecs.length > 0) return this.refSpecs;
    const store = RemoteConfigStore.from(this.workingCopy);
    return store.isConfigured(this.remote) ? store.read(this.remote).fetchRefspecs : [];
  }

  /**
   * Resolve remote name to URL.
   *
   * A named remote resolves through `remote.<name>.url` in the working copy
   * configuration. An unconfigured name is passed through unchanged, so a URL
   * given straight to {@link setRemote} still works.
   */
  private async resolveRemoteUrl(remote: string): Promise<string | undefined> {
    // If it looks like a URL, use it directly
    if (remote.includes("://") || remote.includes("@")) {
      return remote;
    }

    return RemoteConfigStore.from(this.workingCopy).urlFor(remote) ?? remote;
  }

  /**
   * Prune local refs that a refspec maps from a remote ref that no longer exists (git's
   * `--prune`): for each refspec with a destination, the local refs matching the
   * destination whose source is not among the remote refs are deleted.
   */
  private async pruneDeletedRefs(
    remoteRefNames: Set<string>,
    specs: RefSpec[],
  ): Promise<TrackingRefUpdate[]> {
    const updates: TrackingRefUpdate[] = [];
    const done = new Set<string>();
    for (const spec of specs) {
      if (spec.negative || !spec.source || !spec.destination) continue;
      const prefix = spec.wildcard
        ? spec.destination.slice(0, spec.destination.indexOf("*"))
        : spec.destination;
      for await (const ref of this.refsStore.list(prefix)) {
        if (isSymbolicRef(ref) || done.has(ref.name)) continue;
        let source: string | null;
        if (spec.wildcard) {
          if (!matchDestination(spec, ref.name)) continue;
          source = expandFromDestination(spec, ref.name).source;
        } else {
          if (ref.name !== spec.destination) continue;
          source = spec.source;
        }
        if (!source || remoteRefNames.has(source)) continue;
        done.add(ref.name);
        await this.refsStore.delete(ref.name);
        updates.push({
          localRef: ref.name,
          remoteRef: source,
          oldObjectId: ref.objectId,
          newObjectId: "", // Empty indicates deletion
          status: RefUpdateStatus.DELETED,
        });
      }
    }
    return updates;
  }
}

/** The transport's tag mode for a {@link TagOption}. */
export function toTagMode(option: TagOption): TagMode {
  switch (option) {
    case TagOption.FETCH_TAGS:
      return "all";
    case TagOption.NO_TAGS:
      return "none";
    default:
      return "auto";
  }
}

/** A transport ref update as a {@link TrackingRefUpdate}. */
export function toTrackingRefUpdate(update: FetchRefUpdate): TrackingRefUpdate {
  const status =
    update.status === "new"
      ? RefUpdateStatus.NEW
      : update.status === "up-to-date"
        ? RefUpdateStatus.NO_CHANGE
        : update.status === "fast-forward"
          ? RefUpdateStatus.FAST_FORWARD
          : update.status === "forced"
            ? RefUpdateStatus.FORCED
            : update.reason === "non-fast-forward" || update.reason === "would clobber existing tag"
              ? RefUpdateStatus.REJECTED
              : RefUpdateStatus.LOCK_FAILURE;
  return {
    localRef: update.localRef,
    remoteRef: update.remoteRef,
    oldObjectId: update.oldOid,
    newObjectId: update.newOid,
    status,
    summary: update.summary,
    reason: update.reason,
  };
}
