import type { ObjectId } from "@statewalker/vcs-core";
import {
  type CloneOptions as TransportCloneOptions,
  clone as transportClone,
} from "@statewalker/vcs-transport";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import { InvalidArgumentError, InvalidRemoteError } from "../errors/index.js";
import { importPackIntoHistory } from "../pack-import/index.js";
import type { CloneResult } from "../results/clone-result.js";
import {
  type FetchResult,
  RefUpdateStatus,
  type TrackingRefUpdate,
} from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";
import { TagOption } from "./fetch-command.js";

/**
 * Clone a remote repository.
 *
 * Equivalent to `git clone`.
 *
 * Based on JGit's CloneCommand.
 *
 * Note: Unlike other commands, CloneCommand initializes a new repository
 * rather than operating on an existing one. The store passed to the
 * constructor should be an empty/new store that will be populated.
 *
 * @example
 * ```typescript
 * // Basic clone
 * const result = await git.clone()
 *   .setURI("https://github.com/user/repo")
 *   .call();
 *
 * // Clone specific branch
 * const result = await git.clone()
 *   .setURI("https://github.com/user/repo")
 *   .setBranch("develop")
 *   .call();
 *
 * // Shallow clone
 * const result = await git.clone()
 *   .setURI("https://github.com/user/repo")
 *   .setDepth(1)
 *   .call();
 *
 * // Bare clone
 * const result = await git.clone()
 *   .setURI("https://github.com/user/repo")
 *   .setBare(true)
 *   .call();
 * ```
 */
export class CloneCommand extends TransportCommand<CloneResult> {
  private uri?: string;
  private branch?: string;
  private depth?: number;
  private bare = false;
  private noCheckout = false;
  private remoteName = "origin";
  private cloneAllBranches = true;
  private mirror = false;
  private branchesToClone: string[] = [];
  private tagOption: TagOption = TagOption.AUTO_FOLLOW;
  private shallowSince?: Date;
  private shallowExcludes: string[] = [];

  /**
   * Set the URI to clone from.
   *
   * @param uri Repository URI (HTTPS, SSH, or Git protocol)
   */
  setURI(uri: string): this {
    this.checkCallable();
    this.uri = uri;
    return this;
  }

  /**
   * Get the URI being cloned.
   */
  getURI(): string | undefined {
    return this.uri;
  }

  /**
   * Set the branch to clone.
   *
   * If set, only this branch will be fetched.
   * Otherwise, all branches are fetched.
   *
   * @param branch Branch name (e.g., "main" or "refs/heads/main")
   */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /**
   * Get the branch being cloned.
   */
  getBranch(): string | undefined {
    return this.branch;
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
   * Set whether to create a bare repository.
   *
   * @param bare Whether to create bare repository
   */
  setBare(bare: boolean): this {
    this.checkCallable();
    this.bare = bare;
    return this;
  }

  /**
   * Whether bare clone is enabled.
   */
  isBare(): boolean {
    return this.bare;
  }

  /**
   * Set whether to skip checkout.
   *
   * @param noCheckout Whether to skip checkout
   */
  setNoCheckout(noCheckout: boolean): this {
    this.checkCallable();
    this.noCheckout = noCheckout;
    return this;
  }

  /**
   * Whether checkout is skipped.
   */
  isNoCheckout(): boolean {
    return this.noCheckout;
  }

  /**
   * Set the remote name.
   *
   * Default is "origin".
   *
   * @param remoteName Remote name
   */
  setRemote(remoteName: string): this {
    this.checkCallable();
    this.remoteName = remoteName;
    return this;
  }

  /**
   * Get the remote name.
   */
  getRemote(): string {
    return this.remoteName;
  }

  /**
   * Set whether to clone all branches.
   *
   * Default is true. If set to false and no branch is specified,
   * only the default branch will be cloned.
   *
   * @param cloneAllBranches Whether to clone all branches
   */
  setCloneAllBranches(cloneAllBranches: boolean): this {
    this.checkCallable();
    this.cloneAllBranches = cloneAllBranches;
    return this;
  }

  /**
   * Whether clone all branches is enabled.
   */
  isCloneAllBranches(): boolean {
    return this.cloneAllBranches;
  }

  /**
   * Set up a mirror of the source repository.
   *
   * This implies that a bare repository will be created.
   * Compared to setBare, setMirror not only maps local branches
   * of the source to local branches of the target, it maps all refs
   * (including remote-tracking branches, notes, etc.).
   *
   * Equivalent to `git clone --mirror`.
   *
   * @param mirror Whether to mirror all refs
   */
  setMirror(mirror: boolean): this {
    this.checkCallable();
    this.mirror = mirror;
    if (mirror) {
      this.bare = true;
    }
    return this;
  }

  /**
   * Whether mirror mode is enabled.
   */
  isMirror(): boolean {
    return this.mirror;
  }

  /**
   * Set branches or tags to clone.
   *
   * This is ignored if setCloneAllBranches(true) or setMirror(true) is used.
   * If branchesToClone is empty, it's also ignored.
   *
   * @param branchesToClone Collection of branches to clone (full ref names)
   */
  setBranchesToClone(branchesToClone: string[]): this {
    this.checkCallable();
    this.branchesToClone = [...branchesToClone];
    return this;
  }

  /**
   * Get branches to clone.
   */
  getBranchesToClone(): string[] {
    return [...this.branchesToClone];
  }

  /**
   * Set the tag option for the remote configuration.
   *
   * @param tagOption Tag option
   */
  setTagOption(tagOption: TagOption): this {
    this.checkCallable();
    this.tagOption = tagOption;
    return this;
  }

  /**
   * Get the tag option.
   */
  getTagOption(): TagOption {
    return this.tagOption;
  }

  /**
   * Set the --no-tags option.
   *
   * Tags are not cloned and the remote configuration is initialized
   * with the --no-tags option as well.
   *
   * Equivalent to `git clone --no-tags`.
   */
  setNoTags(): this {
    return this.setTagOption(TagOption.NO_TAGS);
  }

  /**
   * Create a shallow clone with a history after the specified time.
   *
   * Equivalent to `git clone --shallow-since=<date>`.
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
   * Create a shallow clone excluding commits reachable from a specified
   * remote branch or tag.
   *
   * Equivalent to `git clone --shallow-exclude=<ref>`.
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
   * Execute the clone operation.
   *
   * @returns Clone result
   * @throws InvalidRemoteError if URI is not specified
   */
  async call(): Promise<CloneResult> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.uri) {
      throw new InvalidRemoteError("", "URI must be specified for clone");
    }

    // Determine clone branch strategy
    const branchToClone = this.determineBranchToClone();

    // Execute clone via transport
    const options: TransportCloneOptions = {
      url: this.uri,
      branch: branchToClone,
      depth: this.depth,
      bare: this.bare,
      remoteName: this.remoteName,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      onProgress: this.progressCallback,
      onProgressMessage: this.progressMessageCallback,
    };

    const transportResult = await transportClone(options);

    // Store pack data
    if (transportResult.packData.length > 0) {
      await this.storePack(transportResult.packData);
    }

    // Update refs based on clone mode
    const trackingUpdates: TrackingRefUpdate[] = [];
    for (const [refName, objectId] of transportResult.refs) {
      const objectIdHex = bytesToHex(objectId);

      // Filter refs based on tag option
      if (this.shouldSkipRef(refName)) {
        continue;
      }

      // For mirror mode, refs are stored directly without remotes prefix
      const localRefName = this.mirror ? this.toMirrorRefName(refName) : refName;

      await this.refsStore.set(localRefName, objectIdHex);
      trackingUpdates.push({
        localRef: localRefName,
        remoteRef: refName,
        newObjectId: objectIdHex,
        status: RefUpdateStatus.NEW,
      });
    }

    // Set up HEAD and default branch.
    //
    // Two forms, deliberately kept apart: the advertised form goes out on
    // FetchResult unchanged (it is what the remote said), while the ref work
    // below and CloneResult use the bare branch name.
    const advertisedDefaultBranch = transportResult.defaultBranch;
    const defaultBranch = toBranchName(advertisedDefaultBranch);
    let headCommit: ObjectId | undefined;

    if (defaultBranch && !this.bare) {
      // Create local branch from the tip the clone just wrote. Look under the
      // remote-tracking name first, then under the local branch name: the ref
      // loop above stores each ref under its advertised name, so which of the
      // two exists depends on the refspec the remote advertised through.
      const localRef = `refs/heads/${defaultBranch}`;
      const tip =
        (await this.refsStore.resolve(`refs/remotes/${this.remoteName}/${defaultBranch}`)) ??
        (await this.refsStore.resolve(localRef));

      if (tip?.objectId) {
        await this.refsStore.set(localRef, tip.objectId);
        headCommit = tip.objectId;

        // Set HEAD to point to local branch
        await this.refsStore.setSymbolic("HEAD", localRef);

        // Set up staging area from HEAD tree
        if (!this.noCheckout) {
          await this.checkoutHead(tip.objectId);
        }
      }
    } else if (this.bare || this.mirror) {
      // For bare/mirror repos, HEAD points to default branch
      if (defaultBranch) {
        await this.refsStore.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);
      }
    }

    // Build fetch result
    const advertisedRefs = new Map<string, ObjectId>();
    for (const [refName, objectId] of transportResult.refs) {
      advertisedRefs.set(refName, bytesToHex(objectId));
    }

    const fetchResult: FetchResult = {
      uri: this.uri,
      advertisedRefs,
      trackingRefUpdates: trackingUpdates,
      defaultBranch: advertisedDefaultBranch,
      bytesReceived: transportResult.bytesReceived,
      isEmpty: transportResult.isEmpty,
      messages: [],
    };

    return {
      fetchResult,
      defaultBranch: defaultBranch ?? "main",
      remoteName: this.remoteName,
      bare: this.bare,
      headCommit,
    };
  }

  /**
   * Determine which branch to clone based on options.
   */
  private determineBranchToClone(): string | undefined {
    // Explicit branch takes precedence
    if (this.branch) {
      return this.branch;
    }

    // Mirror or cloneAllBranches means fetch all
    if (this.mirror || this.cloneAllBranches) {
      return undefined;
    }

    // If specific branches are set, use the first one
    if (this.branchesToClone.length > 0) {
      // Extract branch name from full ref if provided
      const first = this.branchesToClone[0];
      if (first.startsWith("refs/heads/")) {
        return first.slice("refs/heads/".length);
      }
      return first;
    }

    return undefined;
  }

  /**
   * Check if a ref should be skipped based on tag option.
   */
  private shouldSkipRef(refName: string): boolean {
    // Skip tags if NO_TAGS option is set
    if (this.tagOption === TagOption.NO_TAGS && refName.startsWith("refs/tags/")) {
      return true;
    }
    return false;
  }

  /**
   * Convert a remote ref name to mirror ref name.
   */
  private toMirrorRefName(refName: string): string {
    // For mirror clones, refs/remotes/origin/* becomes refs/heads/*
    const remotePrefix = `refs/remotes/${this.remoteName}/`;
    if (refName.startsWith(remotePrefix)) {
      return `refs/heads/${refName.slice(remotePrefix.length)}`;
    }
    return refName;
  }

  /**
   * Store received pack data.
   *
   * Unpacks the pack into the working copy's history, so the objects the
   * cloned refs point at are actually available locally.
   */
  private async storePack(packData: Uint8Array): Promise<void> {
    await importPackIntoHistory(this._workingCopy.history, packData);
  }

  /**
   * Checkout HEAD commit to staging area.
   */
  private async checkoutHead(commitId: ObjectId): Promise<void> {
    try {
      const commit = await this.commits.load(commitId);
      if (!commit) {
        return;
      }
      await this.staging.readTree(this.trees, commit.tree);
      await this.staging.write();
    } catch {
      // Commit not available yet (pack not unpacked)
    }
  }
}

/**
 * The bare branch name of a remote's default branch.
 *
 * The advertisement reports it as the target of HEAD's symref capability, so
 * it arrives fully qualified (`refs/heads/main`); a transport that reports the
 * bare name (`main`) is equally legitimate. Both are accepted, and both yield
 * the bare name the ref-building code below prefixes.
 */
function toBranchName(defaultBranch: string | undefined): string | undefined {
  if (defaultBranch === undefined) return undefined;
  const prefix = "refs/heads/";
  return defaultBranch.startsWith(prefix) ? defaultBranch.slice(prefix.length) : defaultBranch;
}
