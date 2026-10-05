import type { ObjectId } from "@statewalker/vcs-core";
// Import from the package root only: vcs-core ships a single runtime file
// (dist/index.js); its subpaths resolve for types but not at runtime.
import { isSymbolicRef } from "@statewalker/vcs-core";
import {
  expandFromSource,
  matchSource,
  parseRefSpec,
  type RefSpec,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";

import { InvalidArgumentError, InvalidRemoteError } from "../errors/index.js";
import { importPackIntoHistory } from "../pack-import/index.js";
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
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Set by setTagOpt(), to be used in call()
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

    // Parse refspecs for source→destination mapping
    const parsedSpecs = this.effectiveRefSpecs().map((s) => parseRefSpec(s));

    // Save old ref values before fetch for status computation
    const oldRefValues = new Map<string, string | undefined>();
    for await (const ref of this.refsStore.list()) {
      if (!isSymbolicRef(ref) && ref.objectId) {
        oldRefValues.set(ref.name, ref.objectId);
      }
    }

    // Execute fetch using high-level fetch API
    const transportResult = await transportFetch({
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      depth: this.depth,
      onProgressMessage: this.progressMessageCallback,
    });

    // Convert refs from Uint8Array to hex strings
    const bytesToHex = (bytes: Uint8Array): string =>
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const advertisedRefs = new Map<string, ObjectId>();
    for (const [refName, objectId] of transportResult.refs) {
      advertisedRefs.set(refName, bytesToHex(objectId));
    }

    // Build tracking ref updates by mapping server refs through refspecs
    const trackingUpdates: TrackingRefUpdate[] = [];
    for (const [serverRefName, objectIdBytes] of transportResult.refs) {
      const objectId = bytesToHex(objectIdBytes);

      // Map server ref name to local ref name via refspecs
      const localRefName = this.mapServerRef(serverRefName, parsedSpecs);
      if (!localRefName) continue;

      const isForce = this.forceUpdate || this.isRefSpecForced(serverRefName, parsedSpecs);
      const update = await this.computeRefUpdate(
        localRefName,
        serverRefName,
        objectId,
        oldRefValues,
        isForce,
      );

      // Write the mapped ref to local store (unless dry-run)
      if (!this.dryRun) {
        await this.refsStore.set(localRefName, objectId);
      }

      trackingUpdates.push(update);
    }

    // Handle prune
    if (!this.dryRun && this.removeDeletedRefs) {
      const pruned = await this.pruneDeletedRefs(transportResult.refs);
      trackingUpdates.push(...pruned);
    }

    // Store pack data
    if (transportResult.packData.length > 0 && !this.dryRun) {
      await this.storePack(transportResult.packData);
    }

    return {
      uri: remoteUrl,
      advertisedRefs,
      trackingRefUpdates: trackingUpdates,
      defaultBranch: transportResult.defaultBranch,
      bytesReceived: transportResult.bytesReceived,
      isEmpty: transportResult.isEmpty,
      messages: [],
    };
  }

  /**
   * Map a server ref name to a local ref name using parsed refspecs.
   * Returns undefined if no refspec matches.
   */
  private mapServerRef(serverRef: string, specs: RefSpec[]): string | undefined {
    for (const spec of specs) {
      if (spec.negative) continue;
      if (!spec.source || !spec.destination) continue;
      if (!matchSource(spec, serverRef)) continue;

      const expanded = expandFromSource(spec, serverRef);
      return expanded.destination ?? undefined;
    }
    return undefined;
  }

  /**
   * Check if any matching refspec has the force flag for a given server ref.
   */
  private isRefSpecForced(serverRef: string, specs: RefSpec[]): boolean {
    for (const spec of specs) {
      if (spec.negative) continue;
      if (!spec.source) continue;
      if (matchSource(spec, serverRef) && spec.force) return true;
    }
    return false;
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
   * Compute ref update status using pre-fetch ref values.
   *
   * Uses saved pre-fetch values to correctly determine
   * NEW vs NO_CHANGE vs FAST_FORWARD status.
   */
  private async computeRefUpdate(
    localRef: string,
    remoteRef: string,
    newObjectId: ObjectId,
    oldRefValues: Map<string, string | undefined>,
    force: boolean,
  ): Promise<TrackingRefUpdate> {
    const oldObjectId = oldRefValues.get(localRef);

    let status: RefUpdateStatus;
    if (!oldObjectId) {
      status = RefUpdateStatus.NEW;
    } else if (oldObjectId === newObjectId) {
      status = RefUpdateStatus.NO_CHANGE;
    } else if (force) {
      status = RefUpdateStatus.FORCED;
    } else {
      // Check if fast-forward
      const isAncestor = await this.isAncestor(oldObjectId, newObjectId);
      status = isAncestor ? RefUpdateStatus.FAST_FORWARD : RefUpdateStatus.REJECTED;
    }

    return {
      localRef,
      remoteRef,
      oldObjectId,
      newObjectId,
      status,
    };
  }

  /**
   * Check if one commit is an ancestor of another.
   */
  private async isAncestor(ancestor: ObjectId, descendant: ObjectId): Promise<boolean> {
    // Walk from descendant back to see if we hit ancestor
    const visited = new Set<ObjectId>();
    const queue: ObjectId[] = [descendant];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current === ancestor) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      try {
        const commit = await this.commits.load(current);
        if (commit) {
          queue.push(...commit.parents);
        }
      } catch {
        // Commit not found, skip
      }

      // Limit walk depth for performance
      if (visited.size > 10000) {
        break;
      }
    }

    return false;
  }

  /**
   * Prune refs that no longer exist on remote.
   */
  private async pruneDeletedRefs(
    remoteRefs: Map<string, Uint8Array>,
  ): Promise<TrackingRefUpdate[]> {
    const updates: TrackingRefUpdate[] = [];
    const prefix = `refs/remotes/${this.remote}/`;

    // Get remote ref names for comparison
    const remoteRefNames = new Set<string>();
    for (const refName of remoteRefs.keys()) {
      remoteRefNames.add(refName);
    }

    // Find local tracking refs that don't exist on remote
    for await (const ref of this.refsStore.list(prefix)) {
      // Skip symbolic refs
      if (isSymbolicRef(ref)) {
        continue;
      }

      // Derive remote ref name
      const localName = ref.name.slice(prefix.length);
      const remoteRefName = `refs/heads/${localName}`;

      if (!remoteRefNames.has(ref.name) && !remoteRefNames.has(remoteRefName)) {
        // Delete the local tracking ref
        await this.refsStore.delete(ref.name);
        updates.push({
          localRef: ref.name,
          remoteRef: remoteRefName,
          oldObjectId: ref.objectId,
          newObjectId: "", // Empty indicates deletion
          status: RefUpdateStatus.DELETED,
        });
      }
    }

    return updates;
  }

  /**
   * Store received pack data.
   *
   * Unpacks the pack into the working copy's history, so the objects the
   * freshly written tracking refs point at are actually available locally.
   * Import is idempotent: the stores are content-addressed, so re-importing
   * a pack rewrites the same object IDs.
   */
  private async storePack(packData: Uint8Array): Promise<void> {
    await importPackIntoHistory(this._workingCopy.history, packData);
  }
}
