import { type FilesApi, isSymbolicRef, type ObjectId } from "@statewalker/vcs-core";
import { computeAlternatePath, HostPaths, hostRootOf } from "@statewalker/vcs-store-files";
import {
  createRepositoryFacade,
  createTransportRefStore,
  FetchCheckError,
  fetchFromConnection,
  type RefspecResolver,
  type FetchOptions as TransportFetchOptions,
} from "@statewalker/vcs-transport";
import type { OpenedRepository, Worktree } from "@statewalker/vcs-working-tree";

import {
  CloneCheckoutError,
  CloneDestinationError,
  InvalidArgumentError,
  InvalidRemoteError,
  RefNotFoundError,
  TransportError,
} from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { CloneResult } from "../results/clone-result.js";
import type { FetchResult, TrackingRefUpdate } from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { TagOption, toTagMode, toTrackingRefUpdate } from "./fetch-command.js";
import { fetchFsckOf } from "./fsck/index.js";
import { runPostCheckoutHook } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { copyLocalObjects } from "./local-clone.js";
import { reflogMessages } from "./reflog-messages.js";
import { isValidRemoteName } from "./remote-command.js";
import { withRemoteUploadPack } from "./remote-transport.js";
import { SparseCheckoutCommand } from "./sparse-checkout-command.js";
import { SparseUnpack } from "./sparse-checkout-support.js";
import { checkoutFreshTree } from "./tree-restore.js";
import { repositoryPlaceOf } from "./worktree-support.js";

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
  /** The source as clone.c records it: an existing path made absolute, else the URL */
  private repoUrl?: string;
  private branch?: string;
  private depth?: number;
  private uploadPack?: string;
  private bare = false;
  private noCheckout = false;
  private sparse = false;
  private remoteName = "origin";
  private cloneAllBranches = true;
  private mirror = false;
  private singleBranch?: boolean;
  private branchesToClone: string[] = [];
  private tagOption: TagOption = TagOption.AUTO_FOLLOW;
  private shallowSince?: Date;
  private shallowExcludes: string[] = [];
  private directory?: string;
  private shared = false;
  /** `--local` (true), `--no-local` (false), neither (undefined: local for a path) */
  private local?: boolean;
  private dissociate = false;
  /** `--reference` (required) and `--reference-if-able` paths, in the order given */
  private references: { path: string; required: boolean }[] = [];

  /**
   * The destination directory as `git clone <url> <directory>` names it, for messages only
   * (the clone goes into the working copy the command was made for). Default: the last
   * component of the worktree's top.
   */
  setDirectory(directory: string): this {
    this.checkCallable();
    this.directory = directory;
    return this;
  }

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
   * Set the program the remote runs for upload-pack (git's `clone --upload-pack` / `-u`):
   * what an ssh connector runs, and what git:// names in its request line. As git's clone,
   * the default is `git-upload-pack` whatever `remote.<name>.uploadpack` says, and the value
   * is not written to the new repository's config.
   *
   * @param uploadPack Path to git-upload-pack on the remote
   */
  setUploadPack(uploadPack: string): this {
    this.checkCallable();
    this.uploadPack = uploadPack;
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
   * `git clone --sparse`: the new worktree starts as a cone-mode sparse checkout of the
   * top-level files only (git runs `git sparse-checkout set` before its checkout), the
   * other entries skip-worktree and not written.
   */
  setSparse(sparse: boolean): this {
    this.checkCallable();
    this.sparse = sparse;
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
   * `git clone --shared` (`-s`): a clone of a local repository path borrows the source's
   * objects through `objects/info/alternates` (the source's common directory's `objects`)
   * instead of fetching them. Ignored for URLs (`file://` too) and for a shallow source, as
   * git ignores it outside `clone_local`.
   */
  setShared(shared: boolean): this {
    this.checkCallable();
    this.shared = shared;
    return this;
  }

  /**
   * `git clone --local` (`-l`, true) / `--no-local` (false). A source given as a path to a
   * local repository (not a URL, `file://` included) is cloned as git's `clone_local` does,
   * unless `--no-local`: its refs are listed through the transport, but its objects directory
   * is copied (or, with {@link setShared}, borrowed) instead of fetched, its
   * `objects/info/alternates` entries carried over as absolute paths, and the refs written
   * without a connectivity check; `--depth`, `--shallow-since` and `--shallow-exclude` are
   * ignored with git's warnings (`CloneResult.messages`). A shallow source is fetched instead
   * (`--local` then warns "source repository is shallow, ignoring --local"), and `--local`
   * with a URL warns "--local is ignored". A store without files (memory, KV, SQL) on either
   * side is fetched from too.
   */
  setLocal(local: boolean): this {
    this.checkCallable();
    this.local = local;
    return this;
  }

  /**
   * `git clone --no-hardlinks`: git copies the files of a local clone instead of hardlinking
   * them. Ours always copies (the FilesApi has no hard-link primitive), so this changes
   * nothing but is accepted.
   */
  setNoHardlinks(_noHardlinks: boolean): this {
    this.checkCallable();
    return this;
  }

  /**
   * `git clone --reference <repository>`: borrow from that local repository
   * (`objects/info/alternates` names its objects) and fetch only what it lacks. A path that is
   * no usable repository fails the clone before anything is fetched ("reference repository
   * '<path>' is not a local repository.", "... is shallow", "... is grafted").
   */
  addReference(path: string): this {
    this.checkCallable();
    this.references.push({ path, required: true });
    return this;
  }

  /**
   * `git clone --reference-if-able <repository>`: as {@link addReference}, but a path that is
   * no usable repository is skipped with git's "info: Could not add alternate for '<path>':
   * <reason>" (in `CloneResult.messages`).
   */
  addReferenceIfAble(path: string): this {
    this.checkCallable();
    this.references.push({ path, required: false });
    return this;
  }

  /**
   * `git clone --dissociate`: once the refs are written, the borrowed objects are copied in
   * (`git repack -a -d`) and `objects/info/alternates` is removed, before the checkout.
   */
  setDissociate(dissociate: boolean): this {
    this.checkCallable();
    this.dissociate = dissociate;
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

    // clone.c: the source is a path or a URL before anything else (get_repo_path): an
    // existing repository path becomes absolute (remote.<name>.url, the reflog), a name with
    // a colon is a URL, anything else is "does not exist", never rewritten. The URL connected
    // to is remote.<name>.url as remote_get reads it: rewritten by url.<base>.insteadOf (the
    // absolute path of a local source too). It is resolved, and a local repository opened,
    // before anything is written (git's "does not appear to be a git repository" leaves no
    // clone behind)
    const uri = this.uri;
    // a bare repository's working copy opens it from its git directory
    const worktree = repositoryPlaceOf(this.workingCopy);
    const isRepositoryPath = await worktree
      ?.openRepository?.(uri)
      .then((opened) => opened !== undefined)
      .catch(() => false);
    let repo: string;
    if (isRepositoryPath) repo = absolutePathOf(worktree, uri);
    else if (uri.includes(":")) repo = uri;
    else throw new TransportError(`fatal: repository '${uri}' does not exist`);
    this.repoUrl = repo;
    const sourceUrl = RemoteConfigStore.from(this.workingCopy).aliasUrl(repo) ?? repo;
    const remote = await this.prepareRemote(sourceUrl);
    const localRemote: OpenedRepository | undefined =
      remote.kind === "local" ? remote.repository : undefined;

    // clone.c: a destination that exists and is not empty is refused before anything is
    // written; here the destination is the working copy, empty once `git init` made it
    await this.refuseNonEmptyDestination(localRemote);

    // clone.c's is_local: a local repository path (remote.<name>.url as rewritten; never a
    // URL, file:// included), unless --no-local or the source is shallow
    const localWarnings: string[] = [];
    let isLocal =
      this.local !== false &&
      localRemote !== undefined &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(sourceUrl);
    let depth = this.depth;
    let shallowSince = this.shallowSince;
    let shallowExcludes = this.shallowExcludes;
    if (isLocal && localRemote) {
      if (depth !== undefined) {
        localWarnings.push("warning: --depth is ignored in local clones; use file:// instead.\n");
      }
      if (shallowSince !== undefined) {
        localWarnings.push(
          "warning: --shallow-since is ignored in local clones; use file:// instead.\n",
        );
      }
      if (shallowExcludes.length > 0) {
        localWarnings.push(
          "warning: --shallow-exclude is ignored in local clones; use file:// instead.\n",
        );
      }
      if (await sourceIsShallow(localRemote, worktree?.getFiles?.())) {
        if (this.local === true) {
          localWarnings.push("warning: source repository is shallow, ignoring --local\n");
        }
        isLocal = false;
      }
    }
    if (this.local === true && !isLocal) localWarnings.push("warning: --local is ignored\n");
    if (isLocal) {
      depth = undefined;
      shallowSince = undefined;
      shallowExcludes = [];
    }

    // setup_reference, then clone_local's --shared: the alternates before the fetch, which
    // then takes only what they lack (their refs are complete history to it)
    const messages = await this.setupAlternates(worktree, isLocal ? localRemote : undefined, repo);
    messages.push(...localWarnings);
    // clone_local without --shared: the source's objects copied once its refs are listed,
    // the advertised refs then complete history (nothing fetched)
    const copyObjects =
      isLocal && !this.shared && localRemote
        ? this.localObjectsCopy(worktree, localRemote, repo)
        : undefined;

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
            `fatal: Remote branch ${b} not found in upstream ${this.remoteName}`,
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
            `fatal: Remote branch ${b} not found in upstream ${this.remoteName}`,
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

    // fetch.fsckObjects / transfer.fsckObjects (the clone's own config, `-c` settings included)
    const environment = hostEnvironmentOf(this.workingCopy);
    const fsckWarnings: string[] = [];
    const fsck = await fetchFsckOf({
      value: (key) => RemoteConfigStore.from(this.workingCopy).value(key),
      entries: (prefix) => RemoteConfigStore.from(this.workingCopy).entriesWithPrefix(prefix),
      warnings: fsckWarnings,
      compatibility: this.hooks.compatibility,
      ...(environment
        ? { readFile: (path: string) => environment.readFile(path), home: environment.home }
        : {}),
      baseDir: await this.hostWorkingDir(),
    });

    const fetchOptions: TransportFetchOptions = {
      url: sourceUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      gzipRequests: this.gzipRequests,
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      tags,
      depth,
      deepenSince: shallowSince,
      deepenNot: shallowExcludes.length > 0 ? shallowExcludes : undefined,
      onProgress: this.progressMessageCallback,
      // git's write_remote_refs: one initial transaction (packed-refs), no reflog; the
      // followed tags of a single-branch clone each on their own (write_followtags)
      skipReflog: true,
      initialTransaction: true,
      // fetch-pack's args->cloning: a shallow source's shallow commits are recorded
      cloning: true,
      // clone.c sets TRANS_OPT_KEEP: the pack is kept whatever its size
      keepPack: true,
      ...(fsck ? { fsckObjects: fsck } : {}),
      ...(copyObjects
        ? {
            beforeFetch: async (remoteRefs) => {
              const { warnings } = await copyObjects();
              for (const w of warnings) messages.push(`${w}\n`);
              const tips: string[] = [];
              for (const ref of remoteRefs) if (ref.oid) tips.push(ref.oid);
              return { completeTips: tips };
            },
          }
        : {}),
    };
    // transport_get: git's local transport (upload-pack of the repository at the path, in
    // process), or the connector the transport registry names (smart HTTP by default)
    const sessionOptions = {
      ...this.remoteSessionOptions(),
      ...(this.uploadPack !== undefined ? { program: this.uploadPack } : {}),
    };
    const result = await withRemoteUploadPack(remote, sessionOptions, (connection) =>
      fetchFromConnection(connection, fetchOptions),
    ).catch((error: unknown) => {
      if (!(error instanceof FetchCheckError)) throw error;
      // what was received is refused before any ref is written: index-pack died, or
      // update_remote_refs' check of the refs found history missing (git then removes the
      // clone, as for any failure: the caller's destination)
      // fetch-pack ran: its start-up warnings came first
      const lines = [...fsckWarnings, ...error.lines];
      if (error.check === "refs") lines.push("fatal: remote did not send all necessary objects");
      throw new FetchCheckError(error.check, lines, 128);
    });
    if (result.imports.length > 0) messages.push(...fsckWarnings.map((w) => `${w}\n`));
    messages.push(...(result.packCheckMessages ?? []).map((w) => `${w}\n`));
    // write_remote_refs dies when its transaction fails
    if (result.refTransactionError !== undefined) {
      throw new TransportError(`fatal: ${result.refTransactionError}`);
    }
    const cloneLog = this.reflogLine(reflogMessages.clone(repo));
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

    // git's update_remote_refs (before update_head): refs/remotes/<name>/HEAD names the tracking ref of the
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

    if (detachedTag) {
      // git clone --branch <tag>: a detached HEAD at the tag's commit
      defaultBranch = toBranchName(advertisedDefaultBranch);
      const tag = await this.refsStore.resolve(detachedTag);
      let id = tag?.objectId;
      // peeled as git peels it, through replace refs (peel_to_type reads parsed objects)
      const tags = this.tagsStore ?? history.tags;
      for (let i = 0; id && i < 16; i++) {
        const target = await tags.getTarget(id);
        if (!target || !(await tags.has(id))) break;
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
        // update_head's refs_update_ref("HEAD"): through HEAD, unchecked
        const written = await this.refsStore.batch([{ name: "HEAD", new: tip.objectId }], cloneLog);
        if (!written.ok) throw new TransportError(`fatal: unable to update ${localRef}`);
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

    await this.writeConfig({
      worktree: this.bare ? undefined : this.worktreeAccess,
      singleBranch,
      branch: branchToClone,
      detachedTag,
      remoteHead,
      checkedOutBranch,
      isEmpty: result.isEmpty,
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
      ...(messages.length > 0 ? { messages } : {}),
    };

    // dissociate_from_references: before the checkout, the borrowed objects copied in
    // (a store without alternates has nothing to dissociate from)
    if (this.dissociate) await history.objects?.alternates?.dissociate?.();

    if (checkoutId) {
      try {
        const collided = await this.checkoutHead(checkoutId);
        if (collided.length > 0) cloneResult.collidedPaths = collided;
      } catch (error) {
        throw new CloneCheckoutError(cloneResult, error);
      }
      // checkout()'s post-checkout hook: from no commit to the one checked out, a branch
      // switch; its exit code becomes the clone's exit status
      // (clone exports GIT_DIR, the new repository's absolute path, and no GIT_PREFIX)
      const gitDir = this.hooks.enabled ? await this.hooks.hostGitDir() : undefined;
      const code = await runPostCheckoutHook(
        this.hooks,
        undefined,
        checkoutId,
        true,
        gitDir ? { GIT_DIR: gitDir } : undefined,
        undefined,
        false,
      );
      if (code !== 0) cloneResult.hookExitCode = code;
    }
    return cloneResult;
  }

  /**
   * The alternates `git clone` writes before it fetches: each `--reference` (a required one
   * that is no usable repository fails the clone; an optional one is reported in the returned
   * messages), then, for `--shared` with a local source path that is not shallow, the source's
   * objects (`<common dir>/objects`, named as git names the source: its path as given made
   * absolute, the `.git` found below it appended).
   */
  private async setupAlternates(
    worktree: Pick<Worktree, "getRoot" | "getFiles"> | undefined,
    localSource: OpenedRepository | undefined,
    repo: string,
  ): Promise<string[]> {
    const messages: string[] = [];
    const sharing = this.shared && localSource !== undefined;
    if (this.references.length === 0 && !sharing) return messages;
    const alternates = this._workingCopy.history.objects?.alternates;
    const files = worktree?.getFiles?.();
    if (!alternates || !files) {
      throw new TransportError("fatal: this repository cannot borrow objects (no alternates)");
    }
    for (const { path, required } of this.references) {
      const found = await computeAlternatePath(files, absolutePathOf(worktree, path), path);
      if ("error" in found) {
        if (required) throw new TransportError(`fatal: ${found.error}`);
        messages.push(`info: Could not add alternate for '${path}': ${found.error}\n`);
        continue;
      }
      await alternates.add(`${found.gitDir}/objects`);
    }
    if (sharing && localSource) {
      // a shallow source is cloned through the transport (clone.c: is_local = 0)
      if (!(await sourceIsShallow(localSource, files)))
        await alternates.add(`${sourceCommonDirPath(files, localSource, repo)}/objects`);
    }
    return messages;
  }

  /**
   * clone_local's copy of the source's objects (see `local-clone.ts`), or undefined where
   * either side keeps no files (the clone then fetches).
   */
  private localObjectsCopy(
    worktree: Pick<Worktree, "getRoot" | "getFiles" | "getGitDir"> | undefined,
    source: OpenedRepository,
    repo: string,
  ): (() => Promise<{ warnings: string[] }>) | undefined {
    const files = worktree?.getFiles?.();
    const gitDir = worktree?.getGitDir?.();
    const alternates = this._workingCopy.history.objects?.alternates;
    const sourceFiles = source.files ?? files;
    if (!files || gitDir === undefined || !sourceFiles || !alternates) return undefined;
    const commonDir = (source.commonDir ?? source.gitDir).replace(/\/+$/, "");
    return async () => {
      const result = await copyLocalObjects({
        source: {
          files: sourceFiles,
          objectsDir: `${commonDir}/objects`,
          repo: sourceGitDirPath(files, source, repo),
          objectsPath: `${sourceCommonDirPath(files, source, repo)}/objects`,
        },
        target: { files, objectsDir: `${gitDir.replace(/\/+$/, "")}/objects` },
        addAlternate: (path) => alternates.add(path),
      });
      // the copied packs (and commit-graph) are read from now on
      await this._workingCopy.history.packs?.refresh();
      this._workingCopy.history.commitGraph?.invalidate();
      return result;
    };
  }

  /**
   * git's "destination path '<dir>' already exists and is not an empty directory" (exit
   * 128) for a working copy that is no freshly initialised repository: one with a ref
   * (commits, a tag), index entries or files in its worktree, or that the local source
   * resolves to (`git clone . .`). The directory is named as the worktree's top is
   * ({@link setDirectory}, else its last component, `.` for the root).
   */
  private async refuseNonEmptyDestination(source: OpenedRepository | undefined): Promise<void> {
    const refuse = () => {
      const root = repositoryPlaceOf(this._workingCopy)?.getRoot?.() ?? "";
      const name = this.directory ?? (root.replace(/\/+$/, "").split("/").pop() || ".");
      return new CloneDestinationError(
        `fatal: destination path '${name}' already exists and is not an empty directory.`,
      );
    };
    const history = this._workingCopy.history;
    for await (const ref of history.refs.list()) {
      if (!isSymbolicRef(ref)) throw refuse();
    }
    if (await this.refsStore.resolve("HEAD").catch(() => undefined)) throw refuse();
    // a bare repository's working copy has no index (nor checkout to ask)
    const staging =
      "checkout" in this._workingCopy ? this._workingCopy.checkout?.staging : undefined;
    if (staging) {
      for await (const _entry of staging.entries()) throw refuse();
    }
    const worktree = this.bare ? undefined : this.worktreeAccess;
    if (worktree) {
      // the repository's own git directory, when it lies in the worktree under another name
      // than `.git` (`git init --separate-git-dir`-like layouts): git checks the destination
      // before it makes one
      const own = ownGitDirIn(worktree);
      for await (const entry of worktree.walk({
        includeIgnored: true,
        includeDirectories: true,
      })) {
        if (own && (entry.path === own || entry.path.startsWith(`${own}/`))) continue;
        throw refuse();
      }
      if (source) {
        const self = await worktree.openRepository?.(".").catch(() => undefined);
        if (self && (self.commonDir ?? self.gitDir) === (source.commonDir ?? source.gitDir)) {
          throw refuse();
        }
      }
    }
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
    isEmpty?: boolean;
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
    store.setValue(`${remote}.url`, this.repoUrl ?? (this.uri as string));
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
      // without a remote HEAD branch, a later fetch takes the remote HEAD alone, as in git;
      // an empty remote's unborn HEAD points at nothing (remote_head_points_at): no refspec
      else if (clone.remoteHead && !clone.isEmpty)
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
    // git_sparse_checkout_init: `git sparse-checkout set` in the new repository (no index
    // yet: the file and the config only), then the checkout applies its patterns
    const sparse =
      this.sparse && worktree
        ? await (async () => {
            await new SparseCheckoutCommand(this.workingCopy).setArguments(["set"]).call();
            return SparseUnpack.start({
              workingCopy: this.workingCopy,
              worktree,
              staging: this.staging,
            });
          })()
        : undefined;
    const collided = await checkoutFreshTree(
      {
        trees: this.trees,
        blobs: this.blobs,
        staging: this.staging,
        worktree,
        symlinks: worktree ? this.symlinksEnabled(worktree) : false,
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
        ...(sparse ? { writes: (path: string) => sparse.writes(path) } : {}),
      },
      commit.tree,
      CLONE,
    );
    // loop #2 of unpack-trees: the entries outside the patterns are skip-worktree
    await sparse?.finish({
      workingCopy: this.workingCopy,
      worktree,
      staging: this.staging,
      blobs: this.blobs,
    });
    return collided;
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
/**
 * clone.c's `absolute_pathdup` of a local source: an absolute path as given, a relative one
 * after the directory clone runs in (the worktree top, as the host sees it when the storage
 * has a root directory), without resolving `..` (git writes `/top/../src`).
 */
function absolutePathOf(
  worktree: Pick<Worktree, "getRoot" | "getFiles"> | undefined,
  path: string,
): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const top = worktree?.getRoot() ?? "";
  const files = worktree?.getFiles?.() as { rootDirectory?: string } | undefined;
  const root = files?.rootDirectory?.replace(/\/+$/, "");
  const inStorage = top.replace(/^\/+|\/+$/g, "");
  const base = root !== undefined ? (inStorage ? `${root}/${inStorage}` : root) : `/${inStorage}`;
  return `${base.replace(/\/+$/, "")}/${path}`;
}

/**
 * clone_local's `get_common_dir(src_repo)`: the source's git directory as clone.c names it
 * (`repo`, its path as given made absolute, with the suffix get_repo_path found: `/.git`,
 * none, `.git/.git` or `.git`), or, for a gitfile or a linked worktree's `commondir`, the
 * host path of the directory reached.
 */
function sourceCommonDirPath(files: FilesApi, source: OpenedRepository, repo: string): string {
  const host = new HostPaths(hostRootOf(files));
  const hostOf = (p: string) => (host.known ? host.hostPath(p) : p);
  const commonDir = source.commonDir ?? source.gitDir;
  if (commonDir !== source.gitDir) return hostOf(commonDir);
  const base = repo.replace(/\/+$/, "");
  const gitDir = hostOf(source.gitDir);
  for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
    if (host.same(`${base}${suffix}`, gitDir)) return `${base}${suffix}`;
  }
  return gitDir;
}

/**
 * clone.c's `src_repo` (get_repo_path's answer): the source's git directory as clone.c names
 * it; copy_alternates makes the source's relative alternates absolute from there.
 */
function sourceGitDirPath(files: FilesApi, source: OpenedRepository, repo: string): string {
  if ((source.commonDir ?? source.gitDir) === source.gitDir) {
    return sourceCommonDirPath(files, source, repo);
  }
  const host = new HostPaths(hostRootOf(files));
  return host.known ? host.hostPath(source.gitDir) : source.gitDir;
}

/**
 * Whether the source has a `shallow` file (clone.c: a shallow source is not cloned locally).
 * clone.c looks in the git directory get_repo_path found, a linked worktree's own (the
 * gitfile's target) and not the common directory, so a linked worktree of a shallow
 * repository is cloned locally as git does.
 */
async function sourceIsShallow(
  source: OpenedRepository,
  files: FilesApi | undefined,
): Promise<boolean> {
  const storage = source.files ?? files;
  if (!storage) return false;
  const gitDir = source.gitDir.replace(/\/+$/, "");
  return (await storage.stats(`${gitDir}/shallow`).catch(() => undefined)) !== undefined;
}

function toBranchName(defaultBranch: string | undefined): string | undefined {
  if (defaultBranch === undefined) return undefined;
  const prefix = "refs/heads/";
  return defaultBranch.startsWith(prefix) ? defaultBranch.slice(prefix.length) : defaultBranch;
}

/** The worktree's git directory as a path of the worktree, when it lies inside it. */
function ownGitDirIn(worktree: Worktree): string | undefined {
  const trim = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const gitDir = worktree.getGitDir?.();
  if (gitDir === undefined) return undefined;
  const dir = trim(gitDir);
  const root = trim(worktree.getRoot?.() ?? "");
  if (!root) return dir || undefined;
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : undefined;
}
