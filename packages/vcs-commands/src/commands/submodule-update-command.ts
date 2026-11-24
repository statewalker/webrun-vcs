/**
 * `git submodule update` and `git submodule status` (builtin/submodule--helper.c
 * `module_update`, `update_submodules`, `prepare_to_clone_next_submodule`, `update_submodule`,
 * `run_update_procedure`, `run_update_command`; `module_status`, `status_submodule`,
 * `compute_rev_name`), over the submodule model of `submodule-model.ts`, the clone, fetch,
 * checkout, merge and rebase commands.
 */
import type { ObjectId } from "@statewalker/vcs-core";
import type { Credentials, GitTransportRegistry } from "@statewalker/vcs-transport";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { CheckoutCommand } from "./checkout-command.js";
import { createIdAbbreviator } from "./core-config.js";
import { DiffCommand } from "./diff-command.js";
import { FetchCommand } from "./fetch-command.js";
import { createDescriber } from "./git-describe.js";
import { commonGitFileOf, hookRunnerOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { MergeCommand } from "./merge-command.js";
import { nameRevByTags } from "./name-rev.js";
import { RebaseCommand } from "./rebase-command.js";
import {
  notFromUser,
  SUBMODULE_UNSET_ENV,
  SubmoduleCommandBase,
  SubmoduleCommandError,
  type SubmoduleCommandResult,
  SubmoduleInitCommand,
  type SubmoduleListEntry,
} from "./submodule-commands.js";
import {
  joinFilesPath,
  openConfigFile,
  parseSubmoduleUpdateStrategy,
  relativeFilesPath,
  resolveRelativeUrl,
  type SubmoduleSettings,
  type SubmoduleUpdateStrategy,
  setInConfigFile,
  worktreeHostPath,
} from "./submodule-model.js";

/** The update strategies `submodule update` takes on its command line. */
export type SubmoduleUpdateMode = "checkout" | "merge" | "rebase";

/** A submodule `update_submodules` goes on with (git's `update_clone_data`). */
interface UpdateRecord {
  sub: SubmoduleSettings;
  path: string;
  id: ObjectId;
  justCloned: boolean;
}

/**
 * Questions asked inside a submodule's repository, as git's child processes ask them:
 * `rev-list -n 1 <id> --not --all`, a ref's value, `describe` for `submodule status`.
 */
class SubmoduleRepository extends GitCommand<never> {
  async call(): Promise<never> {
    throw new Error("not callable");
  }

  /** submodule--helper.c's `is_tip_reachable`: `id` exists and a ref (or HEAD) reaches it. */
  async isTipReachable(id: ObjectId): Promise<boolean> {
    if (!(await this.loadCommit(id))) return false;
    const tips: ObjectId[] = [];
    const head = await this.refsStore.resolve("HEAD").catch(() => undefined);
    if (head?.objectId) tips.push(head.objectId);
    for await (const ref of this.refsStore.list("refs/")) {
      const direct = ref as { objectId?: ObjectId; target?: string };
      const value =
        direct.objectId && direct.target === undefined
          ? direct.objectId
          : (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (value) tips.push(value);
    }
    const seen = new Set<ObjectId>();
    const queue: ObjectId[] = [];
    for (const tip of tips) queue.push(await this.peel(tip));
    while (queue.length > 0) {
      const oid = queue.pop() as ObjectId;
      if (oid === id) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = await this.loadCommit(oid);
      for (const parent of commit?.parents ?? []) if (!seen.has(parent)) queue.push(parent);
    }
    return false;
  }

  /** The id a full ref name holds, undefined when it has none. */
  async refValue(name: string): Promise<ObjectId | undefined> {
    return (await this.refsStore.resolve(name).catch(() => undefined))?.objectId;
  }

  /** The short name of HEAD's branch (`refs/heads/x`), undefined when detached. */
  async currentBranch(): Promise<string | undefined> {
    const ref = await this.getCurrentBranch().catch(() => undefined);
    return ref?.startsWith("refs/") ? ref : undefined;
  }

  /**
   * submodule--helper.c's `compute_rev_name`: `describe`, `describe --tags`, `describe
   * --contains`, then `describe --all --always`, the first that answers.
   */
  async revName(id: ObjectId): Promise<string | undefined> {
    // a missing commit: `describe --contains` (name-rev) skips it and succeeds, printing nothing
    if (!(await this.loadCommit(id))) return "";
    const abbreviator = createIdAbbreviator(this._workingCopy);
    const tags = this.tagsStore;
    const source = {
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      commits: this.commits,
    };
    const describe = createDescriber({
      ...source,
      abbreviate: async (oid, length) => {
        if (length === 0) return oid;
        const lengths = await abbreviator.lengths([oid], length);
        return oid.slice(0, lengths.get(oid) ?? 7);
      },
    });
    const plain = await describe(id, {}).catch(() => "");
    if (plain) return plain;
    const lightweight = await describe(id, { tags: true }).catch(() => "");
    if (lightweight) return lightweight;
    const contains = await nameRevByTags(source, id).catch(() => undefined);
    if (contains) return contains;
    return (await describe(id, { all: true, always: true }).catch(() => "")) || undefined;
  }

  private async loadCommit(id: ObjectId) {
    return this.commits.load(id).catch(() => undefined);
  }

  /** The commits a rebase of `head` onto `upstream` picks: non-merges `upstream..head`. */
  async countPicks(upstream: ObjectId, head: ObjectId): Promise<number> {
    const below = new Set<ObjectId>();
    const stack: ObjectId[] = [upstream];
    while (stack.length > 0) {
      const oid = stack.pop() as ObjectId;
      if (below.has(oid)) continue;
      below.add(oid);
      for (const p of (await this.loadCommit(oid))?.parents ?? []) stack.push(p);
    }
    let count = 0;
    const seen = new Set<ObjectId>();
    stack.push(head);
    while (stack.length > 0) {
      const oid = stack.pop() as ObjectId;
      if (seen.has(oid) || below.has(oid)) continue;
      seen.add(oid);
      const parents = (await this.loadCommit(oid))?.parents ?? [];
      if (parents.length < 2) count++;
      stack.push(...parents);
    }
    return count;
  }

  private async peel(id: ObjectId): Promise<ObjectId> {
    let oid = id;
    const tags = this.tagsStore;
    for (let depth = 0; depth < 32 && tags && (await tags.has(oid).catch(() => false)); depth++) {
      const tag = await tags.load(oid).catch(() => undefined);
      if (!tag) break;
      oid = tag.object;
    }
    return oid;
  }
}

const NULL_ID_CHAR = "0";

/**
 * `git submodule update [--init] [--remote] [-N] [-f] [--checkout|--merge|--rebase]
 * [--recursive] [--depth <n>] [--[no-]recommend-shallow] [--reference <repo>] [<path>...]`:
 * each active submodule of the index (matching the paths) brought to the commit the index
 * records. One not yet cloned is cloned into `.git/modules/<name>` first (or its kept git
 * directory reconnected), and is then checked out detached at that commit; one already there
 * is updated by its strategy (the command line's, else `submodule.<name>.update` of the
 * configuration, else of `.gitmodules`, else `checkout`): `checkout -q` (`-f` when just
 * cloned or forced), `rebase`, `merge`, `none` (skipped) or, from the configuration only,
 * `!<command>` run through the host's command runner with the commit appended. A commit the
 * submodule lacks is fetched first (`fetch`, then `fetch <remote> <commit>`).
 *
 * `--remote` takes the commit from the submodule's remote-tracking branch instead
 * (`submodule.<name>.branch`, `.` for the superproject's branch, default `HEAD`), fetched
 * first unless `--no-fetch`. `--init` runs `submodule init` first; `--recursive` goes on in
 * each submodule's own submodules. Fetches and clones go through the transports and
 * credentials given here.
 *
 * Output, refusals and the exit status are git's (stdout, stderr); where git returns 128
 * the command throws {@link SubmoduleCommandError}.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.submoduleUpdate().setInit(true).setRecursive(true).call();
 * // "Submodule path 'lib': checked out '1a2b...'\n"
 * ```
 */
export class SubmoduleUpdateCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];
  private init = false;
  private remote = false;
  private recursive = false;
  private noFetch = false;
  private force = false;
  private mode?: SubmoduleUpdateMode;
  private depth = 0;
  private recommendShallow?: boolean;
  private references: string[] = [];
  private requireInit = false;
  private transports?: GitTransportRegistry;
  private credentials?: Credentials;
  private headers?: Record<string, string>;
  private timeout?: number;

  /** A path (pathspec element) limiting the submodules; uninitialized ones are then reported. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--init`: `submodule init` the submodules first. */
  setInit(init: boolean): this {
    this.checkCallable();
    this.init = init;
    return this;
  }

  /** `--require-init`: `--init`, refusing to clone into a non-empty directory. */
  setRequireInit(requireInit: boolean): this {
    this.checkCallable();
    this.requireInit = requireInit;
    return this;
  }

  /** `--remote`: the commit of the submodule's remote-tracking branch. */
  setRemote(remote: boolean): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /** `--recursive`: nested submodules too. */
  setRecursive(recursive: boolean): this {
    this.checkCallable();
    this.recursive = recursive;
    return this;
  }

  /** `-N` / `--no-fetch`: never fetch. */
  setNoFetch(noFetch: boolean): this {
    this.checkCallable();
    this.noFetch = noFetch;
    return this;
  }

  /** `-f`: run the update even at the recorded commit; checkout with `-f`. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `--checkout`, `--merge` or `--rebase`: the strategy for every submodule. */
  setMode(mode: SubmoduleUpdateMode | undefined): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  /** `--depth <n>`: shallow clones and fetches. */
  setDepth(depth: number): this {
    this.checkCallable();
    this.depth = depth;
    return this;
  }

  /**
   * `--[no-]recommend-shallow`: whether a clone honours `submodule.<name>.shallow` (depth 1);
   * by default it does.
   */
  setRecommendShallow(recommend: boolean): this {
    this.checkCallable();
    this.recommendShallow = recommend;
    return this;
  }

  /** `--reference <repository>`: borrow objects in clones. */
  addReference(reference: string): this {
    this.checkCallable();
    this.references.push(reference);
    return this;
  }

  /** The transports clones and fetches reach non-local URLs through. */
  setTransports(transports: GitTransportRegistry): this {
    this.checkCallable();
    this.transports = transports;
    return this;
  }

  /** The credentials clones and fetches authenticate with. */
  setCredentials(credentials: Credentials): this {
    this.checkCallable();
    this.credentials = credentials;
    return this;
  }

  /** HTTP headers of clones and fetches. */
  setHeaders(headers: Record<string, string>): this {
    this.checkCallable();
    this.headers = headers;
    return this;
  }

  /** The timeout of clones and fetches, in milliseconds. */
  setTimeout(timeout: number): this {
    this.checkCallable();
    this.timeout = timeout;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    if (this.requireInit) this.init = true;
    const list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    if (this.init) await this.runInit();
    const records = await this.cloneAll(list);
    if (!records) {
      this.out.exitCode = 1;
      return this.finish();
    }
    for (const record of records) {
      const code = await this.updateRecord(record);
      if (code === 0) continue;
      this.out.exitCode = code;
      if (code === 128) break;
    }
    if (this.out.exitCode === 128) this.dieWithLastLine();
    return this.finish();
  }

  /** git returned 128 after its `fatal:` line: thrown as git's death, that line the message. */
  private dieWithLastLine(): never {
    const text = this.out.stderr.replace(/\n$/, "");
    const at = text.lastIndexOf("\n");
    this.out.stderr = at < 0 ? "" : `${text.slice(0, at)}\n`;
    this.die(at < 0 ? text : text.slice(at + 1));
  }

  /** `module_update`'s `--init`: `submodule init` of the same paths. */
  private async runInit(): Promise<void> {
    const init = new SubmoduleInitCommand(this.workingCopy)
      .setQuiet(this.quiet)
      .setCompatibility(this.compatibility)
      .setSuperPrefix(this.superPrefix);
    for (const path of this.paths) init.addPath(path);
    try {
      this.append(await init.call());
    } catch (error) {
      if (!(error instanceof SubmoduleCommandError)) throw error;
      this.append(error.result);
      this.die(error.message);
    }
    this.forgetModel();
    this.modelWarningsShown = true;
  }

  private warnMissing(displayPath: string): void {
    if (this.paths.length === 0) return;
    this.out.stderr += `Submodule path '${displayPath}' not initialized\nMaybe you want to use 'update --init'?\n`;
  }

  /**
   * `update_submodules`' clone pass: each submodule looked at (`prepare_to_clone_next_submodule`),
   * those without a `.git` cloned; a failed clone retried once after the others, undefined
   * when it fails again (git's quickstop).
   */
  private async cloneAll(list: SubmoduleListEntry[]): Promise<UpdateRecord[] | undefined> {
    const records: UpdateRecord[] = [];
    const failed: { record: UpdateRecord; url: string }[] = [];
    for (const entry of list) {
      const prepared = await this.prepare(entry);
      if (!prepared) continue;
      records.push(prepared.record);
      if (!prepared.record.justCloned) continue;
      if (!(await this.clone(prepared.record, prepared.url))) {
        this.out.stderr += `Failed to clone '${entry.path}'. Retry scheduled\n`;
        failed.push(prepared);
      }
    }
    for (const { record, url } of failed) {
      if (!(await this.clone(record, url))) {
        this.out.stderr += `Failed to clone '${record.path}' a second time, aborting\n`;
        return undefined;
      }
    }
    return records;
  }

  /** git's `prepare_to_clone_next_submodule`: the record and URL, undefined when skipped. */
  private async prepare(
    entry: SubmoduleListEntry,
  ): Promise<{ record: UpdateRecord; url: string } | undefined> {
    const dp = this.displayPath(entry.path);
    if (entry.stage) {
      this.out.stderr += `Skipping unmerged submodule ${dp}\n`;
      return undefined;
    }
    const model = await this.model();
    const sub = model.fromPath(entry.path);
    if (!sub) {
      this.warnMissing(dp);
      return undefined;
    }
    const configured = model.configText(`submodule.${sub.name}.update`);
    const type =
      typeof configured === "string"
        ? parseSubmoduleUpdateStrategy(configured)?.type
        : sub.update?.type;
    if (this.mode === undefined && type === "none") {
      this.out.stderr += `Skipping submodule '${dp}'\n`;
      return undefined;
    }
    if (!model.isActive(entry.path)) {
      this.warnMissing(dp);
      return undefined;
    }
    let url = model.configText(`submodule.${sub.name}.url`) ?? undefined;
    if (url === undefined && sub.url !== undefined) {
      if (/^\.\.?\//.test(sub.url)) {
        const warnings: string[] = [];
        url = await resolveRelativeUrl(this.workingCopy, sub.url, undefined, { warnings });
        for (const w of warnings) this.out.stderr += `${w}\n`;
      } else url = sub.url;
    }
    if (url === undefined) this.die(`fatal: cannot clone submodule '${sub.name}' without a URL`);
    const path = sub.path ?? entry.path;
    const justCloned = (await this.kindOf(`${entry.path}/.git`)) === undefined;
    return { record: { sub, path, id: entry.id, justCloned }, url };
  }

  /** submodule--helper's `clone` child: false when it failed (its lines printed). */
  private async clone(record: UpdateRecord, url: string): Promise<boolean> {
    const { sub, path } = record;
    try {
      await this.validatePath(path);
      const model = await this.model();
      let gitDir: string | undefined;
      try {
        gitDir = await model.gitDirOf(sub.name);
      } catch (error) {
        if (error instanceof GitApiError) this.die(error.message);
        throw error;
      }
      if (gitDir === undefined) this.die("fatal: no git directory to keep the submodule in");
      const common = await commonGitFileOf(this.workingCopy, "modules");
      const files = this.worktreeAccess?.getFiles?.();
      const gitFiles = common?.files ?? files;
      if (!gitFiles) this.die("fatal: no worktree to clone a submodule into");
      const kept = (await gitFiles.stats(gitDir).catch(() => undefined)) !== undefined;
      const depth =
        this.recommendShallow !== false && sub.shallow === true ? 1 : this.depth || undefined;
      await this.cloneSubmodule(path, url, gitDir, gitFiles, kept, {
        ...(depth !== undefined ? { depth } : {}),
        references: this.references,
        requireInit: this.requireInit,
        ...(this.transports ? { transports: this.transports } : {}),
        ...(this.credentials ? { credentials: this.credentials } : {}),
        ...(this.headers ? { headers: this.headers } : {}),
        ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
      });
      return true;
    } catch (error) {
      if (!(error instanceof SubmoduleCommandError)) throw error;
      this.out.stderr += `${error.message}\n`;
      return false;
    }
  }

  /** The submodule's working copy, opened as git-submodule.sh runs its children. */
  private async openInner(path: string): Promise<WorkingCopy | undefined> {
    const environment = hostEnvironmentOf(this.workingCopy);
    return this.worktreeAccess
      ?.openGitlink?.(path, {
        environment: notFromUser(environment ?? { readFile: async () => undefined }),
      })
      .catch(() => undefined);
  }

  /** submodule--helper.c's `ensure_core_worktree`. */
  private async ensureCoreWorktree(path: string): Promise<void> {
    const gitDir = await this.worktreeAccess?.gitlinkRepository?.(path).catch(() => undefined);
    if (!gitDir) return;
    const config = await openConfigFile(this.workingCopy, `${gitDir}/config`).catch(
      () => undefined,
    );
    if (!config || config.getLocal("core.worktree").length === 0) return;
    const relative = relativeFilesPath(gitDir, this.filesPath(path));
    await setInConfigFile(this.workingCopy, `${gitDir}/config`, "core.worktree", relative);
  }

  /** `update_submodules`' second pass for one submodule: its exit code (0 when done). */
  private async updateRecord(record: UpdateRecord): Promise<number> {
    const { path, sub } = record;
    await this.validatePath(path);
    await this.ensureCoreWorktree(path);
    const dp = this.displayPath(path);
    const model = await this.model();

    // determine_submodule_update_strategy
    let strategy: SubmoduleUpdateStrategy;
    if (this.mode) strategy = { type: this.mode };
    else {
      const configured = model.configText(`submodule.${sub.name}.update`);
      if (typeof configured === "string") {
        const parsed = parseSubmoduleUpdateStrategy(configured);
        if (!parsed) {
          return this.fatal(
            `Invalid update mode '${configured}' configured for submodule path '${path}'`,
          );
        }
        strategy = parsed;
      } else strategy = sub.update ?? { type: "checkout" };
    }
    if (
      record.justCloned &&
      (strategy.type === "merge" || strategy.type === "rebase" || strategy.type === "none")
    ) {
      strategy = { type: "checkout" };
    }

    let subId: ObjectId | undefined;
    if (!record.justCloned) {
      subId = await this.worktreeAccess?.readGitlinkHead?.(path).catch(() => undefined);
      if (subId === undefined) {
        return this.fatal(`Unable to find current revision in submodule path '${dp}'`);
      }
    }
    const inner = await this.openInner(path);
    if (!inner) {
      return this.fatal(`could not get a repository handle for submodule '${path}'`);
    }
    let id = record.id;

    if (this.remote) {
      const remoteName = await this.defaultRemoteOfSubmodule(sub, inner);
      const branch = await this.remoteBranch(sub);
      if (typeof branch === "number") return branch;
      const remoteRef = `refs/remotes/${remoteName}/${branch}`;
      if (!this.noFetch && !(await this.fetchIn(inner, false))) {
        return this.fatal(`Unable to fetch in submodule path '${path}'`);
      }
      const value = await new SubmoduleRepository(inner).refValue(remoteRef);
      if (value === undefined) {
        return this.fatal(`Unable to find ${remoteRef} revision in submodule path '${path}'`);
      }
      id = value;
    }

    if (id !== subId || this.force) {
      const code = await this.runUpdateProcedure(inner, sub, strategy, id, subId, dp);
      if (code) return code;
    }

    if (this.recursive) return this.recurse(inner, dp);
    return 0;
  }

  /** die_message: git's `fatal:` line printed, 128 returned. */
  private fatal(message: string): number {
    this.out.stderr += `fatal: ${message}\n`;
    return 128;
  }

  /** submodule--helper.c's `remote_submodule_branch`: the branch, or an exit code. */
  private async remoteBranch(sub: SubmoduleSettings): Promise<string | number> {
    const model = await this.model();
    const branch = model.branch(sub.name);
    if (branch === undefined) return "HEAD";
    if (branch !== ".") return branch;
    const head = await this.refsStore.get("HEAD").catch(() => undefined);
    const target = head && "target" in head ? (head.target as string | undefined) : undefined;
    if (!head) return this.fatal("No such ref: HEAD");
    if (!target) {
      return this.fatal(
        `Submodule (${sub.name}) branch configured to inherit branch from superproject, but the superproject is not on any branch`,
      );
    }
    if (!target.startsWith("refs/heads/")) {
      return this.fatal(`Expecting a full ref name, got ${target}`);
    }
    return target.slice("refs/heads/".length);
  }

  /** submodule--helper.c's `fetch_in_submodule`: `git fetch [--quiet] [--depth] [<remote> <id>]`. */
  private async fetchIn(
    inner: WorkingCopy,
    quiet: boolean,
    target?: { remote: string; id: ObjectId },
  ): Promise<boolean> {
    const fetch = new FetchCommand(inner);
    if (this.transports) fetch.setTransports(this.transports);
    if (this.credentials) fetch.setCredentials(this.credentials);
    if (this.headers) fetch.setHeaders(this.headers);
    if (this.timeout !== undefined) fetch.setTimeout(this.timeout);
    if (this.depth) fetch.setDepth(this.depth);
    if (target) fetch.setRemote(target.remote).setRefSpecs(target.id);
    try {
      const result = await fetch.call();
      if (!quiet) {
        for (const line of [...(result.display ?? []), ...result.messages]) {
          this.out.stderr += `${line.replace(/\n$/, "")}\n`;
        }
      }
      for (const line of result.errors ?? []) this.out.stderr += `${line.replace(/\n$/, "")}\n`;
      return (result.errors ?? []).length === 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.out.stderr += `${error.message.replace(/\n$/, "")}\n`;
      return false;
    }
  }

  /** submodule--helper.c's `run_update_procedure`. */
  private async runUpdateProcedure(
    inner: WorkingCopy,
    sub: SubmoduleSettings,
    strategy: SubmoduleUpdateStrategy,
    id: ObjectId,
    subId: ObjectId | undefined,
    dp: string,
  ): Promise<number> {
    const subforce = subId === undefined || this.force;
    if (!this.noFetch) {
      const reachable = () => new SubmoduleRepository(inner).isTipReachable(id);
      if (!(await reachable()) && !(await this.fetchIn(inner, this.quiet)) && !this.quiet) {
        this.out.stderr += `Unable to fetch in submodule path '${dp}'; trying to directly fetch ${id}:\n`;
      }
      if (!(await reachable())) {
        const remote = await this.defaultRemoteOfSubmodule(sub, inner);
        if (!(await this.fetchIn(inner, this.quiet, { remote, id }))) {
          return this.fatal(
            `Fetched in submodule path '${dp}', but it did not contain ${id}. Direct fetching of that commit failed.`,
          );
        }
      }
    }
    return this.runUpdateCommand(inner, strategy, id, subforce, dp);
  }

  /** submodule--helper.c's `run_update_command`. */
  private async runUpdateCommand(
    inner: WorkingCopy,
    strategy: SubmoduleUpdateStrategy,
    id: ObjectId,
    subforce: boolean,
    dp: string,
  ): Promise<number> {
    let done: string;
    switch (strategy.type) {
      case "checkout": {
        try {
          const result = await new CheckoutCommand(inner)
            .setName(id)
            .setQuiet(true)
            .setForced(subforce)
            .call();
          for (const w of result.warnings ?? []) this.out.stderr += `${w}\n`;
        } catch (error) {
          if (!(error instanceof GitApiError)) throw error;
          this.out.stderr += `${error.message}\n`;
          this.out.stderr += `fatal: Unable to checkout '${id}' in submodule path '${dp}'\n`;
          return error.exitCode || 1;
        }
        done = `checked out '${id}'`;
        break;
      }
      case "rebase": {
        if (!(await this.rebase(inner, id))) {
          return this.fatal(`Unable to rebase '${id}' in submodule path '${dp}'`);
        }
        done = `rebased into '${id}'`;
        break;
      }
      case "merge": {
        if (!(await this.merge(inner, id))) {
          return this.fatal(`Unable to merge '${id}' in submodule path '${dp}'`);
        }
        done = `merged in '${id}'`;
        break;
      }
      case "command": {
        const command = strategy.command ?? "";
        if (!(await this.runCommand(inner, command, id))) {
          return this.fatal(`Execution of '${command} ${id}' failed in submodule path '${dp}'`);
        }
        done = `'${command} ${id}'`;
        break;
      }
      default:
        return 0;
    }
    if (!this.quiet) this.out.stdout += `Submodule path '${dp}': ${done}\n`;
    return 0;
  }

  /** `git rebase [--quiet] <id>` in the submodule. */
  private async rebase(inner: WorkingCopy, id: ObjectId): Promise<boolean> {
    const repository = new SubmoduleRepository(inner);
    const branch = await repository.currentBranch();
    const before = await repository.refValue("HEAD");
    const picks = before ? await repository.countPicks(id, before) : 0;
    let result: Awaited<ReturnType<RebaseCommand["call"]>>;
    try {
      result = await new RebaseCommand(inner).setUpstream(id).call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      this.out.stderr += `${error.message}\n`;
      return false;
    }
    const ok = ["ok", "fast-forward", "up-to-date"].includes(result.status);
    if (!this.quiet || !ok) {
      for (const line of result.output ?? []) this.out.stdout += `${line}\n`;
    }
    if (result.message) this.out.stderr += `${result.message.replace(/\n$/, "")}\n`;
    if (ok && result.status !== "up-to-date" && !this.quiet) {
      // the sequencer's progress, then term_clear_line (2.43 clears a dumb terminal's line
      // even when stderr is no terminal; 2.5x only on a terminal)
      if (result.status === "ok") {
        for (let i = 1; i <= picks; i++) this.out.stderr += `Rebasing (${i}/${picks})\r`;
      }
      if (this.compatibility === "2.43") this.out.stderr += `\r${" ".repeat(80)}\r`;
      this.out.stderr += `Successfully rebased and updated ${branch ?? "detached HEAD"}.\n`;
    }
    return ok;
  }

  /** `git merge [--quiet] <id>` in the submodule: its stdout, the diffstat included. */
  private async merge(inner: WorkingCopy, id: ObjectId): Promise<boolean> {
    const before = await new SubmoduleRepository(inner).refValue("HEAD");
    let result: Awaited<ReturnType<MergeCommand["call"]>>;
    try {
      result = await new MergeCommand(inner).include(id).call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      this.out.stderr += `${error.message}\n`;
      return false;
    }
    const ok = ["fast-forward", "already-up-to-date", "merged"].includes(result.status);
    if (!this.quiet) {
      for (const line of result.output ?? []) this.out.stdout += `${line}\n`;
      if (result.status === "already-up-to-date" && (result.output ?? []).length === 0) {
        this.out.stdout += "Already up to date.\n";
      }
      if ((result.status === "fast-forward" || result.status === "merged") && before) {
        this.out.stdout += await this.diffstat(inner, before, result.newHead ?? id);
      }
    }
    if (!ok && result.message) this.out.stderr += `${result.message.replace(/\n$/, "")}\n`;
    return ok;
  }

  /** `git diff --stat --summary <from> <to>`, as git merge prints it after a merge. */
  private async diffstat(inner: WorkingCopy, from: ObjectId, to: ObjectId): Promise<string> {
    const diff = () => new DiffCommand(inner).setOldTree(from).setNewTree(to);
    const stat = await diff()
      .callText("stat")
      .catch(() => "");
    const summary = await diff()
      .callText("summary")
      .catch(() => "");
    return `${stat}${summary}`;
  }

  /** `!command`: `sh -c '<command> "$@"' <command> <id>` in the submodule. */
  private async runCommand(inner: WorkingCopy, command: string, id: ObjectId): Promise<boolean> {
    const runner = hookRunnerOf(this.workingCopy);
    if (!runner) {
      this.out.stderr += `fatal: cannot run '${command}': no command runner on this host\n`;
      return false;
    }
    const hostCwd = await worktreeHostPath(inner);
    const outcome = await runner.run({
      name: "submodule-update",
      path: command,
      command,
      args: [id],
      env: { GIT_DIR: ".git" },
      unsetEnv: SUBMODULE_UNSET_ENV,
      cwd: joinFilesPath(this.worktreeAccess?.getRoot() ?? "", inner.worktree?.getRoot?.() ?? ""),
      ...(hostCwd !== undefined ? { hostCwd } : {}),
      stdoutToStderr: false,
    });
    if (!outcome) return false;
    const decoder = new TextDecoder();
    this.out.stdout += decoder.decode(outcome.stdout);
    this.out.stderr += decoder.decode(outcome.stderr);
    return outcome.exitCode === 0;
  }

  /** `submodule--helper update --recursive --super-prefix=<dp>/ ...` in the submodule. */
  private async recurse(inner: WorkingCopy, dp: string): Promise<number> {
    const child = new SubmoduleUpdateCommand(inner)
      .setQuiet(this.quiet)
      .setCompatibility(this.compatibility)
      .setSuperPrefix(`${dp}/`)
      .setRecursive(true)
      .setInit(this.init)
      .setRequireInit(this.requireInit)
      .setRemote(this.remote)
      .setNoFetch(this.noFetch)
      .setForce(this.force)
      .setMode(this.mode)
      .setDepth(this.depth);
    if (this.recommendShallow !== undefined) child.setRecommendShallow(this.recommendShallow);
    for (const reference of this.references) child.addReference(reference);
    if (this.transports) child.setTransports(this.transports);
    if (this.credentials) child.setCredentials(this.credentials);
    if (this.headers) child.setHeaders(this.headers);
    if (this.timeout !== undefined) child.setTimeout(this.timeout);
    let code: number;
    try {
      const result = await child.call();
      this.append({ ...result, exitCode: 0 });
      code = result.exitCode;
    } catch (error) {
      if (!(error instanceof SubmoduleCommandError)) throw error;
      this.append({ ...error.result, exitCode: 0 });
      this.out.stderr += `${error.message}\n`;
      code = error.exitCode;
    }
    if (code) this.out.stderr += `fatal: Failed to recurse into submodule path '${dp}'\n`;
    return code;
  }
}

/**
 * `git submodule status [-q] [--cached] [--recursive] [<path>...]`: one line per submodule
 * of the index, `<state><commit> <path>[ (<name>)]`: `-` not initialized or not checked out,
 * `+` its HEAD (with `--cached`, the index's commit) is not the commit the index records,
 * `U` unmerged (a null id), else a space; the name is the first of `describe`, `describe
 * --tags`, `describe --contains` and `describe --all --always` that answers in the
 * submodule. `--recursive` lists each checked-out submodule's own submodules after it.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.submoduleStatus().call();
 * // " 1a2b3c... lib (v1.0-2-g1a2b3c4)\n"
 * ```
 */
export class SubmoduleStatusCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];
  private cached = false;
  private recursive = false;

  /** A path (pathspec element) limiting the submodules. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--cached`: the index's commit for a submodule whose HEAD moved. */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /** `--recursive`: nested submodules too. */
  setRecursive(recursive: boolean): this {
    this.checkCallable();
    this.recursive = recursive;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    const list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    for (const entry of list) await this.statusOne(entry);
    return this.finish();
  }

  private async statusOne(entry: SubmoduleListEntry): Promise<void> {
    const { path } = entry;
    await this.validatePath(path);
    const model = await this.model();
    if (!model.fromPath(path)) {
      this.die(`fatal: no submodule mapping found in .gitmodules for path '${path}'`);
    }
    const dp = this.displayPath(path);
    if (entry.stage) {
      await this.print("U", NULL_ID_CHAR.repeat(entry.id.length), dp);
      return;
    }
    const worktree = this.worktreeAccess;
    const isRepository = await worktree?.isRepository?.(path).catch(() => false);
    if (!model.isActive(path) || !isRepository) {
      await this.print("-", entry.id, dp);
      return;
    }
    const inner = await this.openSubmodule(path);
    const head = await worktree?.readGitlinkHead?.(path).catch(() => undefined);
    // diff-files' ce_compare_gitlink: a HEAD that cannot be resolved is no change
    if (head === entry.id || head === undefined) {
      await this.print(" ", entry.id, dp, inner);
    } else if (!this.cached) {
      await this.print("+", head, dp, inner);
    } else {
      await this.print("+", entry.id, dp, inner);
    }
    if (this.recursive && inner) {
      const child = new SubmoduleStatusCommand(inner)
        .setQuiet(this.quiet)
        .setCompatibility(this.compatibility)
        .setCached(this.cached)
        .setRecursive(true)
        .setSuperPrefix(`${dp}/`);
      try {
        this.append(await child.call());
      } catch (error) {
        if (!(error instanceof SubmoduleCommandError)) throw error;
        this.append(error.result);
        this.out.stderr += `${error.message}\n`;
        this.die(`fatal: failed to recurse into submodule '${path}'`);
      }
    }
  }

  /** submodule--helper.c's `print_status`. */
  private async print(state: string, id: ObjectId, dp: string, inner?: WorkingCopy): Promise<void> {
    if (this.quiet) return;
    let line = `${state}${id} ${dp}`;
    if ((state === " " || state === "+") && inner) {
      const name = await new SubmoduleRepository(inner).revName(id);
      if (name !== undefined) line += ` (${name})`;
    }
    this.out.stdout += `${line}\n`;
  }
}
