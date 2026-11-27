import {
  compareRefNames,
  type FilesApi,
  historyWithoutLazyFetch,
  isSymbolicRef,
  isValidRefName,
  ObjectFilterError,
  type ObjectId,
  parseObjectFilter,
} from "@statewalker/vcs-core";
import {
  CONFIG_REGEX_NONE,
  computeAlternatePath,
  GitWorkingCopyConfig,
  HostPaths,
  hostRootOf,
  objectStorageFormatByUri,
  parseConfigKey,
  setConfigMultivarText,
} from "@statewalker/vcs-store-files";
import {
  bundleUriLines,
  createRepositoryFacade,
  createTransportRefStore,
  FetchCheckError,
  fetchFromConnection,
  mapRefs,
  missingSources,
  type RefspecResolver,
  type RemoteRef,
  refPrefixes,
  ShallowRemoteRejectedError,
  type FetchOptions as TransportFetchOptions,
  type UploadPackConnection,
} from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import { parseGitInt } from "@statewalker/vcs-utils/encoding";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { OpenedRepository, WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";
import {
  CloneCheckoutError,
  CloneDestinationError,
  GitApiError,
  InvalidArgumentError,
  InvalidRemoteError,
  RefNotFoundError,
  TransportError,
} from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { CloneResult } from "../results/clone-result.js";
import type { FetchResult, TrackingRefUpdate } from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";
import {
  BundleList,
  BundlePrerequisitesError,
  fetchBundleList,
  fetchBundleUri,
  parseBundleListLine,
} from "./bundle/index.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import {
  type DefaultBranch,
  defaultInitialBranch,
  type NewRepositoryConfig,
  UnsupportedObjectStorageError,
  unknownObjectStorageFormat,
} from "./default-branch.js";
import { TagOption, toTagMode, toTrackingRefUpdate } from "./fetch-command.js";
import { fetchFsckOf } from "./fsck/index.js";
import { runPostCheckoutHook } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { copyLocalObjects } from "./local-clone.js";
import { promisorOf } from "./promisor-remote.js";
import {
  promisorAutoFilter,
  promisorRemoteReplyOf,
  resetPromisorAcceptance,
} from "./promisor-remote-reply.js";
import { reflogMessages } from "./reflog-messages.js";
import { isValidRemoteName } from "./remote-command.js";
import { withRemoteUploadPack } from "./remote-transport.js";
import { clientSessionIdOf } from "./session-id.js";
import { SparseCheckoutCommand } from "./sparse-checkout-command.js";
import { SparseUnpack } from "./sparse-checkout-support.js";
import { SubmoduleCommandError, type SubmoduleCommandResult } from "./submodule-commands.js";
import { SubmoduleUpdateCommand } from "./submodule-update-command.js";
import { checkoutFreshTree } from "./tree-restore.js";
import { uriProtocolsOption } from "./uri-protocols.js";
import { worktreePathRules } from "./worktree-path-rules.js";
import { repositoryPlaceOf, worktreeAdminWorkingCopy } from "./worktree-support.js";

/** The settings a clone reopened with another object format runs with again. */
const CLONE_SETTINGS = [
  "uri",
  "branch",
  "depth",
  "filterSpec",
  "uploadPack",
  "bare",
  "noCheckout",
  "sparse",
  "remoteName",
  "remoteExplicit",
  "revision",
  "rejectShallow",
  "serverOptions",
  "compatibility",
  "bundleUri",
  "cloneAllBranches",
  "mirror",
  "singleBranch",
  "branchesToClone",
  "tagOption",
  "shallowSince",
  "shallowExcludes",
  "directory",
  "shared",
  "local",
  "dissociate",
  "references",
  "recurseSubmodules",
  "objectStorageFormat",
  "shallowSubmodules",
  "alsoFilterSubmodules",
  "remoteSubmodules",
  "credentials",
  "timeout",
  "headers",
  "gzipRequests",
  "credentialHelper",
  "warningCallback",
  "progressCallback",
  "progressMessageCallback",
  "progress",
  "transportRegistry",
  "bundles",
  "useReplaceRefsOverride",
  "reflogActionOverride",
];

/** The remote names objects with another hash than the destination (see `cloneReopenedAs`). */
class RemoteObjectFormatSwitch extends Error {
  constructor(readonly format: ObjectFormat) {
    super(`the remote repository's object format is ${format.name}`);
  }
}

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
  /** `--filter=<spec>`, expanded as git sends and records it */
  private filterSpec?: string;
  private uploadPack?: string;
  private bare = false;
  private noCheckout = false;
  private sparse = false;
  private remoteName = "origin";
  /** `-o`/`--origin` given: `clone.defaultRemoteName` is not read */
  private remoteExplicit = false;
  /** `-c`/`--config` entries (`key=value`, or `key` for true) */
  private configEntries: string[] = [];
  /** `--revision` (git 2.49+) */
  private revision?: string;
  /** `--[no-]reject-shallow`; unset: `clone.rejectShallow` */
  private rejectShallow?: boolean;
  /** `--server-option` values */
  private serverOptions: string[] = [];
  /** The git version reproduced; default the hooks' */
  private compatibility?: "2.43" | "2.56";
  private bundleUri?: string;
  /**
   * The hash `--bundle-uri`'s bundles are read in: git 2.43 fetches them before it learns the
   * remote's hash, in the destination's first one (set on a clone reopened under 2.43)
   */
  private bundleObjectFormat?: ObjectFormat;
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
  /** `--recurse-submodules[=<pathspec>]` values, in the order given */
  private recurseSubmodules: string[] = [];
  private objectStorageFormat?: string;
  private shallowSubmodules = false;
  /** `--[no-]also-filter-submodules`; unset: `clone.filterSubmodules` */
  private alsoFilterSubmodules?: boolean;
  private remoteSubmodules = false;

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
   * `git clone --bundle-uri=<uri>`: before fetching from the remote, the bundle (or bundle
   * list) at `uri` is downloaded and applied, its refs written under `refs/bundles/`
   * (bundle-uri.c's `fetch_bundle_uri`), so the fetch asks only for what the bundles lack.
   * `uri` is an `http(s)://` URL, a `file://` URL or a path (relative to the worktree top).
   * A failure only warns (`CloneResult.messages`). A list using the `creationToken`
   * heuristic is remembered as `fetch.bundleURI` (later fetches download its new bundles),
   * with `fetch.bundleCreationToken`. Without it, `transfer.bundleURI=true` asks a protocol
   * v2 server for its bundle list (the `bundle-uri` command). Refused with a shallow clone,
   * as git.
   */
  setBundleUri(uri: string): this {
    this.checkCallable();
    this.bundleUri = uri;
    return this;
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
   * A partial clone (git's `clone --filter=<spec>`): the server is asked to leave out what
   * the filter omits (`blob:none`, `blob:limit=<n>`, `tree:<depth>`, `sparse:oid=<blob-ish>`,
   * `object:type=<type>`, `combine:...`), the received pack is kept as a promisor pack, and the
   * remote is recorded as git's partial_clone_register does (`core.repositoryformatversion =
   * 1`, `remote.<name>.promisor`, `remote.<name>.partialclonefilter`). A server that takes
   * no filters sends everything, with git's warning; a local clone ignores the filter
   * (`--filter is ignored in local clones; use file:// instead.`), its config still written.
   *
   * Objects left out are fetched lazily from the remote when read (the checkout fetches the
   * blobs it writes in one batch, as git's).
   *
   * `auto` (git 2.54) takes the filter the promisor remotes accepted from the server's
   * `promisor-remote` capability advertise (none: no filter) and is recorded as `auto`, so
   * later fetches resolve it again.
   *
   * @param spec The filter spec; `blob:limit=1k` is recorded and sent as `blob:limit=1024`
   * @throws ObjectFilterError with git's message for a spec git refuses
   */
  setFilter(spec: string): this {
    this.checkCallable();
    // `auto` (git 2.54): the filter the promisor remotes the server advertises and this
    // clone accepts propose (promisor_remote_construct_filter), recorded as `auto`
    if (spec === "auto") {
      this.filterSpec = spec;
      return this;
    }
    const filter = parseObjectFilter(spec);
    // expand_list_objects_filter_spec: a blob limit in bytes
    this.filterSpec = filter.choice === "blob:limit" ? `blob:limit=${filter.limit}` : spec;
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
   * Set the remote name (`-o`/`--origin`).
   *
   * Default `clone.defaultRemoteName` (the `-c` values included), else "origin".
   *
   * @param remoteName Remote name
   */
  setRemote(remoteName: string): this {
    this.checkCallable();
    this.remoteName = remoteName;
    this.remoteExplicit = true;
    return this;
  }

  /**
   * `git clone -c <key>=<value>` (repeatable; `<key>` alone is `true`): each value is added
   * to the new repository's config before anything is fetched (clone.c's `write_config`), so
   * the fetch and the checkout use it: `url.<base>.insteadOf`, `protocol.*`,
   * `fetch.fsckObjects`, `remote.<name>.fetch` (fetched with the clone's own refspec, which
   * is added after it), `core.autocrlf`, `clone.defaultRemoteName`, `clone.rejectShallow`.
   * A key git cannot parse fails the clone before any is written.
   *
   * @example
   * ```ts
   * await git.clone().setURI(url).setConfig(["core.autocrlf=true", "remote.origin.fetch=+refs/pull/*:refs/pull/*"]).call();
   * ```
   */
  setConfig(entries: string[]): this {
    this.checkCallable();
    this.configEntries = [...entries];
    return this;
  }

  /** Adds one `-c <key>=<value>` entry (see {@link setConfig}). */
  addConfig(entry: string): this {
    this.checkCallable();
    this.configEntries.push(entry);
    return this;
  }

  /**
   * `git clone --revision=<rev>` (git 2.49+): fetch the history of one ref or commit id and
   * detach HEAD at its commit (a tag peeled); no ref is written for it, no
   * `remote.<name>.fetch` is configured and no tag is followed. A ref name is looked up as
   * `git fetch` looks up a refspec's source; a commit id must be complete. Refused with
   * `--branch` and `--mirror`, and as an unknown option under 2.43 compatibility.
   */
  setRevision(revision: string): this {
    this.checkCallable();
    this.revision = revision;
    return this;
  }

  /**
   * `git clone --[no-]reject-shallow`: refuse a shallow source (local or not) with git's
   * "source repository is shallow, reject to clone."; unset, `clone.rejectShallow` decides.
   */
  setRejectShallow(reject: boolean): this {
    this.checkCallable();
    this.rejectShallow = reject;
    return this;
  }

  /**
   * `git clone --server-option=<option>` (repeatable): sent to the server with each protocol
   * v2 request; they replace `remote.<name>.serverOption` (git 2.5x), which is used without
   * them. A server speaking v0 fails the clone when options were given here (git's "server
   * options require protocol version 2 or later"); configured ones are then dropped.
   */
  setServerOptions(options: string[]): this {
    this.checkCallable();
    this.serverOptions = [...options];
    return this;
  }

  /** The git version reproduced (default the hook runner's, else 2.56). */
  setCompatibility(compatibility: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = compatibility;
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
  /**
   * `--recurse-submodules[=<pathspec>]` (`--recursive`): `true` is `.` (every submodule), a
   * list the pathspecs given (each written as a `submodule.active` value, sorted, duplicates
   * dropped), `false` none (`--no-recurse-submodules`). After the checkout the submodules
   * are cloned and checked out as `git submodule update --init --require-init --recursive`
   * does (see `SubmoduleUpdateCommand`), its output in {@link CloneResult.submodules}.
   * As in git, submodules are cloned with `GIT_PROTOCOL_FROM_USER=0`: a local URL needs
   * `protocol.file.allow=always`. Credentials and headers reach a submodule's URL only as
   * `SubmoduleUpdateCommand.setCredentials` allows (the clone's own origin).
   */
  /**
   * `--object-storage-format=<format>`: the clone's object storage (git master). `files` is
   * the repository as always and is passed on to the submodules a recursive clone makes; a
   * name git does not know dies as git (`unknown object storage format '<v>'`), and
   * `files://<directory>`, objects outside `objects/`, which we do not read, is refused
   * before anything is fetched (`UnsupportedObjectStorageError`).
   */
  setObjectStorageFormat(format: string): this {
    this.checkCallable();
    this.objectStorageFormat = format;
    return this;
  }

  setRecurseSubmodules(recurse: boolean | string[]): this {
    this.checkCallable();
    this.recurseSubmodules = recurse === true ? ["."] : recurse === false ? [] : [...recurse];
    return this;
  }

  /** `--shallow-submodules`: the submodules are cloned with a depth of 1. */
  setShallowSubmodules(shallow: boolean): this {
    this.checkCallable();
    this.shallowSubmodules = shallow;
    return this;
  }

  /**
   * `--[no-]also-filter-submodules`: the submodules are cloned with this clone's filter
   * ({@link setFilter}); unset, `clone.filterSubmodules` decides. Given true, it needs a
   * filter and {@link setRecurseSubmodules}.
   */
  setAlsoFilterSubmodules(filter: boolean): this {
    this.checkCallable();
    this.alsoFilterSubmodules = filter;
    return this;
  }

  /**
   * `--remote-submodules`: each submodule is checked out at its remote-tracking branch
   * (`submodule update --remote --no-fetch`).
   */
  setRemoteSubmodules(remote: boolean): this {
    this.checkCallable();
    this.remoteSubmodules = remote;
    return this;
  }

  async call(): Promise<CloneResult> {
    this.checkCallable();
    this.setCallable(false);
    try {
      return await this.cloneOnce();
    } catch (error) {
      if (!(error instanceof RemoteObjectFormatSwitch)) throw error;
      return this.cloneReopenedAs(error.format);
    }
  }

  /**
   * Called with the working copy a clone reopened with the remote's object format (see
   * {@link CloneResult.workingCopy}): `Git.clone()` takes it as its own.
   */
  onWorkingCopyReopened(listener: (workingCopy: WorkingCopy) => void): this {
    this.reopenedListener = listener;
    return this;
  }

  private reopenedListener?: (workingCopy: WorkingCopy) => void;

  /**
   * git's clone initializes the new repository with the hash the remote names
   * (`initialize_repository_version` with `transport_get_hash_algo`): the destination, still
   * empty, is switched to `format` and reopened (`LinkedWorktrees.reopenWithObjectFormat`),
   * and the clone runs again into it. What the first attempt wrote before it learned the
   * format (the alternates of `--reference` / `--shared`) is removed once the destination
   * passed the check.
   */
  private async cloneReopenedAs(format: ObjectFormat): Promise<CloneResult> {
    const worktrees = this._workingCopy.worktrees;
    if (!worktrees?.reopenWithObjectFormat) {
      throw new TransportError(
        `fatal: cannot clone a ${format.name} repository into this ${this.objectFormat.name} repository`,
      );
    }
    const place = repositoryPlaceOf(this.workingCopy);
    const files = place?.getFiles?.();
    const gitDir = place?.getGitDir?.();
    // checked first (no refs, no objects of its own): a refused destination keeps its
    // alternates
    const admin = await worktrees.reopenWithObjectFormat(format);
    if (files && gitDir !== undefined) {
      const file = `${gitDir}/objects/info/alternates`;
      if ((await files.stats(file))?.kind === "file") {
        await files.remove(file);
        await admin.history.objects?.alternates?.refresh();
      }
    }
    const workingCopy = worktreeAdminWorkingCopy(admin);
    const next = new CloneCommand(workingCopy);
    const self = this as unknown as Record<string, unknown>;
    const other = next as unknown as Record<string, unknown>;
    for (const key of CLONE_SETTINGS) if (key in self) other[key] = self[key];
    // 2.43's clone ran fetch_bundle_uri in the repository GIT_DEFAULT_HASH had initialized,
    // before transport_get_remote_refs: its bundles were read in that hash (a SHA-1 bundle in a
    // SHA-256 destination is no bundle there); 2.5x reads them in the remote's
    if ((this.compatibility ?? this.hooks.compatibility) === "2.43") {
      other.bundleObjectFormat = this.bundleObjectFormat ?? this.objectFormat;
    }
    next.shareHooksOf(this);
    const result = await next.call();
    this.reopenedListener?.(workingCopy);
    return { ...result, workingCopy };
  }

  private async cloneOnce(): Promise<CloneResult> {
    if (!this.uri) {
      throw new InvalidRemoteError("", "URI must be specified for clone");
    }
    // cmd_clone: the object storage format is checked with the options, before anything
    if (this.objectStorageFormat !== undefined) {
      const unknown = unknownObjectStorageFormat(this.objectStorageFormat, "uri");
      if (unknown) throw new GitApiError(unknown);
      if (objectStorageFormatByUri(this.objectStorageFormat)?.payload !== undefined) {
        throw new UnsupportedObjectStorageError(this.objectStorageFormat);
      }
    }
    // cmd_clone: what --recurse-submodules adds to the -c values (option_config)
    const submoduleConfig: string[] = [];
    if (this.recurseSubmodules.length > 0) {
      const patterns = [...new Set(this.recurseSubmodules)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const pattern of patterns) submoduleConfig.push(`submodule.active=${pattern}`);
      const sticky = RemoteConfigStore.from(this.workingCopy).value(
        "submodule.stickyRecursiveClone",
      );
      if (sticky !== undefined && parseGitBool(sticky) === true) {
        submoduleConfig.push("submodule.recurse=true");
      }
      const required = this.references.some((r) => r.required);
      const optional = this.references.some((r) => !r.required);
      if (required && optional) {
        throw new GitApiError(
          "fatal: clone --recursive is not compatible with both --reference and --reference-if-able",
        );
      }
      if (required || optional) {
        submoduleConfig.push(
          "submodule.alternateLocation=superproject",
          `submodule.alternateErrorStrategy=${required ? "die" : "info"}`,
        );
      }
    }
    if (this.alsoFilterSubmodules === true && this.filterSpec === undefined) {
      throw new GitApiError("fatal: the option '--also-filter-submodules' requires '--filter'");
    }
    if (this.alsoFilterSubmodules === true && this.recurseSubmodules.length === 0) {
      throw new GitApiError(
        "fatal: the option '--also-filter-submodules' requires '--recurse-submodules'",
      );
    }
    const compatibility = this.compatibility ?? this.hooks.compatibility;
    // git 2.43 has no `auto` filter
    if (this.filterSpec === "auto" && compatibility === "2.43") {
      throw new ObjectFilterError("invalid filter-spec 'auto'");
    }
    // parse_options: --revision is unknown to 2.43
    if (this.revision !== undefined && compatibility === "2.43") {
      throw new GitApiError(`error: unknown option \`revision=${this.revision}'`, {
        exitCode: 129,
      });
    }

    if (
      this.bundleUri !== undefined &&
      (this.depth !== undefined ||
        this.shallowSince !== undefined ||
        this.shallowExcludes.length > 0)
    ) {
      throw new GitApiError(
        compatibility === "2.43"
          ? "fatal: --bundle-uri is incompatible with --depth, --shallow-since, and --shallow-exclude"
          : "fatal: options '--bundle-uri' and '--depth/--shallow-since/--shallow-exclude' cannot be used together",
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
    // a repository whose format we cannot open (an `extensions.objectStorage` payload, which
    // git master clones non-locally) is refused with that format, never "does not exist"
    let formatRefusal: Error | undefined;
    const isRepositoryPath = await worktree
      ?.openRepository?.(uri, { checkOwnership: false, commandLineConfig: false })
      .then((opened) => opened !== undefined)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "UnsupportedRepositoryFormatError") {
          formatRefusal = error;
        }
        return false;
      });
    if (formatRefusal) throw new TransportError(`fatal: ${formatRefusal.message}`);
    // get_repo_path: then a regular file, `<path>.bundle` first (a bundle: the transport reads
    // it there, remote.<name>.url keeps the path as given)
    let bundleFile: string | undefined;
    const givenBundle = this.hasGivenBundle(uri);
    if (givenBundle) {
      // a bundle given as bytes (addBundle): its URL as given
      bundleFile = uri;
    } else if (!isRepositoryPath) {
      for (const suffix of [".bundle", ""]) {
        const bytes = await worktree?.readLocalFile?.(`${uri}${suffix}`).catch(() => undefined);
        if (bytes) {
          bundleFile = absolutePathOf(worktree, `${uri}${suffix}`);
          break;
        }
      }
    }
    let repo: string;
    if (givenBundle) repo = uri;
    else if (isRepositoryPath || bundleFile !== undefined) repo = absolutePathOf(worktree, uri);
    else if (uri.includes(":")) repo = uri;
    else throw new TransportError(`fatal: repository '${uri}' does not exist`);
    // clone.c: a destination that exists and is not empty is refused before anything is
    // written; here the destination is the working copy, empty once `git init` made it
    await this.refuseNonEmptyDestination();
    // write_config: the -c values, after init_db and before anything reads the config (the
    // remote's name, url.*.insteadOf, protocol.*, the fetch and the checkout)
    await this.writeCommandLineConfig(submoduleConfig);
    const store = RemoteConfigStore.from(this.workingCopy);
    // git_clone_config re-read: clone.defaultRemoteName, then --origin over it
    if (!this.remoteExplicit) this.remoteName = store.value("clone.defaultRemoteName") ?? "origin";
    if (!isValidRemoteName(this.remoteName)) {
      throw new InvalidArgumentError(
        "remote",
        this.remoteName,
        `'${this.remoteName}' is not a valid remote name`,
      );
    }
    const rejectShallowConfig = store.value("clone.rejectShallow");
    const rejectShallow =
      this.rejectShallow ??
      (rejectShallowConfig === undefined ? false : (parseGitBool(rejectShallowConfig) ?? false));
    if (this.revision !== undefined) {
      if (this.branch !== undefined) {
        throw new GitApiError("fatal: options '--revision' and '--branch' cannot be used together");
      }
      if (this.mirror) {
        throw new GitApiError("fatal: options '--revision' and '--mirror' cannot be used together");
      }
      if (!isRevisionRefspec(this.revision)) {
        throw new GitApiError(`fatal: invalid refspec '${this.revision}'`);
      }
    }
    // transport.c's handshake: --server-option, else remote.<name>.serverOption (2.5x), an
    // empty value clearing the list
    let serverOptions = this.serverOptions;
    if (serverOptions.length === 0 && compatibility !== "2.43") {
      serverOptions = [];
      for (const value of store.values(`remote.${this.remoteName}.serverOption`)) {
        if (value === "") serverOptions.length = 0;
        else serverOptions.push(value);
      }
    }

    this.repoUrl = repo;
    // clone.c writes remote.<name>.url (and tagOpt) before it asks for the refs: what the
    // server's promisor-remote capability makes the fetch write (an auto-created remote)
    // comes after that section
    store.setValue(`remote.${this.remoteName}.url`, repo);
    if (this.tagOption === TagOption.NO_TAGS || this.mirror) {
      store.setValue(`remote.${this.remoteName}.tagOpt`, "--no-tags");
    }
    await store.save();
    const sourceUrl = store.aliasUrl(repo) ?? repo;
    const remote = await this.prepareRemote(bundleFile ?? sourceUrl);
    if (remote.kind === "bundle" && remote.remote.bundle.header.filter !== undefined) {
      throw new TransportError("fatal: cannot clone from filtered bundle");
    }
    const localRemote: OpenedRepository | undefined =
      remote.kind === "local" ? remote.repository : undefined;
    if (localRemote) await this.refuseSourceAsDestination(localRemote);

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
      if (this.filterSpec !== undefined) {
        localWarnings.push("warning: --filter is ignored in local clones; use file:// instead.\n");
      }
      if (await sourceIsShallow(localRemote, worktree?.getFiles?.())) {
        if (rejectShallow) {
          throw new TransportError("fatal: source repository is shallow, reject to clone.");
        }
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
      this.revision === undefined &&
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
    // --revision: the revision alone, as a refspec without destination (no ref written)
    let revisionRef: { name: string; oid: string } | undefined;
    if (this.revision !== undefined) {
      const rev = this.revision;
      refspecs = {
        prefixes: FULL_HEX_ID.test(rev) ? [] : refPrefixes([rev]),
        resolve: (remoteRefs) => {
          const found = mapRefs(remoteRefs, [rev])[0];
          if (!found) {
            throw new RefNotFoundError(
              rev,
              `fatal: Remote revision ${rev} not found in upstream ${this.remoteName}`,
            );
          }
          revisionRef = { name: found.remoteRef, oid: found.oid };
          return [rev];
        },
      };
    }
    // remote_get_early: the configured remote.<name>.fetch refspecs (the -c values and the
    // command line's included) come first; a single-branch clone maps them over its one ref
    const configuredFetch = store.values(`remote.${this.remoteName}.fetch`);
    if (configuredFetch.length > 0) {
      const selected =
        singleBranch && !this.mirror
          ? (remoteRefs: readonly RemoteRef[]) => {
              if (branchToClone !== undefined) {
                return (
                  remoteRefs.find((r) => r.name === `refs/heads/${branchToClone}` && r.oid) ??
                  remoteRefs.find((r) => r.name === `refs/tags/${branchToClone}` && r.oid)
                );
              }
              const head = remoteRefs.find((r) => r.name === "HEAD")?.symref;
              return head ? remoteRefs.find((r) => r.name === head && r.oid) : undefined;
            }
          : undefined;
      // (tags: "all" below maps git's TAG_REFSPEC after them)
      const allTags =
        this.revision === undefined &&
        this.tagOption === TagOption.AUTO_FOLLOW &&
        !singleBranch &&
        !this.mirror;
      refspecs = withConfiguredRefspecs(refspecs, configuredFetch, selected, allTags);
    }
    // git clone takes every tag, unless one branch is cloned (then tags follow) or --no-tags;
    // none with --revision
    const tags =
      this.revision !== undefined
        ? "none"
        : this.tagOption === TagOption.AUTO_FOLLOW && !singleBranch && !this.mirror
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

    const sessionId = clientSessionIdOf(this.workingCopy);
    // a new git process: no promisor remote accepted yet (--filter=auto, lazy-fetch order)
    resetPromisorAcceptance(this.workingCopy);
    const fetchOptions: TransportFetchOptions = {
      ...(sessionId !== undefined ? { sessionId } : {}),
      // fetch.uriProtocols: the packs a v2 server offloads to packfile URIs
      ...uriProtocolsOption(RemoteConfigStore.from(this.workingCopy).value("fetch.uriprotocols")),
      url: sourceUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      gzipRequests: this.gzipRequests,
      repository: createRepositoryFacade({ history: historyWithoutLazyFetch(history) }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      // clone maps what wanted_peer_refs finds: its own refspecs never die on a source the
      // remote lacks (an unborn HEAD's branch); the configured ones are checked above
      missingRefsOk: true,
      tags,
      depth,
      deepenSince: shallowSince,
      deepenNot: shallowExcludes.length > 0 ? shallowExcludes : undefined,
      onProgress: this.progressMessageCallback,
      // index-pack's "Receiving objects" and "Resolving deltas"
      ...(this.progress ? { progress: this.progress } : {}),
      // git's write_remote_refs: one initial transaction (packed-refs), no reflog; the
      // followed tags of a single-branch clone each on their own (write_followtags)
      skipReflog: true,
      initialTransaction: true,
      // fetch-pack's args->cloning: a shallow source's shallow commits are recorded
      cloning: true,
      // clone.c sets TRANS_OPT_KEEP: the pack is kept whatever its size
      keepPack: true,
      // --filter (TRANS_OPT_LIST_OBJECTS_FILTER, TRANS_OPT_FROM_PROMISOR); not in a local clone
      ...(this.filterSpec !== undefined && !isLocal ? { filter: this.filterSpec } : {}),
      // the transport's warnings (a filter the server ignores, the dumb walker's alternates)
      onWarning: (line: string) => messages.push(`${line}\n`),
      // the server's promisor-remote capability (promisor.acceptFromServer, storeFields)
      promisorRemote: promisorRemoteReplyOf(this.workingCopy, (line) => messages.push(`${line}\n`)),
      // --filter=auto: the accepted promisor remotes' advertised filter
      autoFilter: () => promisorAutoFilter(this.workingCopy, (line) => messages.push(`${line}\n`)),
      ...(fsck ? { fsckObjects: fsck } : {}),
      ...(serverOptions.length > 0 ? { serverOptions } : {}),
      ...(rejectShallow ? { rejectShallow: true } : {}),
      // git's clone takes the remote's hash: a destination of another one is reopened with it
      // before anything is fetched (cloneReopenedAs)
      onRemoteObjectFormat: (format) => {
        if (format.name !== this.objectFormat.name) throw new RemoteObjectFormatSwitch(format);
      },
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
    // fetch_if_missing = 0 while the fetch runs: its walks read through the history's view
    // without lazy fetch (the facade above)
    const result = await withRemoteUploadPack(remote, sessionOptions, (connection) => {
      // transport.c's die_if_server_options: command-line options need v2
      if (connection.version !== 2 && this.serverOptions.length > 0) {
        throw new TransportError(
          "hint: see protocol.version in 'git help config' for more details\n" +
            "fatal: server options require protocol version 2 or later",
        );
      }
      // the bundles come after the ref listing and before anything is fetched (or a local
      // clone's objects copied)
      const copy = fetchOptions.beforeFetch;
      return fetchFromConnection(connection, {
        ...fetchOptions,
        beforeFetch: async (remoteRefs, refMap) => {
          await this.cloneBundles(connection, sourceUrl, compatibility, messages);
          return copy?.(remoteRefs, refMap);
        },
      });
    }).catch((error: unknown) => {
      if (error instanceof ShallowRemoteRejectedError) {
        throw new TransportError(`fatal: ${error.message}`);
      }
      if (error instanceof BundlePrerequisitesError) {
        throw new TransportError(`${error.lines}fatal: remote transport reported error`);
      }
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
    // guess_remote_head: without HEAD's symref (a bundle, a dumb server), the branch at HEAD's
    // commit among the refs cloned: init.defaultBranch's (else master), then master, then the
    // first in the remote's order
    let advertisedDefaultBranch = result.defaultBranch;
    const remoteHeadRef = result.remoteRefs.find((r) => r.name === "HEAD");
    if (advertisedDefaultBranch === undefined && remoteHeadRef?.oid !== undefined) {
      const cloned = new Set(result.fetched.map((f) => f.remoteRef));
      const branches = result.remoteRefs.filter(
        (r) =>
          r.name.startsWith("refs/heads/") && cloned.has(r.name) && r.oid === remoteHeadRef.oid,
      );
      const preferred = (await this.defaultInitialBranch()).name;
      advertisedDefaultBranch = (
        branches.find((r) => r.name === `refs/heads/${preferred}`) ??
        branches.find((r) => r.name === "refs/heads/master") ??
        branches[0]
      )?.name;
    }
    let defaultBranch = branchToClone ?? toBranchName(advertisedDefaultBranch);
    // the remote HEAD names a branch it does not have (ls-refs' `unborn`)
    const unbornHead =
      remoteHeadRef !== undefined &&
      remoteHeadRef.oid === undefined &&
      remoteHeadRef.symref !== undefined;
    let headCommit: ObjectId | undefined;
    let checkedOutBranch: string | undefined;
    // the commit to check out once refs and configuration are in place (git: last)
    let checkoutId: ObjectId | undefined;
    // an empty remote without unborn HEAD: git's default branch (the one init named)
    if (!detachedTag && !this.bare && defaultBranch === undefined && result.isEmpty) {
      defaultBranch = (await this.localHeadBranch()) ?? (await this.defaultInitialBranch()).name;
    }

    // git's update_remote_refs (before update_head): refs/remotes/<name>/HEAD names the tracking ref of the
    // remote's default branch, when the clone took that branch
    const remoteHead =
      this.revision === undefined && advertisedDefaultBranch?.startsWith("refs/heads/")
        ? toBranchName(advertisedDefaultBranch)
        : undefined;
    // (guess_remote_head over the mapped refs: the first mapping of the remote HEAD's branch,
    // configured refspecs before the clone's own, whose peer ref HEAD then names)
    const headMapping = remoteHead
      ? result.fetched.find((f) => f.remoteRef === advertisedDefaultBranch)
      : undefined;
    if (!this.bare && remoteHead && headMapping?.localRef) {
      const target = headMapping.localRef;
      if ((await this.refsStore.resolve(target))?.objectId) {
        await this.refsStore.setSymbolic(`refs/remotes/${this.remoteName}/HEAD`, target, cloneLog);
      }
    }

    if (revisionRef) {
      // update_head with opts->detach: HEAD detached at the revision's commit (a tag peeled,
      // lookup_commit_or_die), bare or not
      defaultBranch = toBranchName(advertisedDefaultBranch);
      const id = await this.revisionCommit(revisionRef, messages);
      await this.refsStore.set("HEAD", id, cloneLog);
      headCommit = id;
      if (!this.bare && !this.noCheckout) checkoutId = id;
    } else if (detachedTag) {
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
    } else if (
      defaultBranch === undefined &&
      remoteHeadRef?.oid !== undefined &&
      !result.isEmpty &&
      (await history.commits.has(remoteHeadRef.oid).catch(() => false))
    ) {
      // update_head's `else if (remote)`: a remote HEAD no branch matches (a bundle made from
      // `HEAD topic`) detaches HEAD at its commit
      await this.refsStore.set("HEAD", remoteHeadRef.oid, cloneLog);
      headCommit = remoteHeadRef.oid;
      if (!this.bare && !this.noCheckout) checkoutId = remoteHeadRef.oid;
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
      // git's install_branch_config: the branch tracks its remote counterpart, also when the
      // remote's HEAD is unborn (v2's unborn_head_target), refs or not
      if (tip?.objectId || result.isEmpty || unbornHead) checkedOutBranch = defaultBranch;
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
      // a single-branch clone of an unborn HEAD maps no ref (wanted_peer_refs): git's empty
      // clone, without a fetch refspec
      isEmpty: result.isEmpty || (singleBranch && unbornHead && branchToClone === undefined),
      revision: this.revision !== undefined,
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
      // as the empty-remote case above: the local HEAD's branch, else git's default
      defaultBranch:
        defaultBranch ?? (await this.localHeadBranch()) ?? (await this.defaultInitialBranch()).name,
      remoteName: this.remoteName,
      bare: this.bare,
      headCommit,
      ...(messages.length > 0 ? { messages } : {}),
    };

    // clone.c's checkout(): a HEAD that names no commit (a remote without HEAD, such as a
    // bundle without one) leaves nothing to check out
    if (
      checkoutId === undefined &&
      !this.bare &&
      !this.noCheckout &&
      !result.isEmpty &&
      headCommit === undefined
    ) {
      messages.push("warning: remote HEAD refers to nonexistent ref, unable to checkout\n");
      if (cloneResult.messages === undefined) cloneResult.messages = messages;
    }

    // dissociate_from_references: before the checkout, the borrowed objects copied in
    // (a store without alternates has nothing to dissociate from)
    if (this.dissociate) await history.objects?.alternates?.dissociate?.();

    if (checkoutId) {
      // what the checkout's lazy fetches print (git's child `git fetch` shares its stderr)
      const promisorWarnings = promisorOf(this._workingCopy)?.warnings;
      const warned = promisorWarnings?.length ?? 0;
      try {
        const collided = await this.checkoutHead(checkoutId);
        if (collided.length > 0) cloneResult.collidedPaths = collided;
      } catch (error) {
        throw new CloneCheckoutError(cloneResult, error);
      } finally {
        const lines = promisorWarnings?.slice(warned) ?? [];
        if (lines.length > 0) {
          messages.push(...lines.map((line) => `${line}\n`));
          if (cloneResult.messages === undefined) cloneResult.messages = messages;
        }
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
      // checkout(): the submodules, once the hook succeeded
      else if (this.recurseSubmodules.length > 0) {
        cloneResult.submodules = await this.updateSubmodules();
      }
    }
    return cloneResult;
  }

  /**
   * clone.c's `git submodule update --require-init --recursive [--depth=1] [--remote
   * --no-fetch] [--filter=<spec>] [--[no-]single-branch]` in the new repository: what it
   * printed and its exit status.
   */
  /**
   * clone.c's bundle step: `--bundle-uri` (`fetch_bundle_uri`, `fetch.bundleURI` stored for a
   * `creationToken` list), else, under `transfer.bundleURI`, the server's list
   * (`transport_get_remote_bundle_uri`, `fetch_bundle_list`); warnings into `messages`.
   */
  private async cloneBundles(
    connection: UploadPackConnection,
    remoteUrl: string,
    compatibility: "2.43" | "2.56",
    messages: string[],
  ): Promise<void> {
    const store = RemoteConfigStore.from(this.workingCopy);
    const message = (line: string) => messages.push(`${line}\n`);
    const worktree = repositoryPlaceOf(this.workingCopy);
    const host = this.bundleUriHost({
      remoteUrl,
      compatibility,
      message,
      ...(this.bundleUri !== undefined && this.bundleObjectFormat
        ? { objectFormat: this.bundleObjectFormat }
        : {}),
      setConfigValue: (key, value) => this.writeConfigValue(key, value, "add"),
      // odb_mkstemp's `<objects>/bundles/tmp_uri_XXXXXX`, as git's errors name the list
      tempFileName: () =>
        absolutePathOf(
          worktree,
          `${this.bare ? "" : ".git/"}objects/bundles/tmp_uri_${randomSuffix()}`,
        ),
    });
    if (this.bundleUri !== undefined) {
      const fetched = await fetchBundleUri(host, this.bundleUri);
      if (!fetched.ok) {
        message(`warning: failed to fetch objects from bundle URI '${this.bundleUri}'`);
      } else if (fetched.hasHeuristic) {
        await this.writeConfigValue("fetch.bundleuri", this.bundleUri, "add");
      }
      return;
    }
    // transport_get_remote_bundle_uri: only under transfer.bundleURI, only from a v2 server
    // advertising `bundle-uri`
    const enabled = store.value("transfer.bundleURI");
    if (enabled === undefined || parseGitBool(enabled) !== true) return;
    if (connection.version !== 2 || !connection.capabilities.has("bundle-uri")) return;
    const list = new BundleList(remoteUrl);
    const lines = await bundleUriLines(connection);
    // get_remote_bundle_uri: the first bad line is reported (its number counted from 2), the
    // rest read but not parsed
    let failed = false;
    lines.forEach((line, index) => {
      if (failed) return;
      const parseMessages: string[] = [];
      const error = parseBundleListLine(list, line, parseMessages);
      for (const m of parseMessages) message(m);
      if (error === undefined) return;
      if (error) message(error);
      message(`error: error on bundle-uri response line ${index + 2}: ${line}`);
      failed = true;
    });
    if (failed) message("error: could not retrieve server-advertised bundle-uri list");
    if (list.size === 0) return;
    if (!(await fetchBundleList(host, list))) {
      message("warning: failed to fetch advertised bundles");
    }
  }

  private async updateSubmodules(): Promise<SubmoduleCommandResult> {
    const store = RemoteConfigStore.from(this.workingCopy);
    const configured = store.value("clone.filterSubmodules");
    const filterSubmodules =
      this.alsoFilterSubmodules ??
      (configured === undefined ? false : (parseGitBool(configured) ?? false));
    const update = new SubmoduleUpdateCommand(this.workingCopy)
      .setRequireInit(true)
      .setRecursive(true)
      .setCompatibility(this.compatibility ?? this.hooks.compatibility);
    update.shareHooksOf(this);
    if (this.shallowSubmodules) update.setDepth(1);
    if (this.remoteSubmodules) update.setRemote(true).setNoFetch(true);
    if (filterSubmodules && this.filterSpec !== undefined) update.setFilter(this.filterSpec);
    // object_storage_format_to_name: the name alone (`files`), never a payload
    if (this.objectStorageFormat !== undefined) update.setObjectStorageFormat("files");
    // option_single_branch, settled before (a deepening clone is a single-branch one, a
    // --revision clone none): always passed on, as --single-branch or --no-single-branch
    update.setSingleBranch(
      this.revision !== undefined
        ? false
        : (this.singleBranch ??
            (this.depth !== undefined ||
              this.shallowSince !== undefined ||
              this.shallowExcludes.length > 0)),
    );
    update.setTransports(this.getTransports());
    if (this.credentials) update.setCredentials(this.credentials);
    if (this.headers) update.setHeaders(this.headers);
    if (this.timeout !== undefined) update.setTimeout(this.timeout);
    if (this.credentialHelper) update.setCredentialHelper(this.credentialHelper);
    if (this.warningCallback) update.setWarningCallback(this.warningCallback);
    try {
      return await update.call();
    } catch (error) {
      if (!(error instanceof SubmoduleCommandError)) throw error;
      return {
        stdout: error.result.stdout,
        stderr: `${error.result.stderr}${error.message}\n`,
        exitCode: error.exitCode,
      };
    }
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

  /** git's `die_upon_dubious_ownership(NULL, NULL, src_repo)` before a local clone copies. */
  private async refuseDubiousSource(source: OpenedRepository, path: string): Promise<void> {
    try {
      await source.checkOwnership?.({ gitDirOnly: true, path });
    } catch (error) {
      if (error instanceof Error && error.name === "DubiousOwnershipError") {
        throw new TransportError(error.message);
      }
      throw error;
    }
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
      // clone.c's copy_or_link_directory: a source another user owns is refused (2.45.1+,
      // CVE-2024-32004), unless safe.directory lists it
      await this.refuseDubiousSource(source, sourceGitDirPath(files, source, repo));
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
  /** git's "destination path ... already exists and is not an empty directory." */
  private destinationRefused(): CloneDestinationError {
    const root = repositoryPlaceOf(this._workingCopy)?.getRoot?.() ?? "";
    const name = this.directory ?? (root.replace(/\/+$/, "").split("/").pop() || ".");
    return new CloneDestinationError(
      `fatal: destination path '${name}' already exists and is not an empty directory.`,
    );
  }

  private async refuseNonEmptyDestination(): Promise<void> {
    const refuse = () => this.destinationRefused();
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
    }
  }

  /** A local source that is the destination itself is refused as a non-empty destination. */
  private async refuseSourceAsDestination(source: OpenedRepository): Promise<void> {
    const worktree = this.bare ? undefined : this.worktreeAccess;
    if (!worktree) return;
    const self = await worktree
      .openRepository?.(".", { checkOwnership: false })
      .catch(() => undefined);
    if (self && (self.commonDir ?? self.gitDir) === (source.commonDir ?? source.gitDir)) {
      throw this.destinationRefused();
    }
  }

  /**
   * clone.c's `write_config`: each `-c` entry parsed as `git_config_parse_parameter` (split at
   * the first `=`, no `=` meaning `true`), its key canonical (`git_config_parse_key`), then
   * added to the new repository's config file (`CONFIG_REGEX_NONE`), saved before the fetch.
   * Every entry is checked before the first is written.
   */
  private async writeCommandLineConfig(extra: string[] = []): Promise<void> {
    const entries = [...this.configEntries, ...extra];
    if (entries.length === 0) return;
    const parsed: { key: string; value: string }[] = [];
    for (const entry of entries) {
      const eq = entry.indexOf("=");
      const rawKey = eq < 0 ? entry : entry.slice(0, eq);
      const die = (error: string) =>
        new GitApiError(`error: ${error}\nfatal: unable to write parameters to config file`);
      if (rawKey === "") throw die(`bogus config parameter: ${entry}`);
      const key = parseConfigKey(rawKey);
      if ("error" in key) throw die(key.error);
      parsed.push({ key: key.key, value: eq < 0 ? "true" : entry.slice(eq + 1) });
    }
    for (const { key, value } of parsed) await this.writeConfigValue(key, value, "add");
  }

  /**
   * One config write as git's config writer places it (`repo_config_set_multivar`): through
   * `git config` (`ConfigCommand`) where the config is a file, so a value added to an existing
   * section goes at its end; pending edits are saved first and the config is read again
   * after. `add` is `CONFIG_REGEX_NONE`; `set-empty` replaces an empty value, else adds (the
   * `^$` pattern of `write_refspec_config`).
   */
  private async writeConfigValue(
    key: string,
    value: string,
    mode: "add" | "set-empty",
  ): Promise<void> {
    const store = RemoteConfigStore.from(this.workingCopy);
    const config = this.workingCopy.config;
    if (!(config instanceof GitWorkingCopyConfig)) {
      const values = store.localValues(key);
      const empty = values.indexOf("");
      if (mode === "set-empty" && empty >= 0) {
        store.setValues(
          key,
          values.map((v, i) => (i === empty ? value : (v ?? "true"))),
        );
      } else store.addValue(key, value);
      await store.save();
      return;
    }
    // config.c's writer over the file's text (as `git config` edits it), then read again
    await store.save();
    const files = config.configFiles;
    const path = config.filePath;
    const bytes = await files.read(path);
    const written = setConfigMultivarText(
      bytes === undefined ? undefined : new TextDecoder().decode(bytes),
      path,
      key,
      value,
      { valuePattern: mode === "add" ? CONFIG_REGEX_NONE : "^$" },
    );
    if (written.status !== 0 || written.text === undefined) {
      throw new GitApiError(written.stderr.join("\n") || `fatal: could not write ${key}`);
    }
    await files.write(path, new TextEncoder().encode(written.text));
    await config.load();
  }

  /**
   * `--revision`'s commit: the fetched object, tags peeled (lookup_commit_or_die, its
   * "is not a commit!" warning added to `messages`); anything else dies as git
   * ("object <id> is a tree, not a commit", "could not parse <name>").
   */
  private async revisionCommit(
    revision: { name: string; oid: string },
    messages: string[],
  ): Promise<ObjectId> {
    const tags = this.tagsStore ?? this._workingCopy.history.tags;
    let id = revision.oid;
    for (let i = 0; i < 16; i++) {
      if (!(await tags.has(id))) break;
      const target = await tags.getTarget(id);
      if (!target) break;
      id = target;
    }
    if (!(await this.commits.load(id).catch(() => undefined))) {
      const type = (await this.trees.has(id).catch(() => false))
        ? "tree"
        : (await this.blobs.has(id).catch(() => false))
          ? "blob"
          : undefined;
      throw new GitApiError(
        `${type ? `error: object ${id} is a ${type}, not a commit\n` : ""}fatal: could not parse ${revision.name}`,
      );
    }
    if (id !== revision.oid) {
      messages.push(`warning: ${revision.name} ${revision.oid} is not a commit!\n`);
    }
    return id;
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
    /** --revision: no fetch refspec (write_refspec_config is skipped) */
    revision?: boolean;
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
    } else if (!this.bare && !clone.revision) {
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
      // repo_config_set_multivar(key, value, "^$", 0): at the end of the section, after the
      // values -c wrote, or in place of an empty one
      await this.writeConfigValue(`${remote}.fetch`, fetchRefspec, "set-empty");
      if (this.mirror) store.setValue(`${remote}.mirror`, "true");
    }
    if (this.filterSpec !== undefined) {
      // partial_clone_register: the repository format upgraded to 1 (no extension: git 2.29+
      // records the promisor remote only), the remote marked as promisor with its filter
      const version = parseGitInt(store.value("core.repositoryformatversion") ?? "0") ?? 0;
      if (version < 1) store.setValue("core.repositoryformatversion", "1");
      store.setValue(`${remote}.promisor`, "true");
      store.setValue(`${remote}.partialclonefilter`, this.filterSpec);
    }
    // git 2.43 initialized the sparse checkout before update_head's branch config
    if (
      this.sparse &&
      !this.sparseInitialized &&
      clone.worktree &&
      (this.compatibility ?? this.hooks.compatibility) === "2.43"
    ) {
      await store.save();
      await this.initSparseCheckout();
    }
    if (!this.bare && clone.checkedOutBranch) {
      store.setValue(`branch.${clone.checkedOutBranch}.remote`, this.remoteName);
      store.setValue(
        `branch.${clone.checkedOutBranch}.merge`,
        `refs/heads/${clone.checkedOutBranch}`,
      );
    }
    await store.save();
    // the promisor remote just recorded (partial_clone_register's reinit)
    if (this.filterSpec !== undefined) promisorOf(this._workingCopy)?.fetcher?.invalidate?.();
  }

  /**
   * git's `repo_default_branch_name` in the new repository: its whole configuration
   * (`includeIf "gitdir:"` matching its git directory), as the working copy's config reads it
   * when that is the user's chain (it has the environment); else the protected configuration.
   */
  private defaultInitialBranch(): Promise<DefaultBranch> {
    const config = this._workingCopy.config as Partial<NewRepositoryConfig> | undefined;
    const environment = hostEnvironmentOf(this._workingCopy);
    return defaultInitialBranch(
      environment,
      environment && config?.listWithOrigin ? (config as NewRepositoryConfig) : undefined,
    );
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
            if (!this.sparseInitialized) await this.initSparseCheckout();
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
        pathRules: worktreePathRules(this.workingCopy, worktree),
        ...(sparse ? { writes: (path: string) => sparse.writes(path) } : {}),
        ...(this.progress ? { progress: this.progress } : {}),
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

  /** `git sparse-checkout set` in the new repository (git_sparse_checkout_init), once. */
  private async initSparseCheckout(): Promise<void> {
    this.sparseInitialized = true;
    await new SparseCheckoutCommand(this.workingCopy).setArguments(["set"]).call();
  }

  private sparseInitialized = false;

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
/** A complete object id (SHA-1 or SHA-256), as a refspec source names one. */
const FULL_HEX_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Whether `--revision`'s value parses as a fetch refspec's source (refspec.c: a complete
 * object id, or a ref name allowed one level, `HEAD` included): `refs/heads/main^` does not.
 */
function isRevisionRefspec(revision: string): boolean {
  return FULL_HEX_ID.test(revision) || isValidRefName(revision, { allowOneLevel: true });
}

/**
 * The clone's refspecs after the configured `remote.<name>.fetch` ones (remote_get_early,
 * then the clone's own appended): every remote ref is mapped through them, or, for a
 * single-branch clone (`selected`), only the one ref it clones (wanted_peer_refs narrows the
 * list before mapping).
 */
function withConfiguredRefspecs(
  own: string[] | RefspecResolver,
  configured: string[],
  selected: ((remoteRefs: readonly RemoteRef[]) => RemoteRef | undefined) | undefined,
  allTags: boolean,
): RefspecResolver {
  return {
    prefixes: [
      ...refPrefixes(configured),
      ...(Array.isArray(own) ? refPrefixes(own) : own.prefixes),
    ],
    resolve: (remoteRefs) => {
      const ownSpecs = Array.isArray(own) ? own : own.resolve(remoteRefs);
      // get_fetch_map with missing_ok 0: an exact source the (narrowed) list lacks dies
      const ref = selected?.(remoteRefs);
      const mappedOver = selected ? (ref ? [ref] : []) : remoteRefs;
      const listsRefs = remoteRefs.some((r) => r.oid);
      const missing = listsRefs ? missingSources(mappedOver, configured) : [];
      if (missing.length > 0) {
        throw new TransportError(`fatal: couldn't find remote ref ${missing[0]}`);
      }
      const mapped = selected
        ? mapRefs(mappedOver, configured)
            .filter((p) => p.localRef !== undefined)
            .map((p) => `${p.force ? "+" : ""}${p.remoteRef}:${p.localRef}`)
        : configured;
      const specs = [...mapped, ...ownSpecs];
      // write_remote_refs' one transaction refuses a ref two mappings write (wanted_peer_refs
      // removes no duplicate): ref_transaction's "multiple updates", the first name in order
      const counts = new Map<string, number>();
      for (const spec of allTags ? [...specs, "refs/tags/*:refs/tags/*"] : specs) {
        for (const p of mapRefs(remoteRefs, [spec])) {
          if (p.localRef !== undefined) counts.set(p.localRef, (counts.get(p.localRef) ?? 0) + 1);
        }
      }
      const twice = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
      if (twice.length > 0) {
        twice.sort(compareRefNames);
        throw new TransportError(`fatal: multiple updates for ref '${twice[0]}' not allowed`);
      }
      return specs;
    },
  };
}

/**
 * clone.c's `absolute_pathdup` of a local source: an absolute path as given, a relative one
 * after the directory clone runs in (the worktree top, as the host sees it when the storage
 * has a root directory), without resolving `..` (git writes `/top/../src`).
 */
/** mkstemp's six random characters. */
function randomSuffix(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

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
