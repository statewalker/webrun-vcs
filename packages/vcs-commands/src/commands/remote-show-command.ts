import { isSymbolicRef, isValidRefName } from "@statewalker/vcs-core";
import {
  expandFromDestination,
  expandFromSource,
  lsRefs,
  type MatchedPushRef,
  matchDestination,
  matchPushRefs,
  matchSource,
  PushRefspecError,
  parseRefSpec,
  type RefSpec,
  type RemoteRef as TransportRemoteRef,
} from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";

import { GitApiError, MissingArgumentError } from "../errors/index.js";
import { GuardedTransportCommand } from "../guarded-transport-command.js";
import { deleteRefs, RemoteConfigStore } from "../remote-config/index.js";
import { RemoteListCommand } from "./remote-command.js";
import { withRemoteUploadPack } from "./remote-transport.js";

/** What `git remote show` says of one ref a push would update (builtin/remote.c `push_info`). */
export interface RemotePushInfo {
  /** The local ref, short (`main`), `(delete)` for a deleting refspec, `(matching)` */
  source: string;
  /** The remote ref, short (`main`), or `(matching)` */
  destination: string;
  /** Whether the refspec forces the update (`+`) */
  forced: boolean;
  /**
   * What the push would do (with the remote queried): `create`, `delete`, `up to date`,
   * `fast-forwardable`, `local out of date`; undefined when the remote was not queried
   */
  status?: "create" | "delete" | "up to date" | "fast-forwardable" | "local out of date";
}

/** A local branch that `git pull` merges from the remote (builtin/remote.c `branch_info`). */
export interface RemotePullInfo {
  branch: string;
  /** The remote branches it merges, short names (`branch.<name>.merge`) */
  merges: string[];
  /** `branch.<name>.rebase`: none, `true`, `merges` or `interactive` */
  rebase?: "true" | "merges" | "interactive";
}

/** What `git remote show <name>` knows of a remote (builtin/remote.c `ref_states`). */
export interface RemoteShowInfo {
  name: string;
  fetchUrl: string;
  pushUrls: string[];
  /** Whether the remote was asked for its refs (no `-n`) */
  queried: boolean;
  /**
   * The remote's HEAD branch: one name, several when HEAD's commit is at several branches
   * and the remote names none, empty when unknown; undefined when not queried
   */
  heads?: string[];
  /** The remote's refs the fetch refspecs take that have no tracking ref yet (short names) */
  newRefs: string[];
  /** The remote's refs the fetch refspecs take whose tracking refs exist (short names) */
  tracked: string[];
  /** The remote's refs a negative refspec excludes */
  skipped: string[];
  /** The tracking refs whose remote ref is gone (outside `refs/heads/`: full names) */
  stale: string[];
  /** The local branches `git pull` merges from this remote */
  pull: RemotePullInfo[];
  /** Whether `remote.<name>.mirror` makes `git push` mirror every ref */
  mirror: boolean;
  /** What `git push` does, sorted as git prints it */
  push: RemotePushInfo[];
}

/** One remote of {@link RemotePruneCommand}: what was (or would be) pruned. */
export interface RemotePruneResult {
  name: string;
  url: string;
  /** The tracking refs pruned, full names, in git's order */
  pruned: string[];
}

/**
 * The commands that read a remote's refs as builtin/remote.c's `get_remote_ref_states`:
 * `git remote show` and `git remote prune`.
 */
abstract class RemoteStatesCommand<T> extends GuardedTransportCommand<T> {
  /** git's command reads no core settings: an unparsable `core.whitespace` does not stop it */
  protected override readsCoreConfig(): boolean {
    return false;
  }

  protected messages: string[] = [];

  /**
   * What git prints on stderr besides the output: legacy-remote warnings (2.5x), `more than
   * one branch.<name>.remote`, `invalid branch.<name>.merge`. Empty before the call.
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /**
   * Reads the legacy remotes of `names` (git's remote_get) and decides who gets the static
   * credentials and headers from the URLs of every remote this call asks (see
   * `GuardedTransportCommand`), before the first connection.
   */
  protected async prepareRemotes(names: readonly string[]): Promise<void> {
    for (const name of names) this.messages.push(...(await this.loadLegacyRemote(name)));
    const store = RemoteConfigStore.from(this.workingCopy);
    const head = await this.refsStore.get("HEAD");
    const branch =
      head && isSymbolicRef(head) && head.target.startsWith("refs/heads/")
        ? head.target.slice("refs/heads/".length)
        : undefined;
    this.resolveAuth(
      names.map((name) => this.urlsOf(store, name).fetch),
      store.urlFor(store.remoteForBranch(branch)),
    );
  }

  /** The remote as `remote_get` gives it: its first URL and its push URLs. */
  protected urlsOf(store: RemoteConfigStore, name: string): { fetch: string; push: string[] } {
    const fetch = store.remoteUrlOf(name);
    const push = store.isConfigured(name) ? store.remotePushUrls(name) : [];
    return { fetch, push: push.length > 0 ? push : [store.remoteUrlOf(name, { push: true })] };
  }

  /** Every ref the remote advertises (transport_get_remote_refs without prefixes). */
  protected async remoteRefs(name: string, url: string): Promise<readonly TransportRemoteRef[]> {
    const program = this.remoteProgram(name, "uploadpack");
    return withRemoteUploadPack(
      await this.prepareRemote(url),
      { ...this.remoteSessionOptions(), ...(program !== undefined ? { program } : {}) },
      async (connection) =>
        connection.version === 2 ? lsRefs(connection, []) : (connection.advertisedRefs ?? []),
    );
  }

  /**
   * git's get_ref_states: the remote refs the fetch refspecs map (new, tracked, or skipped
   * by a negative refspec) and the tracking refs whose remote ref is gone (get_stale_heads).
   */
  protected async refStates(
    specs: RefSpec[],
    remoteRefs: readonly TransportRemoteRef[],
  ): Promise<{
    newRefs: string[];
    tracked: string[];
    skipped: string[];
    /** The stale tracking refs: `short` as git shows them, `ref` in full; by `short` */
    stale: { short: string; ref: string }[];
  }> {
    const fetchMap: { name: string; peer?: string }[] = [];
    for (const spec of specs) {
      if (spec.negative) continue;
      if (spec.wildcard) {
        // get_expanded_map: a local symbolic ref is never updated
        for (const ref of remoteRefs) {
          if (ref.name.includes("^") || !spec.source || !matchSource(spec, ref.name)) continue;
          const peer = spec.destination
            ? (expandFromSource(spec, ref.name).destination ?? undefined)
            : undefined;
          if (peer !== undefined) {
            const local = await this.refsStore.get(peer);
            if (local && isSymbolicRef(local)) continue;
          }
          if (peer !== undefined && !funnyRef(peer)) fetchMap.push({ name: ref.name, peer });
          else if (peer === undefined) fetchMap.push({ name: ref.name });
        }
      } else {
        const wanted = spec.source ? spec.source : "HEAD";
        const ref = findRefByNameAbbrev(remoteRefs, wanted);
        if (!ref) continue;
        const peer = localRefName(spec.destination);
        if (peer !== undefined && funnyRef(peer)) continue;
        fetchMap.push({ name: ref.name, ...(peer !== undefined ? { peer } : {}) });
      }
    }
    const negative = specs.filter((s) => s.negative && s.source);
    const newRefs = new Set<string>();
    const tracked = new Set<string>();
    const skipped = new Set<string>();
    for (const ref of fetchMap) {
      if (negative.some((n) => matchSource(n, ref.name))) skipped.add(abbrevBranch(ref.name));
      else if (!ref.peer || !(await this.refExists(ref.peer))) newRefs.add(abbrevBranch(ref.name));
      else tracked.add(abbrevBranch(ref.name));
    }
    const names = new Set(fetchMap.map((r) => r.name));
    const stale: string[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      const sources = trackingSources(specs, ref.name);
      if (!sources || sources.length === 0 || isSymbolicRef(ref)) continue;
      if (!sources.some((s) => names.has(s))) stale.push(ref.name);
    }
    return {
      newRefs: sortBytes([...newRefs]),
      tracked: sortBytes([...tracked]),
      skipped: sortBytes([...skipped]),
      stale: stale
        .map((ref) => ({ short: abbrevBranch(ref), ref }))
        .sort((a, b) => compareBytes(a.short, b.short)),
    };
  }

  /** git's refs_ref_exists: the ref resolves to an object. */
  private async refExists(name: string): Promise<boolean> {
    return !!(await this.refsStore.resolve(name))?.objectId;
  }

  /**
   * The symbolic refs whose target is one of `names` (refs_warn_dangling_symrefs), sorted:
   * `[name, target]`.
   */
  protected async danglingSymrefs(names: Set<string>): Promise<[string, string][]> {
    const found: [string, string][] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      if (!isSymbolicRef(ref)) continue;
      let target = ref.target;
      for (let i = 0; i < 5; i++) {
        const next = await this.refsStore.get(target);
        if (!next || !isSymbolicRef(next)) break;
        target = next.target;
      }
      if (names.has(target)) found.push([ref.name, target]);
    }
    return found.sort((a, b) => compareBytes(a[0], b[0]));
  }
}

/**
 * What git knows of a remote: `git remote show [-n] <name>...`.
 *
 * As builtin/remote.c `show`: the remote's URLs; unless {@link setNoQuery} (`-n`), the
 * remote is asked for its refs through the command's transports (as `git fetch` reaches it),
 * which gives its HEAD branch (the branch HEAD's symref names, else every branch at HEAD's
 * commit), the state of each branch the fetch refspecs take (`tracked`, `new (next fetch will
 * store in remotes/<name>)`, `skipped` by a negative refspec, and the tracking refs whose
 * branch is gone, `stale`) and what `git push` would do to each remote ref (`create`, `up to
 * date`, `fast-forwardable`, `local out of date`, `delete`); with `-n` nothing is asked and
 * the tracking refs are listed from the refspecs alone. The local branches `git pull` merges
 * from the remote (`branch.<name>.remote`, `.merge`, `.rebase`) are listed either way. Without
 * a remote name it is `git remote` ({@link RemoteListCommand}).
 *
 * @example
 * ```typescript
 * const text = await git.remoteShow().setRemoteNames("origin").callText();
 * // "* remote origin\n  Fetch URL: ...\n  HEAD branch: main\n  Remote branches:\n ..."
 * ```
 */
export class RemoteShowCommand extends RemoteStatesCommand<RemoteShowInfo[]> {
  private names: string[] = [];
  private noQuery = false;

  /** The remotes to show, in order. */
  setRemoteNames(...names: string[]): this {
    this.checkCallable();
    this.names = [...names];
    return this;
  }

  /** Do not ask the remotes for their refs (`-n`). */
  setNoQuery(noQuery: boolean): this {
    this.checkCallable();
    this.noQuery = noQuery;
    return this;
  }

  /**
   * @returns what git knows of each remote
   * @throws the transport's error when a remote cannot be reached (git dies, exit 128)
   */
  async call(): Promise<RemoteShowInfo[]> {
    this.checkCallable();
    this.setCallable(false);
    const infos: RemoteShowInfo[] = [];
    if (!this.noQuery) await this.prepareRemotes(this.names);
    else for (const name of this.names) this.messages.push(...(await this.loadLegacyRemote(name)));
    for (const name of this.names) infos.push(await this.collect(name));
    return infos;
  }

  /**
   * What `git remote show` prints on stdout: per remote, `* remote <name>`, `  Fetch URL:`,
   * `  Push  URL:` lines, `  HEAD branch:`, `  Remote branches:` with each branch's state,
   * `  Local branches configured for 'git pull':` and `  Local refs configured for 'git
   * push':`, columns as wide as git makes them. Without remote names, `git remote`'s list.
   *
   * @throws the transport's error when a remote cannot be reached (git dies, exit 128); the
   *   text of the remotes shown before it is on the error as `stdout`
   */
  async callText(): Promise<string> {
    this.checkCallable();
    if (this.names.length === 0) {
      this.setCallable(false);
      return new RemoteListCommand(this._workingCopy).callText();
    }
    this.setCallable(false);
    if (!this.noQuery) await this.prepareRemotes(this.names);
    else for (const name of this.names) this.messages.push(...(await this.loadLegacyRemote(name)));
    let out = "";
    for (const name of this.names) {
      let info: RemoteShowInfo;
      try {
        info = await this.collect(name);
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { stdout: out });
        throw error;
      }
      out += formatShow(info, this.noQuery);
    }
    return out;
  }

  private async collect(name: string): Promise<RemoteShowInfo> {
    const store = RemoteConfigStore.from(this.workingCopy);
    const specs = store.configuredFetchRefspecs(name).map((s) => parseRefSpec(s));
    const urls = this.urlsOf(store, name);
    const mirror = parseGitBool(store.value(`remote.${name}.mirror`)) === true;
    const pushSpecs = store.pushRefspecs(name);
    const info: RemoteShowInfo = {
      name,
      fetchUrl: urls.fetch,
      pushUrls: urls.push,
      queried: !this.noQuery,
      newRefs: [],
      tracked: [],
      skipped: [],
      stale: [],
      pull: [],
      mirror,
      push: [],
    };
    // read_branches comes before the query
    const branches = readBranches(store, this.messages);
    if (!this.noQuery) {
      const refs = await this.remoteRefs(name, urls.fetch);
      const states = await this.refStates(specs, refs);
      info.newRefs = states.newRefs;
      info.tracked = states.tracked;
      info.skipped = states.skipped;
      info.stale = states.stale.map((s) => s.short);
      info.heads = headNames(refs);
      if (!mirror) info.push = await this.pushStates(pushSpecs, refs);
    } else {
      // append_ref_to_tracked_list: every ref the fetch refspecs map back to a remote ref
      const tracked: string[] = [];
      for await (const ref of this.refsStore.list("refs/")) {
        if (isSymbolicRef(ref)) continue;
        const source = trackingSources(specs, ref.name)?.[0];
        if (source !== undefined) tracked.push(abbrevBranch(source));
      }
      info.tracked = sortBytes(tracked);
      if (!mirror) info.push = pushNoQuery(pushSpecs);
    }
    for (const branch of branches) {
      if (branch.merges.length === 0 || branch.remote !== name) continue;
      info.pull.push({
        branch: branch.name,
        merges: branch.merges,
        ...(branch.rebase ? { rebase: branch.rebase } : {}),
      });
    }
    info.push.sort(
      (a, b) => compareBytes(a.source, b.source) || compareBytes(a.destination, b.destination),
    );
    // show_local_info_item: a rebase onto several branches is refused
    for (const pull of info.pull) {
      if (pull.rebase && pull.merges.length > 1) {
        this.messages.push(
          `error: invalid branch.${pull.branch}.merge; cannot rebase onto > 1 branch`,
        );
      }
    }
    return info;
  }

  /** get_push_ref_states: match_push_refs over the local refs and the remote's. */
  private async pushStates(
    pushSpecs: string[],
    remoteRefs: readonly TransportRemoteRef[],
  ): Promise<RemotePushInfo[]> {
    const local = new Map<string, string>();
    for await (const ref of this.refsStore.list("refs/")) {
      if (!isValidRefName(ref.name)) continue;
      const id = isSymbolicRef(ref)
        ? (await this.refsStore.resolve(ref.name))?.objectId
        : ref.objectId;
      if (id) local.set(ref.name, id);
    }
    const head = await this.refsStore.get("HEAD");
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    const localState = {
      refs: local,
      head: {
        ...(head && isSymbolicRef(head) ? { target: head.target } : {}),
        ...(headId ? { oid: headId } : {}),
      },
      hasObject: async (id: string) => this.objectExists(id),
    };
    const match = (specs: string[]) =>
      matchPushRefs(specs, localState, remoteRefs, { objectFormat: this.objectFormat });
    // match_explicit_refs reports a refspec that matches nothing (or too much) and matches
    // the others: such refspecs are left out here
    const specs = pushSpecs.length > 0 ? pushSpecs : [":"];
    const usable: string[] = [];
    for (const spec of specs) {
      try {
        await match([spec]);
        usable.push(spec);
      } catch (error) {
        if (!(error instanceof PushRefspecError)) throw error;
        this.messages.push(`error: ${error.message}`);
      }
    }
    if (usable.length === 0) return [];
    let matched: MatchedPushRef[];
    try {
      matched = await match(usable);
    } catch (error) {
      if (error instanceof PushRefspecError) return [];
      throw error;
    }
    const nullId = this.objectFormat.nullId;
    const infos: RemotePushInfo[] = [];
    for (const ref of matched) {
      const deleting = ref.newOid === nullId;
      const source = deleting ? "(delete)" : abbrevBranch(ref.localRef ?? ref.source ?? "");
      let status: RemotePushInfo["status"];
      if (deleting) status = "delete";
      else if (ref.oldOid === ref.newOid) status = "up to date";
      else if (ref.oldOid === nullId) status = "create";
      else if (
        (await this.objectExists(ref.oldOid)) &&
        (await this.isNewer(ref.newOid, ref.oldOid))
      )
        status = "fast-forwardable";
      else status = "local out of date";
      infos.push({ source, destination: abbrevBranch(ref.remoteRef), forced: ref.force, status });
    }
    return infos;
  }

  /** odb_has_object; a store without its object kernel asks the typed stores. */
  private async objectExists(id: string): Promise<boolean> {
    const objects = this.workingCopy.history.objects;
    if (objects) return objects.has(id).catch(() => false);
    for (const s of [this.commits, this.trees, this.blobs, this.tagsStore]) {
      if (s && (await s.has(id).catch(() => false))) return true;
    }
    return false;
  }

  /** git's ref_newer: both peel to commits, and `old` is an ancestor of `next`. */
  private async isNewer(next: string, old: string): Promise<boolean> {
    const a = await this.peelToCommit(next);
    const b = await this.peelToCommit(old);
    if (!a || !b) return false;
    return this.commits.isAncestor(b, a);
  }

  private async peelToCommit(id: string): Promise<string | undefined> {
    const tags = this.tagsStore;
    let current: string | undefined = id;
    for (let i = 0; current && i < 16; i++) {
      if (await this.commits.has(current)) return current;
      if (!tags || !(await tags.has(current))) return undefined;
      current = await tags.getTarget(current);
    }
    return undefined;
  }
}

/**
 * Delete the tracking refs whose remote branch is gone: `git remote prune [--dry-run]
 * <name>...`.
 *
 * As builtin/remote.c `prune_remote`: the remote is asked for its refs through the command's
 * transports, and every ref its fetch refspecs map from a remote ref the remote no longer has
 * (git's get_stale_heads: not a symbolic ref, not excluded by a negative refspec) is deleted
 * with its reflog in one batch (`remote: prune`). git's output is {@link getOutput}:
 * `Pruning <name>`, `URL: <url>`, ` * [pruned] <name>/<branch>` (` * [would prune] ...` for
 * a dry run), then the symbolic refs left dangling; nothing for a remote with nothing stale.
 *
 * @example
 * ```typescript
 * await git.remotePrune().setRemoteNames("origin").call();
 * const preview = git.remotePrune().setRemoteNames("origin").setDryRun(true);
 * await preview.call();
 * console.log(preview.getOutput());
 * ```
 */
export class RemotePruneCommand extends RemoteStatesCommand<RemotePruneResult[]> {
  private names: string[] = [];
  private dryRun = false;
  private output = "";

  /** The remotes to prune, in order. */
  setRemoteNames(...names: string[]): this {
    this.checkCallable();
    this.names = [...names];
    return this;
  }

  /** Report what would be pruned, delete nothing (`--dry-run`). */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** What git prints on stdout. Empty before {@link call}. */
  getOutput(): string {
    return this.output;
  }

  /**
   * @returns each remote's pruned refs (empty for one with nothing stale)
   * @throws MissingArgumentError (git: its usage, exit 129) without a remote
   * @throws the transport's error when a remote cannot be reached (git dies, exit 128); what
   *   was printed before it is in {@link getOutput}
   * @throws GitApiError (exit 1) when the ref store refused the deletion
   */
  async call(): Promise<RemotePruneResult[]> {
    this.checkCallable();
    this.setCallable(false);
    if (this.names.length === 0) {
      throw new MissingArgumentError("remoteNames", "usage: git remote prune [<options>] <name>");
    }
    const results: RemotePruneResult[] = [];
    let failure: string | undefined;
    await this.prepareRemotes(this.names);
    for (const name of this.names) {
      const store = RemoteConfigStore.from(this.workingCopy);
      const specs = store.configuredFetchRefspecs(name).map((s) => parseRefSpec(s));
      const url = this.urlsOf(store, name).fetch;
      const states = await this.refStates(specs, await this.remoteRefs(name, url));
      const stale = states.stale.map((s) => s.ref);
      results.push({ name, url, pruned: stale });
      if (stale.length === 0) continue;
      this.output += `Pruning ${name}\nURL: ${url}\n`;
      const toPrune = sortBytes([...stale]);
      if (!this.dryRun) {
        try {
          await deleteRefs(this.refsStore, toPrune, "remote: prune", {
            legacy: this.hooks.compatibility === "2.43",
          });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      for (const ref of stale) {
        const short = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
        this.output += ` * [${this.dryRun ? "would prune" : "pruned"}] ${short}\n`;
      }
      // git 2.43 names the symbolic ref alone
      const legacy = this.hooks.compatibility === "2.43";
      for (const [symref, target] of await this.danglingSymrefs(new Set(toPrune))) {
        if (legacy) {
          this.output += ` ${symref} ${this.dryRun ? "will become" : "has become"} dangling!\n`;
        } else {
          this.output += this.dryRun
            ? ` ${symref} will become dangling after ${target} is deleted\n`
            : ` ${symref} has become dangling after ${target} was deleted\n`;
        }
      }
    }
    if (failure !== undefined) throw new GitApiError(failure, { exitCode: 1 });
    return results;
  }
}

/** The text of one remote of `git remote show` (builtin/remote.c `show`). */
function formatShow(info: RemoteShowInfo, noQuery: boolean): string {
  const lines: string[] = [`* remote ${info.name}`, `  Fetch URL: ${info.fetchUrl}`];
  for (const url of info.pushUrls) lines.push(`  Push  URL: ${url}`);
  if (info.pushUrls.length === 0) lines.push("  Push  URL: (no URL)");
  const heads = info.heads ?? [];
  if (noQuery) lines.push("  HEAD branch: (not queried)");
  else if (heads.length === 0) lines.push("  HEAD branch: (unknown)");
  else if (heads.length === 1) lines.push(`  HEAD branch: ${heads[0]}`);
  else {
    lines.push("  HEAD branch (remote HEAD is ambiguous, may be one of the following):");
    for (const head of heads) lines.push(`    ${head}`);
  }

  // remote branch info: a sorted set of every name
  const all = sortBytes([
    ...new Set([...info.newRefs, ...info.skipped, ...info.tracked, ...info.stale]),
  ]);
  const width = Math.max(0, ...all.map((n) => n.length));
  if (all.length > 0) {
    lines.push(
      `  Remote branch${all.length === 1 ? "" : "es"}:${noQuery ? " (status not queried)" : ""}`,
    );
  }
  for (const name of all) {
    if (!info.queried) {
      lines.push(`    ${name}`);
      continue;
    }
    let state: string;
    if (info.newRefs.includes(name)) state = ` new (next fetch will store in remotes/${info.name})`;
    else if (info.tracked.includes(name)) state = " tracked";
    else if (info.skipped.includes(name)) state = " skipped";
    else if (info.stale.includes(name)) state = " stale (use 'git remote prune' to remove)";
    else state = " ???";
    lines.push(`    ${name.padEnd(width)}${state}`);
  }

  // git pull info
  const pullWidth = Math.max(0, ...info.pull.map((p) => p.branch.length));
  const anyRebase = info.pull.some((p) => p.rebase);
  if (info.pull.length > 0) {
    lines.push(
      info.pull.length === 1
        ? "  Local branch configured for 'git pull':"
        : "  Local branches configured for 'git pull':",
    );
  }
  for (const pull of info.pull) {
    if (pull.rebase && pull.merges.length > 1) continue;
    const head = `    ${pull.branch.padEnd(pullWidth)} `;
    let width = pullWidth + 4;
    if (pull.rebase) {
      const what =
        pull.rebase === "interactive"
          ? "rebases interactively onto remote"
          : pull.rebase === "merges"
            ? "rebases interactively (with merges) onto remote"
            : "rebases onto remote";
      lines.push(`${head}${what} ${pull.merges[0]}`);
      continue;
    }
    if (anyRebase) {
      lines.push(`${head} merges with remote ${pull.merges[0]}`);
      width++;
    } else lines.push(`${head}merges with remote ${pull.merges[0]}`);
    for (const merge of pull.merges.slice(1)) {
      lines.push(`${"".padEnd(width)}    and with remote ${merge}`);
    }
  }

  // git push info
  if (info.mirror) lines.push("  Local refs will be mirrored by 'git push'");
  const width1 = Math.max(0, ...info.push.map((p) => p.source.length));
  const width2 = Math.max(0, ...info.push.map((p) => p.destination.length));
  if (info.push.length > 0) {
    lines.push(
      `  Local ref${info.push.length === 1 ? "" : "s"} configured for 'git push'${noQuery ? " (status not queried)" : ""}:`,
    );
  }
  for (const push of info.push) {
    const verb = push.forced ? "forces to" : "pushes to";
    const source = push.status === "delete" ? "(none)" : push.source;
    if (push.status) {
      lines.push(
        `    ${source.padEnd(width1)} ${verb} ${push.destination.padEnd(width2)} (${push.status})`,
      );
    } else lines.push(`    ${source.padEnd(width1)} ${verb} ${push.destination}`);
  }
  return `${lines.join("\n")}\n`;
}

/** get_push_ref_states_noquery: the push refspecs as written. */
function pushNoQuery(pushSpecs: string[]): RemotePushInfo[] {
  if (pushSpecs.length === 0) {
    return [{ source: "(matching)", destination: "(matching)", forced: false }];
  }
  return pushSpecs.map((raw) => {
    let spec = raw;
    const forced = spec.startsWith("+");
    if (forced) spec = spec.slice(1);
    const negative = spec.startsWith("^");
    if (negative) spec = spec.slice(1);
    const colon = spec.indexOf(":");
    const src = colon < 0 ? spec : spec.slice(0, colon);
    const dst = colon < 0 ? undefined : spec.slice(colon + 1);
    // ":" (and "+:") is the matching refspec
    const source = spec === ":" ? "(matching)" : src.length > 0 ? src : "(delete)";
    return { source, destination: dst ? dst : source, forced };
  });
}

/** The branch settings `git remote show` reads (read_branches), sorted by branch name. */
function readBranches(
  store: RemoteConfigStore,
  messages: string[],
): { name: string; remote?: string; merges: string[]; rebase?: RemotePullInfo["rebase"] }[] {
  const byName = new Map<
    string,
    {
      name: string;
      remote?: string;
      merges: string[];
      rebase?: RemotePullInfo["rebase"];
      pushRemote?: string;
    }
  >();
  const entries =
    store.entriesWithPrefix("branch.") ??
    store
      .subsections("branch")
      .flatMap((branch) =>
        ["remote", "merge", "rebase", "pushremote"].flatMap((v) =>
          store
            .values(`branch.${branch}.${v}`)
            .map((value) => ({ key: `branch.${branch}.${v}`, value })),
        ),
      );
  for (const { key, value } of entries) {
    const rest = key.slice("branch.".length);
    const dot = rest.lastIndexOf(".");
    if (dot < 0) continue;
    const name = rest.slice(0, dot);
    const variable = rest.slice(dot + 1).toLowerCase();
    if (!["remote", "merge", "rebase", "pushremote"].includes(variable)) continue;
    let info = byName.get(name);
    if (!info) {
      info = { name, merges: [] };
      byName.set(name, info);
    }
    if (value === undefined) continue;
    if (variable === "remote") {
      if (info.remote !== undefined) messages.push(`warning: more than one ${key}`);
      info.remote = value;
    } else if (variable === "pushremote") {
      if (info.pushRemote !== undefined) messages.push(`warning: more than one ${key}`);
      info.pushRemote = value;
    } else if (variable === "merge") {
      // several branches on one line, separated by spaces
      for (const part of value.split(" ")) info.merges.push(abbrevBranch(part));
    } else {
      const bool = parseGitBool(value);
      if (bool === true) info.rebase = "true";
      else if (bool === false) info.rebase = undefined;
      else if (value === "merges" || value === "m") info.rebase = "merges";
      else if (value === "interactive" || value === "i") info.rebase = "interactive";
      else {
        if (value === "preserve" || value === "p") {
          messages.push(`error: ${value}: 'preserve' superseded by 'merges'`);
        }
        messages.push(`warning: unhandled branch.${name}.rebase=${value}; assuming 'true'`);
        info.rebase = undefined;
      }
    }
  }
  return [...byName.values()].sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * get_head_names: the branch HEAD's symref names, else every branch at HEAD's commit
 * (guess_remote_head with REMOTE_GUESS_HEAD_ALL), short names.
 */
function headNames(refs: readonly TransportRemoteRef[]): string[] {
  const head = refs.find((r) => r.name === "HEAD");
  if (!head) return [];
  const branches = refs.filter((r) => r.name.startsWith("refs/heads/") && !r.name.includes("^"));
  const matches = head.symref
    ? branches.filter((r) => r.name === head.symref)
    : branches.filter((r) => r.oid !== undefined && r.oid === head.oid);
  return matches.map((r) => abbrevBranch(r.name));
}

/**
 * The remote refs a local ref is the tracking ref of (remote_find_tracking /
 * refspec_find_all_matches over the fetch refspecs); undefined when a negative refspec
 * excludes one of them.
 */
export function trackingSources(specs: RefSpec[], refName: string): string[] | undefined {
  const sources: string[] = [];
  for (const spec of specs) {
    if (spec.negative || !spec.source || !spec.destination) continue;
    if (spec.wildcard) {
      if (!matchDestination(spec, refName)) continue;
      const source = expandFromDestination(spec, refName).source;
      if (source) sources.push(source);
    } else if (spec.destination === refName) sources.push(spec.source);
  }
  const negative = specs.filter((s) => s.negative && s.source);
  if (sources.some((src) => negative.some((n) => matchSource(n, src)))) return undefined;
  return sources;
}

/** git's find_ref_by_name_abbrev: the ref `name` names by refname_match's rules, best first. */
function findRefByNameAbbrev(
  refs: readonly TransportRemoteRef[],
  name: string,
): TransportRemoteRef | undefined {
  const rules = [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
  let best: TransportRemoteRef | undefined;
  let bestRule = rules.length;
  for (const ref of refs) {
    const rule = rules.indexOf(ref.name);
    if (rule >= 0 && rule < bestRule) {
      best = ref;
      bestRule = rule;
    }
  }
  return best;
}

/** git's get_local_ref: the local ref a refspec's destination names. */
function localRefName(dst: string | null): string | undefined {
  if (!dst) return undefined;
  if (dst.startsWith("refs/")) return dst;
  if (dst.startsWith("heads/") || dst.startsWith("tags/") || dst.startsWith("remotes/")) {
    return `refs/${dst}`;
  }
  return `refs/heads/${dst}`;
}

/** get_fetch_map's "funny ref": a local ref outside `refs/` or of an invalid name. */
function funnyRef(name: string): boolean {
  return !name.startsWith("refs/") || !isValidRefName(name);
}

/** git's abbrev_branch: `refs/heads/` dropped. */
function abbrevBranch(name: string): string {
  return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBytes(names: string[]): string[] {
  return names.sort(compareBytes);
}
