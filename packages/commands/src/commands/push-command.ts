import { serializeCommit, serializeTree, type TreeEntry } from "@statewalker/vcs-core";
import {
  mapRejectReason,
  type PushCommandResult,
  type PushObject,
  push as transportPush,
} from "@statewalker/vcs-transport";

import { InvalidRemoteError, NonFastForwardError, PushRejectedException } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type PushResult, PushStatus, type RemoteRefUpdate } from "../results/push-result.js";
import { TransportCommand } from "../transport-command.js";

/** All-zero object id — Git's "no object", used to express a ref delete. */
const ZERO_OBJECT_ID = "0".repeat(40);

/**
 * How the transport's rejection reasons land on the statuses this package
 * reports.
 *
 * The two vocabularies are not the same: the transport tells seven kinds of
 * rejection apart, while PushStatus — following JGit's RemoteRefUpdate — keeps
 * only the non-fast-forward case separate, because that is the one callers act
 * on (callOrThrow raises NonFastForwardError for it). Everything else is a
 * rejection whose detail lives in the server's message, so it collapses to
 * REJECTED_OTHER. Spelled out per reason rather than defaulted, so that a new
 * transport reason is a compile error here instead of a silent REJECTED_OTHER.
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
 * Classify a server's rejection message.
 *
 * Reuses the transport's `mapRejectReason` so both sides read the same wire
 * text the same way; a message the transport cannot place — or none at all —
 * ends up as REJECTED_OTHER.
 */
function classifyRejection(message: string | undefined): PushStatus {
  return REJECT_REASON_STATUS[mapRejectReason(message ?? "")];
}

/**
 * Split a refspec into its source and destination ref names.
 *
 * Mirrors the parsing the transport performs so that the destination keys we
 * derive here line up exactly with the ones it reports back:
 * an optional leading `+` (force) is stripped, and a refspec with no `:` pushes
 * a ref to its own name.
 */
function parseRefSpec(refSpec: string): { source: string; dest: string } {
  const normalized = refSpec.startsWith("+") ? refSpec.slice(1) : refSpec;
  const [source = "", dest] = normalized.split(":");
  return { source, dest: dest || source };
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
   * Execute the push operation.
   *
   * @returns Push result with updated refs
   * @throws InvalidRemoteError if remote cannot be resolved
   * @throws PushRejectedException if push is rejected
   */
  async call(): Promise<PushResult> {
    this.checkCallable();
    this.setCallable(false);

    // Resolve remote URL
    const remoteUrl = await this.resolveRemoteUrl(this.remote);
    if (!remoteUrl) {
      throw new InvalidRemoteError(this.remote);
    }

    // Build refspecs
    const refspecs = await this.buildRefSpecs();

    // Map each destination ref back to the local ref it came from. The transport
    // keys its update results by the destination ref, and carries no object ids,
    // so this is what lets us report srcRef/newObjectId per update below.
    const sourceByDest = new Map<string, string>();
    for (const spec of refspecs) {
      const { source, dest } = parseRefSpec(spec);
      sourceByDest.set(dest, source);
    }

    if (refspecs.length === 0) {
      // Nothing to push
      return {
        uri: remoteUrl,
        remoteUpdates: [],
        bytesSent: 0,
        objectCount: 0,
        messages: [],
      };
    }

    // Build exportPack if history supports serialization (HistoryWithOperations)
    const history = this._workingCopy.history;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialization = (history as any).serialization as
      | { createPack(objectIds: AsyncIterable<string>): AsyncIterable<Uint8Array> }
      | undefined;

    const exportPack = serialization
      ? async function* (wants: Set<string>, exclude: Set<string>): AsyncIterable<Uint8Array> {
          const objectIds = history.collectReachableObjects(wants, exclude);
          yield* serialization.createPack(objectIds);
        }
      : undefined;

    // Object ids resolved for each source ref, captured as the transport asks
    // for them, so we report the value that was really sent on the wire.
    const resolvedLocalOids = new Map<string, string>();

    // Execute push using high-level push API
    const transportResult = await transportPush({
      url: remoteUrl,
      refspecs,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      force: this.force,
      atomic: this.atomic,
      onProgressMessage: this.progressMessageCallback,
      exportPack,
      getLocalRef: async (refName: string) => {
        // A refspec with an empty source (":refs/heads/x") is a delete request:
        // Git expresses it as an update to the all-zero object id.
        if (refName === "") {
          resolvedLocalOids.set(refName, ZERO_OBJECT_ID);
          return ZERO_OBJECT_ID;
        }
        const ref = await this.refsStore.resolve(refName);
        // Memoise exactly the object id the transport used for this source ref,
        // so the reported newObjectId is the value that was actually pushed.
        if (ref?.objectId !== undefined) {
          resolvedLocalOids.set(refName, ref.objectId);
        }
        return ref?.objectId;
      },
      getObjectsToPush: (newIds: string[], oldIds: string[]) =>
        this.getObjectsToPush(newIds, oldIds),
    });

    // Convert to PushResult.
    //
    // `transportResult.updates` is keyed by the DESTINATION ref name and carries
    // {ok, message, oldOid}: the new object ids come from the refspecs we built
    // and the source-ref lookups the transport performed through `getLocalRef`
    // above, while `oldOid` is the remote's pre-push value — the expectation the
    // server compared its ref against — as read from its advertisement.
    const remoteUpdates: RemoteRefUpdate[] = [];
    for (const [refName, updateResult] of transportResult.updates) {
      const srcRef = sourceByDest.get(refName);
      const newObjectId = srcRef !== undefined ? resolvedLocalOids.get(srcRef) : undefined;
      remoteUpdates.push({
        // Omit srcRef for a delete: there is no local ref behind it.
        ...(srcRef ? { srcRef } : {}),
        remoteName: refName,
        expectedOldObjectId: updateResult.oldOid,
        newObjectId: newObjectId ?? "",
        status: updateResult.ok ? PushStatus.OK : classifyRejection(updateResult.message),
        message: updateResult.message,
        forceUpdate: this.force,
        delete: newObjectId === ZERO_OBJECT_ID,
      });
    }

    return {
      uri: remoteUrl,
      remoteUpdates,
      bytesSent: transportResult.bytesSent,
      objectCount: transportResult.objectCount,
      messages: [],
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
   * Build refspecs for the push.
   */
  private async buildRefSpecs(): Promise<string[]> {
    const specs: string[] = [];

    // Add explicit refspecs
    for (const spec of this.refSpecs) {
      if (this.force && !spec.startsWith("+")) {
        specs.push(`+${spec}`);
      } else {
        specs.push(spec);
      }
    }

    // Push all branches
    if (this.pushAll) {
      for await (const ref of this.refsStore.list("refs/heads/")) {
        const spec = `${ref.name}:${ref.name}`;
        specs.push(this.force ? `+${spec}` : spec);
      }
    }

    // Push all tags
    if (this.pushTags) {
      for await (const ref of this.refsStore.list("refs/tags/")) {
        const spec = `${ref.name}:${ref.name}`;
        specs.push(this.force ? `+${spec}` : spec);
      }
    }

    // Default: push current branch
    if (specs.length === 0) {
      const currentBranch = await this.getCurrentBranch();
      if (currentBranch) {
        const spec = `${currentBranch}:${currentBranch}`;
        specs.push(this.force ? `+${spec}` : spec);
      }
    }

    return specs;
  }

  /**
   * Get objects to push.
   *
   * Returns objects reachable from newIds but not from oldIds.
   */
  private async *getObjectsToPush(newIds: string[], oldIds: string[]): AsyncIterable<PushObject> {
    // Build set of commits to exclude (already on remote)
    const excludeCommits = new Set<string>();
    for (const oldId of oldIds) {
      if (oldId !== "0".repeat(40)) {
        await this.collectReachableCommits(oldId, excludeCommits);
      }
    }

    // Walk from new commits and yield objects not in exclude set
    const visitedObjects = new Set<string>();
    const commitQueue: string[] = [...newIds.filter((id) => id !== "0".repeat(40))];

    while (commitQueue.length > 0) {
      const commitId = commitQueue.shift();
      if (commitId === undefined) break;

      if (excludeCommits.has(commitId) || visitedObjects.has(commitId)) {
        continue;
      }
      visitedObjects.add(commitId);

      try {
        const commit = await this.commits.load(commitId);
        if (!commit) continue;

        // Yield commit object
        yield await this.loadObjectForPush(commitId, 1);

        // Yield tree and its contents
        yield* this.yieldTreeObjects(commit.tree, visitedObjects);

        // Queue parent commits
        for (const parent of commit.parents) {
          if (!excludeCommits.has(parent) && !visitedObjects.has(parent)) {
            commitQueue.push(parent);
          }
        }
      } catch {
        // Commit not found, skip
      }
    }
  }

  /**
   * Collect all commits reachable from a given commit.
   */
  private async collectReachableCommits(
    commitId: string,
    result: Set<string>,
    maxDepth = 1000,
  ): Promise<void> {
    const queue: string[] = [commitId];
    let depth = 0;

    while (queue.length > 0 && depth < maxDepth) {
      const id = queue.shift();
      if (id === undefined) break;
      if (result.has(id)) {
        continue;
      }
      result.add(id);
      depth++;

      try {
        const commit = await this.commits.load(id);
        if (commit) queue.push(...commit.parents);
      } catch {
        // Commit not found, skip
      }
    }
  }

  /**
   * Yield tree and blob objects recursively.
   */
  private async *yieldTreeObjects(
    treeId: string,
    visited: Set<string>,
  ): AsyncGenerator<PushObject> {
    if (visited.has(treeId)) {
      return;
    }
    visited.add(treeId);

    // Yield tree object
    yield await this.loadObjectForPush(treeId, 2);

    // Recursively process tree entries
    for await (const entry of this.trees.loadTree(treeId)) {
      if (visited.has(entry.id)) {
        continue;
      }

      const isTree = (entry.mode & 0o170000) === 0o040000;
      if (isTree) {
        yield* this.yieldTreeObjects(entry.id, visited);
      } else {
        // Blob
        visited.add(entry.id);
        yield await this.loadObjectForPush(entry.id, 3);
      }
    }
  }

  /**
   * Load an object for pushing.
   *
   * Serializes objects to raw Git format based on type:
   * - type 1 (commit): serialize via serializeCommit()
   * - type 2 (tree): serialize via serializeTree()
   * - type 3 (blob): load raw content from blob store
   */
  private async loadObjectForPush(objectId: string, type: number): Promise<PushObject> {
    let content: Uint8Array;

    if (type === 1) {
      // Commit
      const commit = await this.commits.load(objectId);
      if (!commit) {
        throw new Error(`Commit not found: ${objectId}`);
      }
      content = serializeCommit(commit);
    } else if (type === 2) {
      // Tree
      const entries: TreeEntry[] = [];
      for await (const entry of this.trees.loadTree(objectId)) {
        entries.push(entry);
      }
      content = serializeTree(entries);
    } else {
      // Blob (type 3) or other
      const chunks: Uint8Array[] = [];
      const blobContent = await this.blobs.load(objectId);
      if (blobContent) {
        for await (const chunk of blobContent) {
          chunks.push(chunk);
        }
      }
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      content = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
    }

    return {
      id: objectId,
      type,
      content,
    };
  }
}
