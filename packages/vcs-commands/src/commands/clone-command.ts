import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type RefspecResolver,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  CloneCheckoutError,
  InvalidArgumentError,
  InvalidRemoteError,
  RefNotFoundError,
} from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { CloneResult } from "../results/clone-result.js";
import type { FetchResult, TrackingRefUpdate } from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { TagOption, toTagMode, toTrackingRefUpdate } from "./fetch-command.js";
import { reflogMessages } from "./reflog-messages.js";
import { isValidRemoteName } from "./remote-command.js";
import { checkoutFreshTree } from "./tree-restore.js";

/** Names the clone's checkout in failure messages. */
const CLONE = "clone";

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
 * Like `git clone`, it configures the remote (`remote.<name>.url`, the
 * `remote.<name>.fetch` refspec of the clone, `remote.<name>.tagOpt` for
 * `--no-tags`, `remote.<name>.mirror`), the upstream of the checked-out branch
 * (`branch.<name>.remote` / `branch.<name>.merge`), and points
 * `refs/remotes/<name>/HEAD` at the remote's default branch.
 *
 * A non-bare clone checks out the commit HEAD names, as `git clone` does: the files
 * of its tree are written to the worktree (executable bits and symbolic links where
 * the worktree can represent them, see `Worktree.capabilities`; an empty directory
 * for each submodule) and the index records them with their stat data. When the
 * worktree cannot represent executables or symlinks, `core.filemode` or
 * `core.symlinks` is set to false, as `git init` does after probing the filesystem.
 * `setNoCheckout(true)` writes neither files nor index; a bare clone has neither.
 *
 * As in git, the checkout comes last, once the refs and the configuration are written:
 * when it fails (a tree path git's `verify_path` refuses, entries that collide, a file
 * in the way) the clone throws a `CloneCheckoutError` ("Clone succeeded, but checkout
 * failed") carrying the clone's result, and the repository stays usable.
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
  private singleBranch?: boolean;
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
   * Set the branch to check out (`git clone --branch`).
   *
   * The branch, or else a tag of that name (checked out as a detached HEAD), instead
   * of the remote's default branch. All branches are still fetched unless
   * {@link setSingleBranch} (or a shallow clone) restricts the clone to this one.
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
   * Set whether to skip checkout (`git clone --no-checkout`): HEAD and the branch are
   * set up, but no file is written and the index is left empty.
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
   * Clone only one branch (`git clone --single-branch`): the {@link setBranch} branch or
   * tag, else the remote's default branch. The remote's fetch refspec is configured for
   * that branch alone, and tags are auto-followed instead of all fetched.
   *
   * Unset, a shallow clone (`setDepth`, `setShallowSince`, `addShallowExclude`) is
   * single-branch, as in git, and so is a clone restricted by
   * {@link setBranchesToClone}; `setSingleBranch(false)` clones all branches anyway.
   */
  setSingleBranch(singleBranch: boolean): this {
    this.checkCallable();
    this.singleBranch = singleBranch;
    return this;
  }

  /** Whether `--single-branch` was set (undefined: decided by the other options). */
  isSingleBranch(): boolean | undefined {
    return this.singleBranch;
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
    if (!isValidRemoteName(this.remoteName)) {
      throw new InvalidArgumentError(
        "remote",
        this.remoteName,
        `'${this.remoteName}' is not a valid remote name`,
      );
    }

    // Determine clone branch strategy
    const branchesToClone = this.mirror || this.cloneAllBranches ? [] : this.branchesToClone;
    const branchToClone = toBranchName(this.branch ?? branchesToClone[0]);
    const history = this._workingCopy.history;

    // git clone's refspecs: tracking refs, local heads (bare), every ref (mirror)
    const tracking = (branch: string) =>
      this.bare ? `refs/heads/${branch}` : `refs/remotes/${this.remoteName}/${branch}`;
    // git: a shallow clone is a single-branch clone (of --branch, else the remote HEAD's branch)
    const singleBranch =
      !this.mirror &&
      (this.singleBranch ??
        (branchesToClone.length > 0 ||
          this.depth !== undefined ||
          this.shallowSince !== undefined ||
          this.shallowExcludes.length > 0));
    let detachedTag: string | undefined;
    let refspecs: string[] | RefspecResolver;
    if (this.mirror) {
      refspecs = ["+refs/*:refs/*"];
    } else if (branchToClone !== undefined && !singleBranch) {
      // --branch without --single-branch: every branch, then the branch (or tag) checked out
      const b = branchToClone;
      refspecs = {
        prefixes: ["refs/heads/", `refs/tags/${b}`],
        resolve: (remoteRefs) => {
          const all = [`+refs/heads/*:${tracking("*")}`];
          if (remoteRefs.some((r) => r.name === `refs/heads/${b}` && r.oid)) return all;
          // git finds the tag among the refs it clones: not with --no-tags
          if (
            this.tagOption !== TagOption.NO_TAGS &&
            remoteRefs.some((r) => r.name === `refs/tags/${b}` && r.oid)
          ) {
            detachedTag = `refs/tags/${b}`;
            return all;
          }
          throw new RefNotFoundError(
            `refs/heads/${b}`,
            `Remote branch ${b} not found in upstream ${this.remoteName}`,
          );
        },
      };
    } else if (branchToClone !== undefined) {
      // --branch names a branch, or else a tag (checked out as a detached HEAD)
      const b = branchToClone;
      refspecs = {
        prefixes: [`refs/heads/${b}`, `refs/tags/${b}`],
        resolve: (remoteRefs) => {
          if (remoteRefs.some((r) => r.name === `refs/heads/${b}` && r.oid)) {
            return [`+refs/heads/${b}:${tracking(b)}`];
          }
          if (remoteRefs.some((r) => r.name === `refs/tags/${b}` && r.oid)) {
            detachedTag = `refs/tags/${b}`;
            return [`+refs/tags/${b}:refs/tags/${b}`];
          }
          throw new RefNotFoundError(
            `refs/heads/${b}`,
            `Remote branch ${b} not found in upstream ${this.remoteName}`,
          );
        },
      };
    } else if (singleBranch) {
      refspecs = {
        prefixes: ["refs/heads/"],
        resolve: (remoteRefs) => {
          const head = remoteRefs.find((r) => r.name === "HEAD")?.symref;
          const name = toBranchName(head);
          return name && head?.startsWith("refs/heads/")
            ? [`+${head}:${tracking(name)}`]
            : [`+refs/heads/*:${tracking("*")}`];
        },
      };
    } else {
      refspecs = [`+refs/heads/*:${tracking("*")}`];
    }
    // git clone takes every tag, unless one branch is cloned (then tags follow) or --no-tags
    const tags =
      this.tagOption === TagOption.AUTO_FOLLOW && !singleBranch && !this.mirror
        ? "all"
        : toTagMode(this.tagOption);

    const result = await transportFetch({
      url: this.uri,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      gzipRequests: this.gzipRequests,
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      tags,
      depth: this.depth,
      deepenSince: this.shallowSince,
      deepenNot: this.shallowExcludes.length > 0 ? this.shallowExcludes : undefined,
      onProgress: this.progressMessageCallback,
      // git's write_remote_refs: one initial transaction, no reflog
      skipReflog: true,
    });
    const cloneLog = this.reflogLine(reflogMessages.clone(this.uri));
    const trackingUpdates: TrackingRefUpdate[] = result.refUpdates.map(toTrackingRefUpdate);

    // Set up HEAD and default branch.
    //
    // Two forms, deliberately kept apart: the advertised form goes out on
    // FetchResult unchanged (it is what the remote said), while the ref work
    // below and CloneResult use the bare branch name.
    const advertisedDefaultBranch = result.defaultBranch;
    let defaultBranch = branchToClone ?? toBranchName(advertisedDefaultBranch);
    let headCommit: ObjectId | undefined;
    let checkedOutBranch: string | undefined;
    // the commit to check out once refs and configuration are in place (git: last)
    let checkoutId: ObjectId | undefined;
    // an empty remote without unborn HEAD: git's default branch (the one init named)
    if (!detachedTag && !this.bare && defaultBranch === undefined && result.isEmpty) {
      defaultBranch = (await this.localHeadBranch()) ?? "main";
    }

    if (detachedTag) {
      // git clone --branch <tag>: a detached HEAD at the tag's commit
      defaultBranch = toBranchName(advertisedDefaultBranch);
      const tag = await this.refsStore.resolve(detachedTag);
      let id = tag?.objectId;
      for (let i = 0; id && i < 16; i++) {
        const target = await history.tags.getTarget(id);
        if (!target || !(await history.tags.has(id))) break;
        id = target;
      }
      if (id) {
        await this.refsStore.set("HEAD", id, cloneLog);
        headCommit = id;
        if (!this.bare && !this.noCheckout) checkoutId = id;
      }
    } else if (defaultBranch && !this.bare) {
      // The local branch starts at the tracking ref the clone just wrote
      const localRef = `refs/heads/${defaultBranch}`;
      const tip = await this.refsStore.resolve(`refs/remotes/${this.remoteName}/${defaultBranch}`);
      // HEAD names the default branch, born or not (an empty remote's unborn HEAD); then
      // the branch is written through it, logged "clone: from <url>" in both reflogs
      await this.refsStore.setSymbolic("HEAD", localRef);
      if (tip?.objectId) {
        await this.refsStore.set(localRef, tip.objectId, cloneLog);
        headCommit = tip.objectId;
        if (!this.noCheckout) checkoutId = tip.objectId;
      }
      // git's install_branch_config: the branch tracks its remote counterpart
      if (tip?.objectId || result.isEmpty) checkedOutBranch = defaultBranch;
    } else if (this.bare || this.mirror) {
      // For bare/mirror repos, HEAD points to default branch
      if (defaultBranch) {
        await this.refsStore.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);
        headCommit = (await this.refsStore.resolve("HEAD"))?.objectId;
      }
    }

    // git's update_remote_refs: refs/remotes/<name>/HEAD names the tracking ref of the
    // remote's default branch, when the clone took that branch
    const remoteHead = advertisedDefaultBranch?.startsWith("refs/heads/")
      ? toBranchName(advertisedDefaultBranch)
      : undefined;
    if (!this.bare && remoteHead) {
      const target = `refs/remotes/${this.remoteName}/${remoteHead}`;
      if ((await this.refsStore.resolve(target))?.objectId) {
        await this.refsStore.setSymbolic(`refs/remotes/${this.remoteName}/HEAD`, target, cloneLog);
      }
    }

    await this.writeConfig({
      worktree: this.bare ? undefined : this.worktreeAccess,
      singleBranch,
      branch: branchToClone,
      detachedTag,
      remoteHead,
      checkedOutBranch,
    });

    // Build fetch result
    const advertisedRefs = new Map<string, ObjectId>();
    for (const ref of result.remoteRefs) {
      if (ref.oid) advertisedRefs.set(ref.name, ref.oid);
    }

    const fetchResult: FetchResult = {
      uri: this.uri,
      advertisedRefs,
      trackingRefUpdates: trackingUpdates,
      defaultBranch: advertisedDefaultBranch,
      bytesReceived: result.packBytes,
      isEmpty: result.isEmpty,
      messages: [],
    };

    const cloneResult: CloneResult = {
      fetchResult,
      defaultBranch: defaultBranch ?? "main",
      remoteName: this.remoteName,
      bare: this.bare,
      headCommit,
    };

    if (checkoutId) {
      try {
        const collided = await this.checkoutHead(checkoutId);
        if (collided.length > 0) cloneResult.collidedPaths = collided;
      } catch (error) {
        throw new CloneCheckoutError(cloneResult, error);
      }
    }
    return cloneResult;
  }

  /**
   * Writes the configuration `git clone` writes (clone.c): `remote.<name>.url`,
   * `remote.<name>.tagOpt` for `--no-tags` and `--mirror` (git 2.49+), the `remote.<name>.fetch` refspec of what was
   * cloned (none for a bare clone; `+refs/*:refs/*` and `remote.<name>.mirror` for a
   * mirror; one branch or tag for a single-branch clone), and the upstream of the
   * checked-out branch (`branch.<b>.remote`, `branch.<b>.merge`).
   */
  private async writeConfig(clone: {
    worktree?: Worktree;
    singleBranch: boolean;
    branch?: string;
    detachedTag?: string;
    remoteHead?: string;
    checkedOutBranch?: string;
  }): Promise<void> {
    const store = RemoteConfigStore.from(this.workingCopy);
    // git init probes the filesystem: what the worktree cannot represent is turned off
    const capabilities = clone.worktree?.capabilities;
    if (capabilities?.executable === false) store.setValue("core.filemode", "false");
    if (capabilities?.symlinks === false) store.setValue("core.symlinks", "false");
    // ...and whether it folds case or Unicode composition (git writes each only when found)
    const folding = await clone.worktree?.probeCaseFolding?.();
    if (folding?.ignoreCase) store.setValue("core.ignorecase", "true");
    if (folding?.precomposeUnicode) store.setValue("core.precomposeunicode", "true");
    const remote = `remote.${this.remoteName}`;
    store.setValue(`${remote}.url`, this.uri as string);
    // git >= 2.49: --mirror implies --no-tags (its refspec still maps every tag)
    if (this.tagOption === TagOption.NO_TAGS || this.mirror) {
      store.setValue(`${remote}.tagOpt`, "--no-tags");
    }
    let fetchRefspec: string | undefined;
    if (this.mirror) {
      fetchRefspec = "+refs/*:refs/*";
    } else if (!this.bare) {
      const top = `refs/remotes/${this.remoteName}/`;
      if (!clone.singleBranch) fetchRefspec = `+refs/heads/*:${top}*`;
      else if (clone.detachedTag) fetchRefspec = `+${clone.detachedTag}:${clone.detachedTag}`;
      else if (clone.branch) fetchRefspec = `+refs/heads/${clone.branch}:${top}${clone.branch}`;
      // without a remote HEAD branch, a later fetch takes the remote HEAD alone, as in git
      else if (clone.remoteHead)
        fetchRefspec = `+refs/heads/${clone.remoteHead}:${top}${clone.remoteHead}`;
    }
    if (fetchRefspec) {
      store.setValue(`${remote}.fetch`, fetchRefspec);
      if (this.mirror) store.setValue(`${remote}.mirror`, "true");
    }
    if (!this.bare && clone.checkedOutBranch) {
      store.setValue(`branch.${clone.checkedOutBranch}.remote`, this.remoteName);
      store.setValue(
        `branch.${clone.checkedOutBranch}.merge`,
        `refs/heads/${clone.checkedOutBranch}`,
      );
    }
    await store.save();
  }

  /** The branch the local HEAD names (`init.defaultBranch` of the new repository), if any. */
  private async localHeadBranch(): Promise<string | undefined> {
    const head = await this.refsStore.get("HEAD");
    return head && "target" in head && head.target.startsWith("refs/heads/")
      ? head.target.slice("refs/heads/".length)
      : undefined;
  }

  /**
   * Check out the cloned commit, as `git clone` does: the files of its tree into the
   * worktree, then the index with the stat data of the files written. Without a
   * worktree only the index is filled.
   *
   * The whole tree is planned (and every blob checked) before the first file is
   * written. Symlinks become links where the worktree makes them and `core.symlinks`
   * is not false, else plain files holding the target (the index keeps mode 120000);
   * a submodule becomes an empty directory, as in a clone without `--recurse-submodules`.
   *
   * The index records size, mtime and (where the worktree reports it) ctime, but no inode,
   * device, uid or gid, which FilesApi does not give: `git status` sees the files clean and
   * refreshes the index once, while commands that do not refresh (`git diff-files`,
   * `git diff-index --quiet`) report every file as changed until then, unless
   * `core.checkStat=minimal`.
   */
  private async checkoutHead(commitId: ObjectId): Promise<string[]> {
    const commit = await this.commits.load(commitId).catch(() => undefined);
    if (!commit) return [];
    const worktree = this.bare ? undefined : this.worktreeAccess;
    return checkoutFreshTree(
      {
        trees: this.trees,
        blobs: this.blobs,
        staging: this.staging,
        worktree,
        symlinks: worktree ? this.symlinksEnabled(worktree) : false,
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      },
      commit.tree,
      CLONE,
    );
  }

  /** Whether symlinks are written as links: the worktree can, and `core.symlinks` allows. */
  private symlinksEnabled(worktree: Worktree): boolean {
    return worktreeModeTrust(this.workingCopy, worktree).symlinks;
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
