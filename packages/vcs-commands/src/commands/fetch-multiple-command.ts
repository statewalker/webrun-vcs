import { isSymbolicRef } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorktreeAdmin } from "@statewalker/vcs-working-tree";

import { GitApiError, InvalidArgumentError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { type FetchResult, RefUpdateStatus } from "../results/index.js";
import { TransportCommand } from "../transport-command.js";
import { FetchCommand, TagOption } from "./fetch-command.js";

/** One fetch of a {@link FetchMultipleCommand}: git's child `git fetch <remote>`. */
export interface FetchMultipleEntry {
  remote: string;
  /** The fetch's result, when it did not fail */
  result?: FetchResult;
  /** Why it failed (git's child died) */
  error?: Error;
  /** The child's exit status: 0, 1 for a refused ref or an error it reported, else its death's */
  exitCode: number;
}

/** What {@link FetchMultipleCommand} did. */
export interface FetchMultipleResult {
  /** The remotes fetched, in order */
  remotes: string[];
  fetches: FetchMultipleEntry[];
  /** git's stdout: `Fetching <remote>` per remote (and `--porcelain`'s lines) */
  stdout: string;
  /**
   * git's stderr: each fetch's lines ({@link FetchResult.display}, its messages and errors,
   * or the error it died of), then git's `error: could not fetch <remote>` (one after
   * another) or `could not fetch '<remote>' (exit code: <n>)` (in parallel) for each failure
   */
  stderr: string;
  /** git's exit status: 0, or 1 when a fetch failed */
  exitCode: number;
}

/**
 * Fetch several remotes: `git fetch --all`, `git fetch --multiple <remote|group>...` and
 * `git fetch <group>`.
 *
 * As builtin/fetch.c: the remotes are every configured one without
 * `remote.<name>.skipDefaultUpdate` (or `skipFetchAll`) for {@link setAll}, else each name
 * given expanded as a remote group (`remotes.<group>`, names separated by white space) or a
 * configured remote (`no such remote or remote group` otherwise); repeats in a row are
 * dropped. `FETCH_HEAD` is truncated once, then each remote is fetched as git's child
 * `git fetch --append --no-auto-gc --no-write-commit-graph <options> <remote>` (its reflog
 * lines say so), `Fetching <remote>` printed before each. git runs the children in parallel
 * under `-j`/`fetch.parallel`; ours runs them one after another and prints what git prints
 * then (the children's output in start order, `could not fetch '<remote>' (exit code: <n>)`
 * for a failure). `--all` with one remote, and a single name that is no group, fetch that
 * remote directly, as `git fetch <remote>`.
 *
 * A failed fetch does not stop the others: it is reported in the result (`exitCode` 1), as
 * git exits 1.
 *
 * @example
 * ```typescript
 * const { stdout, stderr, exitCode } = await git.fetchMultiple().setAll(true).call();
 * await git.fetchMultiple().setRemotes("upstream", "mirrors").setPrune(true).call();
 * ```
 */
export class FetchMultipleCommand extends TransportCommand<FetchMultipleResult> {
  private all?: boolean;
  private multiple = true;
  private names: string[] = [];
  private jobs?: number;
  private prune?: boolean;
  private pruneTags?: boolean;
  private tagOption?: TagOption;
  private dryRun = false;
  private force = false;
  private updateHeadOk = false;
  private verbose = false;
  private porcelain = false;
  private writeFetchHead = true;
  private append = false;

  /**
   * Fetch every configured remote (`--all`; false is `--no-all`); left unset, `fetch.all`
   * (git 2.44+) decides when no remote is named.
   */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** The remotes and remote groups to fetch. */
  setRemotes(...names: string[]): this {
    this.checkCallable();
    this.names = [...names];
    return this;
  }

  /**
   * Whether every name is a remote or group (`--multiple`, the default); false reads one
   * name as `git fetch <name>` does: a group of several remotes is fetched as with
   * `--multiple`, anything else as one remote.
   */
  setMultiple(multiple: boolean): this {
    this.checkCallable();
    this.multiple = multiple;
    return this;
  }

  /** `-j <n>`: how many fetches git runs at once (0: one per CPU). */
  setJobs(jobs: number): this {
    this.checkCallable();
    this.jobs = jobs;
    return this;
  }

  /** `--prune` (true) or `--no-prune` (false), passed to each fetch. */
  setPrune(prune: boolean | undefined): this {
    this.checkCallable();
    this.prune = prune;
    return this;
  }

  /** `--prune-tags` (true) or `--no-prune-tags` (false), passed to each fetch. */
  setPruneTags(pruneTags: boolean | undefined): this {
    this.checkCallable();
    this.pruneTags = pruneTags;
    return this;
  }

  /** `--tags` or `--no-tags`, passed to each fetch. */
  setTagOpt(option: TagOption): this {
    this.checkCallable();
    this.tagOption = option;
    return this;
  }

  /** `--dry-run`: nothing written, FETCH_HEAD included. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `--force`, passed to each fetch. */
  setForceUpdate(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `--update-head-ok`, passed to each fetch. */
  setUpdateHeadOk(ok: boolean): this {
    this.checkCallable();
    this.updateHeadOk = ok;
    return this;
  }

  /** `-v`, passed to each fetch. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `--porcelain`: no `Fetching` lines, each fetch's porcelain lines on stdout. */
  setPorcelain(porcelain: boolean): this {
    this.checkCallable();
    this.porcelain = porcelain;
    return this;
  }

  /** `--no-write-fetch-head` (false). */
  setWriteFetchHead(write: boolean): this {
    this.checkCallable();
    this.writeFetchHead = write;
    return this;
  }

  /** `--append`: FETCH_HEAD is not truncated first. */
  setAppend(append: boolean): this {
    this.checkCallable();
    this.append = append;
    return this;
  }

  /**
   * @throws GitApiError (exit 128) as git dies: `fetch --all does not take a repository
   *   argument`, `no such remote or remote group: <name>`, `fetch.parallel cannot be negative`
   */
  async call(): Promise<FetchMultipleResult> {
    this.checkCallable();
    this.setCallable(false);
    const store = RemoteConfigStore.from(this.workingCopy);
    const parallelConfig = store.value("fetch.parallel");
    let configParallel = 1;
    if (parallelConfig !== undefined) {
      configParallel = Number.parseInt(parallelConfig, 10);
      if (configParallel < 0) throw new GitApiError("fatal: fetch.parallel cannot be negative");
      if (configParallel === 0) configParallel = onlineCpus();
    }
    for (const name of this.names) await this.loadLegacyRemote(name);

    let all = this.all;
    if (all === undefined) {
      // fetch.all (git 2.44+): only when no remote is named
      all =
        this.names.length === 0 &&
        this.hooks.compatibility !== "2.43" &&
        parseGitBool(store.value("fetch.all")) === true;
    }
    let list: string[] = [];
    let single: string | undefined;
    if (all) {
      if (this.names.length === 1) {
        throw new GitApiError("fatal: fetch --all does not take a repository argument");
      }
      if (this.names.length > 1) {
        throw new GitApiError("fatal: fetch --all does not make sense with refspecs");
      }
      // get_one_remote_for_fetch
      list = store.configuredNames().filter((name) => !skipsDefaultUpdate(store, name));
      if (list.length === 1) single = list[0];
    } else if (this.names.length === 0) {
      single = await this.defaultRemote(store);
    } else if (this.multiple) {
      for (const name of this.names) {
        if (!addRemoteOrGroup(store, name, list)) {
          throw new GitApiError(`fatal: no such remote or remote group: ${name}`);
        }
      }
    } else {
      if (this.names.length > 1) {
        throw new InvalidArgumentError(
          "remotes",
          this.names,
          "only one remote or group without --multiple (the rest would be refspecs)",
        );
      }
      addRemoteOrGroup(store, this.names[0] as string, list);
      if (list.length <= 1) single = this.names[0];
    }
    // string_list_remove_duplicates: repeats in a row
    list = list.filter((name, i) => i === 0 || list[i - 1] !== name);

    if (single !== undefined) {
      const entry = await this.fetchOne(single, false, this.commandLine());
      return {
        remotes: [single],
        fetches: [entry],
        stdout: this.porcelain ? linesOf(entry.result?.display) : "",
        stderr: stderrOf(entry, this.porcelain),
        exitCode: entry.exitCode === 0 ? 0 : 1,
      };
    }

    // fetch_multiple: FETCH_HEAD truncated once, each child appends
    if (!this.append && this.writeFetchHead && !this.dryRun) {
      const checkout =
        "checkout" in this._workingCopy
          ? this._workingCopy.checkout
          : (this._workingCopy as Partial<Pick<WorktreeAdmin, "bareRepository">>).bareRepository;
      await checkout?.writeFetchHead?.("");
    }
    const jobs =
      this.jobs === undefined ? configParallel : this.jobs === 0 ? onlineCpus() : this.jobs;
    const parallel = jobs !== 1 && list.length !== 1;
    const childArgs = [
      "fetch",
      "--append",
      "--no-auto-gc",
      "--no-write-commit-graph",
      ...this.optionArgs(),
      ...(parallel ? ["--end-of-options"] : []),
    ];
    let stdout = "";
    let stderr = "";
    let failed = false;
    const fetches: FetchMultipleEntry[] = [];
    // git's parallel runner prints every `Fetching` line as it starts a child; ours starts
    // them one at a time, which prints the same stdout (the children's output is in stderr)
    for (const name of list) {
      if (!this.porcelain) stdout += `Fetching ${name}\n`;
      const entry = await this.fetchOne(name, true, [...childArgs, name].join(" "));
      fetches.push(entry);
      if (this.porcelain) stdout += linesOf(entry.result?.display);
      stderr += stderrOf(entry, this.porcelain);
      if (entry.exitCode !== 0) {
        failed = true;
        stderr += parallel
          ? `could not fetch '${name}' (exit code: ${entry.exitCode})\n`
          : `error: could not fetch ${name}\n`;
      }
    }
    return { remotes: list, fetches, stdout, stderr, exitCode: failed ? 1 : 0 };
  }

  /** One `git fetch <remote>`: as a child of fetch_multiple (`append`), or fetch_one. */
  private async fetchOne(
    remote: string,
    append: boolean,
    reflogAction: string,
  ): Promise<FetchMultipleEntry> {
    const fetch = this.configureChild(new FetchCommand(this._workingCopy));
    fetch.setRemote(remote);
    if (append || this.append) fetch.setAppend(true);
    if (append) fetch.setWriteCommitGraph(false);
    if (this.prune !== undefined) fetch.setRemoveDeletedRefs(this.prune);
    if (this.pruneTags !== undefined) fetch.setPruneTags(this.pruneTags);
    if (this.tagOption !== undefined) fetch.setTagOpt(this.tagOption);
    if (this.dryRun) fetch.setDryRun(true);
    if (this.force) fetch.setForceUpdate(true);
    if (this.updateHeadOk) fetch.setUpdateHeadOk(true);
    if (this.verbose) fetch.setVerbose(true);
    if (this.porcelain) fetch.setPorcelain(true);
    if (!this.writeFetchHead) fetch.setWriteFetchHead(false);
    fetch.setReflogAction(this.hasReflogAction() && !append ? this.reflogAction("") : reflogAction);
    try {
      const result = await fetch.call();
      const refused =
        result.trackingRefUpdates.some(
          (u) => u.status === RefUpdateStatus.REJECTED || u.status === RefUpdateStatus.LOCK_FAILURE,
        ) || (result.errors?.length ?? 0) > 0;
      return { remote, result, exitCode: refused ? 1 : 0 };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const exitCode = (err as Partial<GitApiError>).exitCode;
      return { remote, error: err, exitCode: typeof exitCode === "number" ? exitCode : 128 };
    }
  }

  /** git's add_options_to_argv, in its order. */
  private optionArgs(): string[] {
    return [
      ...(this.dryRun ? ["--dry-run"] : []),
      ...(this.prune === undefined ? [] : [this.prune ? "--prune" : "--no-prune"]),
      ...(this.pruneTags === undefined
        ? []
        : [this.pruneTags ? "--prune-tags" : "--no-prune-tags"]),
      ...(this.updateHeadOk ? ["--update-head-ok"] : []),
      ...(this.force ? ["--force"] : []),
      ...(this.tagOption === TagOption.FETCH_TAGS ? ["--tags"] : []),
      ...(this.tagOption === TagOption.NO_TAGS ? ["--no-tags"] : []),
      ...(this.verbose ? ["-v"] : []),
      ...(this.writeFetchHead ? [] : ["--no-write-fetch-head"]),
      ...(this.porcelain ? ["--porcelain"] : []),
    ];
  }

  /** The `git fetch` command line this command stands for (fetch_one's reflog action). */
  private commandLine(): string {
    return [
      "fetch",
      ...this.optionArgs(),
      ...(this.append ? ["--append"] : []),
      ...(this.jobs !== undefined ? [`--jobs=${this.jobs}`] : []),
      ...(this.all ? ["--all"] : []),
      ...(this.multiple && this.names.length > 0 ? ["--multiple"] : []),
      ...this.names,
    ].join(" ");
  }

  /** remote_get(NULL): the current branch's remote, the one configured remote, `origin`. */
  private async defaultRemote(store: RemoteConfigStore): Promise<string> {
    const head = await this.refsStore.get("HEAD");
    const branch =
      head && isSymbolicRef(head) && head.target.startsWith("refs/heads/")
        ? head.target.slice("refs/heads/".length)
        : undefined;
    return store.remoteForBranch(branch);
  }
}

/** `remote.<name>.skipDefaultUpdate` / `skipFetchAll`: the last of either set wins. */
function skipsDefaultUpdate(store: RemoteConfigStore, name: string): boolean {
  const value = store.lastValueOf([
    `remote.${name}.skipDefaultUpdate`,
    `remote.${name}.skipFetchAll`,
  ]);
  return value !== undefined && parseGitBool(value) === true;
}

/**
 * remote.c's add_remote_or_group: the remotes of `remotes.<name>` (each value split at white
 * space, in config order), else the remote itself when configured; false when neither.
 */
export function addRemoteOrGroup(store: RemoteConfigStore, name: string, list: string[]): boolean {
  const before = list.length;
  for (const value of store.values(`remotes.${name}`)) {
    for (const word of value.split(/[ \t\n]/)) if (word.length > 0) list.push(word);
  }
  if (list.length === before) {
    if (!store.isConfigured(name)) return false;
    list.push(name);
  }
  return true;
}

/** git's online_cpus. */
function onlineCpus(): number {
  const cpus = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return typeof cpus === "number" && cpus > 0 ? cpus : 1;
}

function linesOf(lines: readonly string[] | undefined): string {
  return lines && lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** What one fetch wrote on stderr: its ref lines, messages and errors, or its death. */
function stderrOf(entry: FetchMultipleEntry, porcelain: boolean): string {
  if (entry.error) return linesOf([entry.error.message]);
  const result = entry.result;
  if (!result) return "";
  return linesOf([
    ...(porcelain ? [] : (result.display ?? [])),
    ...result.messages,
    ...(result.errors ?? []).map((e) =>
      e.startsWith("error: ") || e.startsWith("fatal: ") ? e : `error: ${e}`,
    ),
  ]);
}

/**
 * Fetch a remote group, or every remote: `git remote update [-p] [<group>|<remote>...]`.
 *
 * As builtin/remote.c `update`: git runs `git fetch [--prune|--no-prune] [-v] --multiple
 * <names>` ({@link FetchMultipleCommand}); without names the group `default` when
 * `remotes.default` is configured, else every remote without
 * `remote.<name>.skipDefaultUpdate` (`--all`). git exits 1 for any failure of the fetch,
 * `no such remote or remote group` included, which is reported in the result here too.
 *
 * @example
 * ```typescript
 * const { stdout, stderr, exitCode } = await git.remoteUpdate().setPrune(true).call();
 * await git.remoteUpdate().setGroups("mirrors").call();
 * ```
 */
export class RemoteUpdateCommand extends TransportCommand<FetchMultipleResult> {
  /** git's command reads no core settings: an unparsable `core.whitespace` does not stop it */
  protected override readsCoreConfig(): boolean {
    return false;
  }

  private groups: string[] = [];
  private prune?: boolean;
  private verbose = false;

  /** The remote groups and remotes to fetch; none: `default`, else every remote. */
  setGroups(...groups: string[]): this {
    this.checkCallable();
    this.groups = [...groups];
    return this;
  }

  /** `-p`/`--prune` (true) or `--no-prune` (false), passed to the fetch. */
  setPrune(prune: boolean | undefined): this {
    this.checkCallable();
    this.prune = prune;
    return this;
  }

  /** `git remote -v update`: `-v` passed to the fetch. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  async call(): Promise<FetchMultipleResult> {
    this.checkCallable();
    this.setCallable(false);
    const store = RemoteConfigStore.from(this.workingCopy);
    const names = this.groups.length > 0 ? [...this.groups] : ["default"];
    // get_remote_default: without remotes.default, `default` is --all
    const all = names.at(-1) === "default" && store.values("remotes.default").length === 0;
    if (all) names.pop();
    const args = [
      "fetch",
      ...(this.prune === undefined ? [] : [this.prune ? "--prune" : "--no-prune"]),
      ...(this.verbose ? ["-v"] : []),
      "--multiple",
      ...names,
      ...(all ? ["--all"] : []),
    ];
    const fetch = this.configureChild(new FetchMultipleCommand(this._workingCopy));
    fetch
      .setRemotes(...names)
      .setMultiple(true)
      .setReflogAction(args.join(" "));
    if (all) fetch.setAll(true);
    if (this.prune !== undefined) fetch.setPrune(this.prune);
    if (this.verbose) fetch.setVerbose(true);
    try {
      const result = await fetch.call();
      return result;
    } catch (error) {
      // the child git fetch died: git remote update exits 1
      if (error instanceof GitApiError) {
        return {
          remotes: [],
          fetches: [],
          stdout: "",
          stderr: `${error.message}\n`,
          exitCode: 1,
        };
      }
      throw error;
    }
  }
}
