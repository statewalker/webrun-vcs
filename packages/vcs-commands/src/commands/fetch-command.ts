import type { ObjectId } from "@statewalker/vcs-core";
// Import from the package root only: vcs-core ships a single runtime file
// (dist/index.js); its subpaths resolve for types but not at runtime.
import { type FilesApi, isSymbolicRef } from "@statewalker/vcs-core";
import { writeCommitGraph } from "@statewalker/vcs-store-files";
import {
  createRepositoryFacade,
  createTransportRefStore,
  expandFromDestination,
  type FetchClientResult,
  type FetchHeadEntry,
  type FetchRefUpdate,
  formatFetchHead,
  matchDestination,
  matchSource,
  parseRefSpec,
  type RefSpec,
  type TagMode,
  fetch as transportFetch,
} from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import { InvalidArgumentError, InvalidRemoteError } from "../errors/index.js";
import { deleteRefs, RemoteConfigStore } from "../remote-config/index.js";
import {
  type FetchResult,
  RefUpdateStatus,
  type TrackingRefUpdate,
} from "../results/fetch-result.js";
import { TransportCommand } from "../transport-command.js";
import { hostEnvironmentOf } from "./git-ident.js";

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
  /** Whether the remote was named (it is then in the reflog action, as on git's command line). */
  private remoteGiven = false;
  private refSpecs: string[] = [];
  private removeDeletedRefs?: boolean;
  private pruneTags?: boolean;
  private refmap?: string[];
  private tagOption: TagOption = TagOption.AUTO_FOLLOW;
  private tagOptionSet = false;
  private writeFetchHead = true;
  private appendFetchHead = false;
  private thin = true;
  private depth?: number;
  private dryRun = false;
  private writeCommitGraphOption?: boolean;
  private repositoryFiles?: { files: FilesApi; gitDir?: string };
  private forceUpdate = false;
  private atomic = false;
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
    this.remoteGiven = true;
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
   * Equivalent to `git fetch --prune` (true) and `--no-prune` (false). Unset, the
   * remote's `remote.<name>.prune`, else `fetch.prune`, decides, as in git; neither set,
   * nothing is pruned. The remote-tracking refs the refspecs map from a ref the remote no
   * longer has are deleted before anything is fetched (so `foo` can become `foo/bar`); the
   * command-line refspecs are used when given, else the configured ones.
   *
   * @param remove Whether to prune deleted refs
   */
  setRemoveDeletedRefs(remove: boolean): this {
    this.checkCallable();
    this.removeDeletedRefs = remove;
    return this;
  }

  /**
   * Whether to remove deleted refs, as set with {@link setRemoveDeletedRefs} (false when
   * unset: the configuration is read when the fetch runs).
   */
  isRemoveDeletedRefs(): boolean {
    return this.removeDeletedRefs ?? false;
  }

  /**
   * Set whether local tags the remote no longer has are pruned too (`git fetch
   * --prune-tags` / `--no-prune-tags`). Unset, `remote.<name>.pruneTags`, else
   * `fetch.pruneTags`, decides.
   *
   * As in git, this adds `refs/tags/*:refs/tags/*` to the refspecs (so every remote tag is
   * fetched), and only when no refspec is given: to the remote's configured refspecs, or for
   * a URL to the refspecs of the fetch. Tags are pruned only when pruning is on.
   */
  setPruneTags(pruneTags: boolean): this {
    this.checkCallable();
    this.pruneTags = pruneTags;
    return this;
  }

  /**
   * Set the refspecs that map the refs named on the command line to remote-tracking refs
   * (`git fetch --refmap=<refspec>`), in place of the remote's `remote.<name>.fetch`.
   *
   * With explicit refspecs ({@link setRefSpecs}), git also updates the remote-tracking
   * ref each fetched ref maps to through the configured refspecs (`git fetch origin main`
   * moves `refs/remotes/origin/main`); a refmap replaces those, and an empty one
   * (`setRefmap()`, git's `--refmap=`) turns the update off. Without explicit refspecs a
   * refmap is an error, as in git.
   */
  setRefmap(...refspecs: string[]): this {
    this.checkCallable();
    this.refmap = refspecs;
    return this;
  }

  /**
   * Set how tags are fetched (`--tags`, `--no-tags`, or auto-follow).
   *
   * Unset, a configured remote's `remote.<name>.tagOpt` (`--tags`, `--no-tags`) decides, as
   * in git; otherwise tags are auto-followed.
   */
  setTagOpt(option: TagOption): this {
    this.checkCallable();
    this.tagOption = option;
    this.tagOptionSet = true;
    return this;
  }

  /**
   * Set whether the fetch writes `FETCH_HEAD` (default true; `--no-write-fetch-head`).
   *
   * Written through the checkout's `writeFetchHead`; a checkout without it keeps none.
   */
  setWriteFetchHead(write: boolean): this {
    this.checkCallable();
    this.writeFetchHead = write;
    return this;
  }

  /** Whether the fetch writes `FETCH_HEAD`. */
  isWriteFetchHead(): boolean {
    return this.writeFetchHead;
  }

  /**
   * Set whether the fetched refs are added after what `FETCH_HEAD` holds instead of
   * replacing it (`git fetch --append`).
   */
  setAppend(append: boolean): this {
    this.checkCallable();
    this.appendFetchHead = append;
    return this;
  }

  /** Whether `FETCH_HEAD` is appended to. */
  isAppend(): boolean {
    return this.appendFetchHead;
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
  /**
   * `--[no-]write-commit-graph`: after the fetch, write a split commit-graph of everything the
   * refs reach, as git does with `fetch.writeCommitGraph` (which this overrides). It needs the
   * repository's files (`setRepositoryFiles`).
   */
  setWriteCommitGraph(write: boolean): this {
    this.checkCallable();
    this.writeCommitGraphOption = write;
    return this;
  }

  /**
   * The files of the repository (a files backend), where `fetch.writeCommitGraph` writes the
   * commit-graph. Without them no graph is written.
   *
   * @example
   * ```typescript
   * await git.fetch().setRepositoryFiles({ files }).setWriteCommitGraph(true).call();
   * ```
   */
  setRepositoryFiles(repository: { files: FilesApi; gitDir?: string }): this {
    this.checkCallable();
    this.repositoryFiles = repository;
    return this;
  }

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
   * Update the local refs in one transaction, all or none (`git fetch --atomic`). Each ref
   * is still logged with its own reflog message, as git's transaction logs it.
   */
  setAtomic(atomic: boolean): this {
    this.checkCallable();
    this.atomic = atomic;
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
   * The options as git's reflog action spells the command line (`GIT_REFLOG_ACTION` is
   * `fetch` and its arguments), in a fixed order since our options have none:
   * `--atomic --force --prune --prune-tags --tags --depth=<n> --unshallow --append
   * --no-write-fetch-head --refmap=<spec>` (and their `--no-` forms where set to false).
   */
  private commandLineOptions(): string[] {
    const flag = (value: boolean | undefined, name: string) =>
      value === true ? [`--${name}`] : value === false ? [`--no-${name}`] : [];
    return [
      ...(this.atomic ? ["--atomic"] : []),
      ...(this.forceUpdate ? ["--force"] : []),
      ...flag(this.removeDeletedRefs, "prune"),
      ...flag(this.pruneTags, "prune-tags"),
      ...(this.tagOptionSet && this.tagOption === TagOption.FETCH_TAGS ? ["--tags"] : []),
      ...(this.tagOptionSet && this.tagOption === TagOption.NO_TAGS ? ["--no-tags"] : []),
      ...(this.depth !== undefined ? [`--depth=${this.depth}`] : []),
      ...(this.unshallow ? ["--unshallow"] : []),
      ...(this.appendFetchHead ? ["--append"] : []),
      ...(this.writeFetchHead ? [] : ["--no-write-fetch-head"]),
      ...(this.refmap ?? []).map((spec) => `--refmap=${spec}`),
    ];
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

    const store = RemoteConfigStore.from(this.workingCopy);
    // git's remote_is_configured: a remote name with a config section, not a URL
    const viaConfig = store.isConfigured(this.remote);
    const prune =
      this.removeDeletedRefs ??
      configBool(store.value(`remote.${this.remote}.prune`)) ??
      configBool(store.value("fetch.prune")) ??
      false;
    const pruneTags =
      this.pruneTags ??
      configBool(store.value(`remote.${this.remote}.pruneTags`)) ??
      configBool(store.value("fetch.pruneTags")) ??
      false;
    const configured = viaConfig ? store.configuredFetchRefspecs(this.remote) : [];
    const explicitSpecs = [...this.refSpecs];
    // fetch.c fetch_one: --prune-tags (only without command-line refspecs) adds the tag
    // refspec to the configured ones, or for a URL to those of the fetch
    if (pruneTags && this.refSpecs.length === 0) {
      if (viaConfig) configured.push(TAG_REFSPEC);
      else explicitSpecs.push(TAG_REFSPEC);
    }

    // git: without a refspec the remote's HEAD is fetched, and no ref is written (nor any
    // tag); explicit refspecs must name refs the remote has, configured ones may not
    const fromConfig = explicitSpecs.length === 0;
    if (fromConfig && this.refmap !== undefined) {
      throw new InvalidArgumentError(
        "refmap",
        this.refmap,
        "--refmap option is only meaningful with command-line refspec(s)",
      );
    }
    // git's has_merge (branch_has_merge_config): the current branch has an upstream, on
    // whichever remote
    const upstream = fromConfig ? await this.upstreamConfig() : undefined;
    const upstreamHere = upstream?.remote === this.remote;
    // git (fetch.c get_ref_map): the remote's configured refspecs, or with none the current
    // branch's upstream refs when this remote is its upstream; else the remote HEAD
    const useConfig = fromConfig && (configured.length > 0 || upstreamHere);
    const given = !fromConfig ? explicitSpecs : useConfig ? configured : ["HEAD"];
    // add_merge_config: fetching the current branch's upstream remote also takes the
    // branch's `branch.<name>.merge` refs, for FETCH_HEAD
    const mergeRefs = useConfig && upstream && upstreamHere ? upstream.merge : [];
    const refspecs = [...given, ...mergeRefs];
    const history = this._workingCopy.history;
    // get_ref_map: refs named on the command line also update the remote-tracking refs the
    // refmap (or the remote's configured refspecs) maps them to
    const opportunistic = fromConfig
      ? []
      : (this.refmap ?? configured).filter((spec) => spec !== "");
    // do_fetch: refs/remotes/<name>/HEAD follows the remote HEAD on a configured fetch
    const followHead = fromConfig && configured.length > 0 ? this.followRemoteHead(store) : null;
    const messages: string[] = [];
    const errors: string[] = [];
    const trackingUpdates: TrackingRefUpdate[] = [];

    // git truncates FETCH_HEAD when the fetch starts: a failed fetch leaves it empty
    const checkout = this._workingCopy.checkout;
    const writesFetchHead = !this.dryRun && this.writeFetchHead && !!checkout?.writeFetchHead;
    if (writesFetchHead && !this.appendFetchHead) await checkout.writeFetchHead?.("");

    const result = await transportFetch({
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      gzipRequests: this.gzipRequests,
      repository: createRepositoryFacade({ history }),
      refStore: createTransportRefStore(history.refs),
      refspecs,
      opportunisticRefspecs: opportunistic.length > 0 ? opportunistic : undefined,
      // fetch.c do_fetch: stale refs are pruned before anything is fetched; with
      // command-line refspecs by those, else by the configured ones
      beforeFetch: prune
        ? async (remoteRefs) => {
            const names = new Set(remoteRefs.filter((r) => r.oid).map((r) => r.name));
            const pruneSpecs = (fromConfig ? configured : explicitSpecs).map((s) =>
              parseRefSpec(s),
            );
            trackingUpdates.push(
              ...(await this.pruneDeletedRefs(names, pruneSpecs, messages, errors)),
            );
          }
        : undefined,
      missingRefsOk: useConfig,
      tags: toTagMode(this.effectiveTagOption()),
      depth: this.depth,
      deepenSince: this.shallowSince,
      deepenNot: this.shallowExcludes.length > 0 ? this.shallowExcludes : undefined,
      unshallow: this.unshallow || undefined,
      force: this.forceUpdate,
      atomic: this.atomic || undefined,
      dryRun: this.dryRun,
      onProgress: this.progressMessageCallback,
      // git's "fetch <args>: <what>" per ref; the action from the options, the remote and
      // the refspecs given (git's argv)
      reflogAction: this.reflogAction(
        [
          "fetch",
          ...this.commandLineOptions(),
          ...(this.remoteGiven || this.refSpecs.length > 0 ? [this.remote] : []),
          ...this.refSpecs,
        ].join(" "),
      ),
      reflogIdent: this.reflogLine("").ident,
    });

    const advertisedRefs = new Map<string, ObjectId>();
    for (const ref of result.remoteRefs) {
      if (ref.oid) advertisedRefs.set(ref.name, ref.oid);
    }
    trackingUpdates.push(...result.refUpdates.map(toTrackingRefUpdate));

    if (writesFetchHead && checkout?.writeFetchHead) {
      const entries = await this.fetchHeadEntries(result, {
        given: given.length,
        merge: mergeRefs,
        // explicit refspecs (and the HEAD of an unconfigured remote) are all to merge;
        // configured ones only when the first names one ref and no upstream is set
        explicit: !useConfig,
        firstIsExact: given.length > 0 && !parseRefSpec(given[0]).wildcard,
        hasMerge: upstream !== undefined,
      });
      // after the truncation above, every fetch adds its lines
      await checkout.writeFetchHead(formatFetchHead(entries, remoteUrl), { append: true });
    }

    if (followHead) {
      // git: "way too many cases where this can go wrong ... fail silently"
      try {
        await this.setRemoteHead(result.remoteRefs, followHead, store, messages);
      } catch {
        // the refs are updated; refs/remotes/<name>/HEAD is left as it was
      }
    }

    // fetch.c: after the fetch (and its submodules), a split graph of what the refs reach
    // (write_commit_graph_reachable with COMMIT_GRAPH_WRITE_SPLIT), on --write-commit-graph
    // or fetch.writeCommitGraph
    const commitGraphHashes = await this.writeCommitGraphAfterFetch(store, messages);

    return {
      uri: remoteUrl,
      advertisedRefs,
      trackingRefUpdates: trackingUpdates,
      ...(commitGraphHashes ? { commitGraph: commitGraphHashes } : {}),
      defaultBranch: result.defaultBranch,
      bytesReceived: result.packBytes,
      isEmpty: result.isEmpty,
      messages,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  /**
   * git's write of the commit-graph at the end of a fetch: when `--write-commit-graph` or
   * `fetch.writeCommitGraph` asks and the repository's files are known, a split layer of the
   * commits the refs reach (merged with the layers below as `--split` merges them; existing
   * changed-path filters are kept). Its warnings join `messages` as git prints them. The
   * layer hashes of the chain written, base first; undefined when nothing was written.
   */
  private async writeCommitGraphAfterFetch(
    store: RemoteConfigStore,
    messages: string[],
  ): Promise<string[] | undefined> {
    const write =
      this.writeCommitGraphOption ?? configBool(store.value("fetch.writeCommitGraph")) ?? false;
    const repository = this.repositoryFiles;
    const history = this._workingCopy.history;
    if (!write || !repository || !history.objects) return undefined;
    const environment = hostEnvironmentOf(this._workingCopy);
    const result = await writeCommitGraph({
      files: repository.files,
      gitDir: repository.gitDir,
      objects: history.objects,
      refs: history.refs,
      commitGraph: history.commitGraph,
      split: true,
      ...(environment ? { environment } : {}),
    });
    for (const warning of result.warnings) messages.push(`warning: ${warning}`);
    return result.written ? result.hashes : undefined;
  }

  /**
   * How `refs/remotes/<name>/HEAD` follows the remote HEAD (git 2.48+): the remote's
   * `remote.<name>.followRemoteHEAD`, else `fetch.followRemoteHEAD`, else `create`; an
   * unrecognized value is ignored, as git warns and ignores it. Null for `never`.
   */
  private followRemoteHead(store: RemoteConfigStore): FollowRemoteHead | null {
    const mode = parseFollowRemoteHead(
      store.value(`remote.${this.remote}.followRemoteHEAD`),
      true,
    ) ??
      parseFollowRemoteHead(store.value("fetch.followRemoteHEAD"), false) ?? {
        mode: "create",
      };
    return mode.mode === "never" ? null : mode;
  }

  /**
   * git's set_head (fetch.c): the one branch the remote HEAD names (its symref, or else the
   * only branch at its commit) becomes `refs/remotes/<name>/HEAD`, if that tracking ref
   * exists here: created when missing (`create`, `warn`), or always set (`always`). In a
   * bare repository mirroring the remote (`remote.<name>.mirror`), HEAD itself is set to
   * the branch. `warn` reports a local HEAD that differs, in git's words, into `messages`.
   * As in git, failures are silent and a dry run is no exception.
   */
  private async setRemoteHead(
    remoteRefs: readonly { name: string; oid?: string; symref?: string }[],
    follow: FollowRemoteHead,
    store: RemoteConfigStore,
    messages: string[],
  ): Promise<void> {
    const head = remoteRefs.find((r) => r.name === "HEAD");
    if (!head) return;
    const branches = remoteRefs.filter((r) => r.oid && r.name.startsWith("refs/heads/"));
    const heads = head.symref
      ? branches.filter((r) => r.name === head.symref)
      : branches.filter((r) => r.oid === head.oid);
    if (heads.length !== 1) return;
    const headName = heads[0].name.slice("refs/heads/".length);
    const remote = this.remote;
    const baremirror =
      configBool(store.value("core.bare")) === true &&
      configBool(store.value(`remote.${remote}.mirror`)) === true;
    const createOnly = follow.mode === "always" ? false : !baremirror;
    const name = baremirror ? "HEAD" : `refs/remotes/${remote}/HEAD`;
    const target = baremirror ? `refs/heads/${headName}` : `refs/remotes/${remote}/${headName}`;
    if (!baremirror && !(await this.refsStore.resolve(target))?.objectId) return;
    const previous = await this.refsStore.get(name);
    // refs_update_symref_extended(..., "fetch", ...): logged with the literal "fetch"
    if (!createOnly || !previous) {
      await this.refsStore.setSymbolic(name, target, this.reflogLine("fetch"));
    }
    if (follow.mode !== "warn" || follow.noWarnBranch === headName || !previous) return;
    // warn_set_head
    const prefix = `refs/remotes/${remote}/`;
    let warning: string | undefined;
    if (isSymbolicRef(previous)) {
      const was = previous.target.startsWith(prefix) ? previous.target.slice(prefix.length) : "";
      if (was && was !== headName) {
        warning = `'HEAD' at '${remote}' is '${headName}', but we have '${was}' locally.`;
      }
    } else {
      warning = `'HEAD' at '${remote}' is '${headName}', but we have a detached HEAD pointing to '${previous.objectId}' locally.`;
    }
    if (!warning) return;
    messages.push(warning);
    // set_head_advice_msg, unless advice.fetchRemoteHEADWarn is false
    if (configBool(store.value("advice.fetchRemoteHEADWarn")) === false) return;
    const advice = [
      `Run 'git remote set-head ${remote} ${headName}' to follow the change, or modify`,
      `either of the 'remote.${remote}.followRemoteHEAD' or 'fetch.followRemoteHEAD'`,
      "configuration variables to handle the situation differently.",
      "",
      "Using this specific setting",
      "",
      `    git config set remote.${remote}.followRemoteHEAD warn-if-not-${headName}`,
      "",
      "will suppress the warning until the remote changes HEAD to something else.",
      'Disable this message with "git config set advice.fetchRemoteHEADWarn false"',
    ];
    messages.push(...advice.map((line) => (line ? `hint: ${line}` : "hint:")));
  }

  /** The tag option given, else the remote's `remote.<name>.tagOpt`, else auto-follow. */
  private effectiveTagOption(): TagOption {
    if (this.tagOptionSet) return this.tagOption;
    const tagOpt = RemoteConfigStore.from(this.workingCopy).value(`remote.${this.remote}.tagOpt`);
    if (tagOpt === "--no-tags") return TagOption.NO_TAGS;
    if (tagOpt === "--tags") return TagOption.FETCH_TAGS;
    return this.tagOption;
  }

  /**
   * The current branch's upstream: its `branch.<name>.remote` and `branch.<name>.merge`
   * refs, when both are set (git's branch_has_merge_config); undefined on a detached HEAD
   * or without upstream configuration.
   */
  private async upstreamConfig(): Promise<{ remote: string; merge: string[] } | undefined> {
    const head = await this.refsStore.get("HEAD");
    if (!head || !isSymbolicRef(head) || !head.target.startsWith("refs/heads/")) return undefined;
    const branch = head.target.slice("refs/heads/".length);
    const store = RemoteConfigStore.from(this.workingCopy);
    const remote = store.value(`branch.${branch}.remote`);
    const merge = store.values(`branch.${branch}.merge`);
    return remote !== undefined && merge.length > 0 ? { remote, merge } : undefined;
  }

  /**
   * The `FETCH_HEAD` lines of a fetch, marked as git's get_ref_map marks them: refs from
   * explicit refspecs (or the HEAD of an unconfigured remote) are to merge; with configured
   * refspecs, the refs the current branch's `branch.<name>.merge` names (fetched for this
   * alone when no refspec took them), or else the first ref when the first refspec names
   * one ref. Tags (`--tags`, auto-follow), the rest, and anything that does not peel to a
   * commit are `not-for-merge`.
   */
  private async fetchHeadEntries(
    result: FetchClientResult,
    marks: {
      given: number;
      merge: string[];
      explicit: boolean;
      firstIsExact: boolean;
      hasMerge: boolean;
    },
  ): Promise<FetchHeadEntry[]> {
    const mergeSpec = (index: number | undefined) =>
      index !== undefined && index >= marks.given && index < marks.given + marks.merge.length
        ? index - marks.given
        : undefined;
    const entries: (FetchHeadEntry & { refspec?: number })[] = [];
    for (const fetched of result.fetched) {
      if (mergeSpec(fetched.refspec) !== undefined) continue;
      const fromGiven = fetched.refspec !== undefined && fetched.refspec < marks.given;
      entries.push({
        oid: fetched.oid,
        remoteRef: fetched.remoteRef,
        notForMerge: !(marks.explicit && fromGiven),
        refspec: fetched.refspec,
      });
    }
    if (!marks.explicit) {
      if (!marks.hasMerge && marks.firstIsExact && entries[0]?.refspec === 0) {
        entries[0].notForMerge = false;
      }
      // each merge ref marks the first ref a configured refspec took that it names...
      const matched = new Set<number>();
      for (const [k, ref] of marks.merge.entries()) {
        const match = entries.find(
          (e) =>
            e.refspec !== undefined && e.refspec < marks.given && refNameMatches(ref, e.remoteRef),
        );
        if (match) {
          match.notForMerge = false;
          matched.add(k);
        }
      }
      // ...or else is listed itself, after the refs the configured refspecs took
      const extra: typeof entries = [];
      for (const fetched of result.fetched) {
        const k = mergeSpec(fetched.refspec);
        if (k === undefined || matched.has(k)) continue;
        extra.push({ oid: fetched.oid, remoteRef: fetched.remoteRef, notForMerge: false });
      }
      const tagsAt = entries.findIndex((e) => e.refspec === undefined || e.refspec >= marks.given);
      entries.splice(tagsAt < 0 ? entries.length : tagsAt, 0, ...extra);
    }
    for (const entry of entries) {
      if (!entry.notForMerge && !(await this.peelsToCommit(entry.oid))) entry.notForMerge = true;
    }
    return entries.map(({ oid, remoteRef, notForMerge }) => ({ oid, remoteRef, notForMerge }));
  }

  /** Whether `id` is a commit, or a tag (chain) of one (git's lookup_commit_reference_gently). */
  private async peelsToCommit(id: ObjectId): Promise<boolean> {
    const history = this._workingCopy.history;
    let current: ObjectId | undefined = id;
    for (let i = 0; current && i < 16; i++) {
      if (await history.commits.has(current)) return true;
      if (!(await history.tags.has(current))) return false;
      current = await history.tags.getTarget(current);
    }
    return false;
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
   * The stale remote-tracking refs (git's get_stale_heads): every local ref that the
   * refspecs map from remote refs (all of the matching refspecs: overlapping ones count
   * together), none of which the remote has, unless a negative refspec excludes it or it is
   * a symbolic ref. They are deleted (reflogs too) in one batch, logged `fetch: prune`, and
   * reported as deleted; a dry run reports them only. The symbolic refs left dangling are
   * named in `messages` as git does. A refused delete does not stop the fetch: as in git
   * (which then exits 1), the error goes into `errors` and nothing is reported deleted.
   */
  private async pruneDeletedRefs(
    remoteRefNames: Set<string>,
    specs: RefSpec[],
    messages: string[],
    errors: string[],
  ): Promise<TrackingRefUpdate[]> {
    const negative = specs.filter((s) => s.negative && s.source);
    const mapping = specs.filter((s) => !s.negative && s.source && s.destination);
    const stale: { name: string; objectId: ObjectId; source: string }[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      const sources: string[] = [];
      for (const spec of mapping) {
        if (spec.wildcard) {
          if (!matchDestination(spec, ref.name)) continue;
          const source = expandFromDestination(spec, ref.name).source;
          if (source) sources.push(source);
        } else if (ref.name === spec.destination && spec.source) {
          sources.push(spec.source);
        }
      }
      if (sources.length === 0 || isSymbolicRef(ref) || !ref.objectId) continue;
      if (sources.some((src) => negative.some((n) => matchSource(n, src)))) continue;
      if (sources.some((src) => remoteRefNames.has(src))) continue;
      stale.push({ name: ref.name, objectId: ref.objectId, source: sources[0] });
    }
    if (stale.length === 0) return [];
    // refs_warn_dangling_symrefs: listed before the deletion, as the targets go
    const dangling = await this.danglingSymrefs(new Set(stale.map((r) => r.name)));
    if (!this.dryRun) {
      try {
        await deleteRefs(
          this.refsStore,
          stale.map((r) => r.name),
          "fetch: prune",
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    }
    for (const { name, target } of dangling) {
      messages.push(
        this.dryRun
          ? `   ${name} will become dangling after ${target} is deleted`
          : `   ${name} has become dangling after ${target} was deleted`,
      );
    }
    return stale.map((ref) => ({
      localRef: ref.name,
      remoteRef: ref.source,
      oldObjectId: ref.objectId,
      newObjectId: "", // Empty indicates deletion
      status: RefUpdateStatus.DELETED,
      summary: "[deleted]",
    }));
  }

  /** The symbolic refs whose chain ends at one of `names` (git's warn_if_dangling_symref). */
  private async danglingSymrefs(names: Set<string>): Promise<{ name: string; target: string }[]> {
    const found: { name: string; target: string }[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      if (!isSymbolicRef(ref)) continue;
      let target = ref.target;
      for (let i = 0; i < 5; i++) {
        const next = await this.refsStore.get(target);
        if (!next || !isSymbolicRef(next)) break;
        target = next.target;
      }
      if (names.has(target)) found.push({ name: ref.name, target });
    }
    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/** git's TAG_REFSPEC, which `--prune-tags` adds. */
const TAG_REFSPEC = "refs/tags/*:refs/tags/*";

/** How `refs/remotes/<name>/HEAD` follows the remote HEAD (`remote.<name>.followRemoteHEAD`). */
interface FollowRemoteHead {
  mode: "never" | "create" | "warn" | "always";
  /** `warn-if-not-<branch>`: no warning while the remote HEAD is this branch */
  noWarnBranch?: string;
}

/**
 * A `followRemoteHEAD` value; undefined when unset or unrecognized. `warn-if-not-<branch>`
 * is read from `remote.<name>.followRemoteHEAD` only, as git's remote.c does.
 */
function parseFollowRemoteHead(
  value: string | undefined,
  perRemote: boolean,
): FollowRemoteHead | undefined {
  if (value === "never" || value === "create" || value === "warn" || value === "always") {
    return { mode: value };
  }
  if (perRemote && value?.startsWith("warn-if-not-")) {
    return { mode: "warn", noWarnBranch: value.slice("warn-if-not-".length) };
  }
  return undefined;
}

/** A git boolean config value; undefined when unset or not a boolean. */
const configBool = (value: string | undefined): boolean | undefined => parseGitBool(value);

/** git's refname_match: `ref` (`main`, `heads/main`, `refs/heads/main`) names `fullName`. */
function refNameMatches(ref: string, fullName: string): boolean {
  return [
    ref,
    `refs/${ref}`,
    `refs/tags/${ref}`,
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    `refs/remotes/${ref}/HEAD`,
  ].includes(fullName);
}
