/**
 * `git submodule init`, `deinit`, `sync`, `set-url`, `set-branch` and `foreach`
 * (builtin/submodule--helper.c), over the submodule model of `submodule-model.ts`.
 *
 * Each command gives what git prints (`stdout`, `stderr`) and its exit status; where git dies
 * (`fatal:`, exit 128; a usage error, 129) the command throws {@link SubmoduleCommandError},
 * whose `result` holds what was printed before.
 */
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { computeObjectId } from "@statewalker/vcs-utils/pack";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError, RmFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { commonGitFileOf, hookRunnerOf } from "./git-hooks.js";
import {
  DO_MATCH_DIRECTORY,
  matchPathspecSeen,
  parsePathspec,
  pathspecErrors,
} from "./pathspec.js";
import { RmCommand } from "./rm-command.js";
import {
  defaultRemoteOf,
  isRelativeSubmoduleUrl,
  joinFilesPath,
  relativeFilesPath,
  remoteFromUrl,
  resolveRelativeUrl,
  SubmoduleGitDirError,
  SubmoduleModel,
  type SubmoduleSettings,
  setInConfigFile,
  submodulePathConfigOf,
  submoduleUpdateTypeName,
  upPathOf,
  validateSubmoduleGitDir,
  validateSubmodulePath,
  worktreeHostPath,
} from "./submodule-model.js";

/** What a submodule command printed, and its exit status. */
export interface SubmoduleCommandResult {
  stdout: string;
  stderr: string;
  /** 0, or 1 where git returns 1 without dying (a pathspec that matched nothing) */
  exitCode: number;
}

/**
 * A submodule command died as git dies: `message` is git's last lines (`fatal: ...`, or
 * `error: ...` and the usage), `result` what it printed before them.
 */
export class SubmoduleCommandError extends GitApiError {
  constructor(
    message: string,
    readonly result: SubmoduleCommandResult,
    exitCode = 128,
  ) {
    super(message, { exitCode });
    this.name = "SubmoduleCommandError";
    this.result = { ...result, exitCode };
  }
}

/** One gitlink of the index (submodule--helper.c's `module_list` entry). */
export interface SubmoduleListEntry {
  path: string;
  /** The commit the index records */
  id: ObjectId;
}

/** The variables git clears for a submodule's child process (`local_repo_env`, config kept). */
const SUBMODULE_UNSET_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** git's `sq_quote_buf`: `'...'`, a `'` or `!` inside written as `'\''` / `'\!'`. */
export function shellQuote(text: string): string {
  return `'${text.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
}

/** The parts every submodule command shares: output, the index's gitlinks, the model. */
abstract class SubmoduleCommandBase extends GitCommand<SubmoduleCommandResult> {
  protected quiet = false;
  protected superPrefix = "";
  protected compatibility: "2.43" | "2.56" = "2.56";
  protected out: SubmoduleCommandResult = { stdout: "", stderr: "", exitCode: 0 };
  private modelLoad?: Promise<SubmoduleModel>;

  /** `-q` / `--quiet`: leave out the progress lines. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /**
   * The git version whose behaviour is reproduced where versions differ (default 2.56):
   * `sync` looks up a submodule's remote by its URL first in 2.5x only.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** @internal git's `--super-prefix`: what nested submodules' display paths start with. */
  setSuperPrefix(prefix: string): this {
    this.superPrefix = prefix;
    return this;
  }

  /** git's `validate_submodule_path`: dies (its `error:` line, exit 128) on a symlinked path. */
  protected async validatePath(path: string): Promise<void> {
    const refusal = await validateSubmodulePath(this.workingCopy, path);
    if (refusal !== undefined) this.die(refusal);
  }

  protected displayPath(path: string): string {
    return `${this.superPrefix}${path}`;
  }

  /** Dies as git does: what was printed so far, then `message`. */
  protected die(message: string, exitCode = 128): never {
    throw new SubmoduleCommandError(message, this.out, exitCode);
  }

  /** The submodule model, read (and its warnings printed) when first asked for. */
  protected model(): Promise<SubmoduleModel> {
    this.modelLoad ??= SubmoduleModel.load(this.workingCopy).then(
      (model) => {
        for (const w of model.gitmodules.warnings) this.out.stderr += `${w}\n`;
        return model;
      },
      (error: unknown) => {
        if (error instanceof GitApiError) this.die(error.message);
        throw error;
      },
    );
    return this.modelLoad;
  }

  /** Reads `.gitmodules` again on the next {@link model} (`repo_read_gitmodules`). */
  protected forgetModel(): void {
    this.modelLoad = undefined;
  }

  /**
   * git's `module_list_compute`: the index's gitlinks matching the pathspec, each once, in
   * index order; a pathspec element matching nothing (whatever it matched: files count)
   * gives git's error and exit status 1, and an empty list.
   */
  protected async moduleList(paths: readonly string[]): Promise<SubmoduleListEntry[] | undefined> {
    const items = parsePathspec([...paths]);
    const seen = items.map(() => 0);
    const list: SubmoduleListEntry[] = [];
    let last: string | undefined;
    for await (const entry of this.staging.entries()) {
      if (!matchPathspecSeen(items, entry.path, DO_MATCH_DIRECTORY, seen)) continue;
      if (entry.mode !== FileMode.GITLINK || entry.path === last) continue;
      last = entry.path;
      list.push({ path: entry.path, id: entry.objectId });
    }
    const errors = paths.length > 0 ? pathspecErrors(paths, seen) : [];
    if (errors.length > 0) {
      this.out.stderr += errors.map((e) => `${e}\n`).join("");
      this.out.exitCode = 1;
      return undefined;
    }
    return list;
  }

  /** `git config <key> <value>` in the repository's own file (`repo_config_set_gently`). */
  protected async setConfig(key: string, value: string): Promise<void> {
    const store = RemoteConfigStore.from(this.workingCopy);
    store.setValue(key, value);
    await store.save();
  }

  /** The FilesApi path of a worktree path. */
  protected filesPath(path: string): string {
    return joinFilesPath(this.worktreeAccess?.getRoot() ?? "", path);
  }

  protected async kindOf(path: string): Promise<string | undefined> {
    const files = this.worktreeAccess?.getFiles?.();
    return (await files?.stats(this.filesPath(path)).catch(() => undefined))?.kind;
  }

  /** git's `config_set_in_gitmodules_file_gently` (`value` undefined unsets). */
  protected async setInGitmodules(key: string, value: string | undefined): Promise<boolean> {
    return setInConfigFile(this.workingCopy, this.filesPath(".gitmodules"), key, value);
  }

  /** The working copy of the populated submodule at `path`, undefined when not populated. */
  protected async openSubmodule(path: string): Promise<WorkingCopy | undefined> {
    return this.worktreeAccess?.openGitlink?.(path).catch(() => undefined);
  }

  /**
   * submodule--helper.c's `sync_submodule`: an active submodule's URL registered again from
   * `.gitmodules` (resolved against the superproject's remote), and, when it is populated,
   * written to the submodule's default remote (resolved from the submodule's place).
   */
  protected async syncSubmodule(path: string, recursive: boolean): Promise<void> {
    const model = await this.model();
    if (!model.isActive(path)) return;
    await this.validatePath(path);
    const sub = model.fromPath(path) as SubmoduleSettings;
    let subOriginUrl = "";
    let superConfigUrl = "";
    if (sub.url !== undefined) {
      if (isRelativeSubmoduleUrl(sub.url)) {
        subOriginUrl = await resolveRelativeUrl(this.workingCopy, sub.url, upPathOf(path), {
          quiet: true,
        });
        superConfigUrl = await resolveRelativeUrl(this.workingCopy, sub.url, undefined, {
          quiet: true,
        });
      } else {
        subOriginUrl = sub.url;
        superConfigUrl = sub.url;
      }
    }
    const dp = this.displayPath(path);
    if (!this.quiet) this.out.stdout += `Synchronizing submodule url for '${dp}'\n`;
    await this.setConfig(`submodule.${sub.name}.url`, superConfigUrl);
    const inner = await this.openSubmodule(path);
    if (!inner) return;
    const remote = await this.defaultRemoteOfSubmodule(sub, inner);
    const store = RemoteConfigStore.from(inner);
    store.setValue(`remote.${remote}.url`, subOriginUrl);
    await store.save();
    if (recursive) {
      const child = new SubmoduleSyncCommand(inner)
        .setQuiet(this.quiet)
        .setRecursive(true)
        .setCompatibility(this.compatibility)
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

  /**
   * submodule--helper.c's `get_default_remote_submodule`: in git 2.5x the submodule's
   * remote whose URL is the one `.gitmodules` gives, else (and always in 2.43) its default
   * remote.
   */
  private async defaultRemoteOfSubmodule(
    sub: SubmoduleSettings,
    inner: WorkingCopy,
  ): Promise<string> {
    if (this.compatibility !== "2.43" && sub.url !== undefined) {
      const url = isRelativeSubmoduleUrl(sub.url)
        ? await resolveRelativeUrl(this.workingCopy, sub.url, undefined, { quiet: true })
        : sub.url;
      const found = remoteFromUrl(inner, url);
      if (found !== undefined) return found;
    }
    return defaultRemoteOf(inner);
  }

  protected append(result: SubmoduleCommandResult): void {
    this.out.stdout += result.stdout;
    this.out.stderr += result.stderr;
    if (result.exitCode) this.out.exitCode = result.exitCode;
  }

  protected start(): void {
    this.checkCallable();
    this.setCallable(false);
  }

  protected finish(): SubmoduleCommandResult {
    return { ...this.out };
  }
}

/**
 * `git submodule init [-q] [<path>...]`: each submodule of the index (matching the paths)
 * registered in `.git/config` from `.gitmodules`: `submodule.<name>.active` unless already
 * active, its URL (a relative one resolved against the superproject's default remote, else
 * its own directory with git's warning) unless one is registered, its update strategy unless
 * one is set, and under `extensions.submodulePathConfig` its `submodule.<name>.gitdir`. With
 * no paths and `submodule.active` set, only the active submodules.
 *
 * @example
 * ```typescript
 * const { stderr } = await git.submoduleInit().call();
 * // "Submodule 'lib' (https://example.com/lib) registered for path 'lib'\n"
 * ```
 */
export class SubmoduleInitCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];

  /** A path (pathspec element) limiting the submodules. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    let list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    if (
      this.paths.length === 0 &&
      RemoteConfigStore.from(this.workingCopy).valuesWithOrigin("submodule.active").length > 0
    ) {
      const model = await this.model();
      list = list.filter((e) => model.isActive(e.path));
    }
    for (const entry of list) await this.initSubmodule(entry.path);
    return this.finish();
  }

  private async initSubmodule(path: string): Promise<void> {
    const model = await this.model();
    const dp = this.displayPath(path);
    const sub = model.fromPath(path);
    if (!sub) this.die(`fatal: No url found for submodule path '${dp}' in .gitmodules`);
    if (!model.isActive(path)) await this.setConfig(`submodule.${sub.name}.active`, "true");
    const urlKey = `submodule.${sub.name}.url`;
    if (typeof model.configText(urlKey) !== "string") {
      if (sub.url === undefined) {
        this.die(`fatal: No url found for submodule path '${dp}' in .gitmodules`);
      }
      let url = sub.url;
      if (isRelativeSubmoduleUrl(url)) {
        const warnings: string[] = [];
        try {
          url = await resolveRelativeUrl(this.workingCopy, url, undefined, { warnings });
        } finally {
          for (const w of warnings) this.out.stderr += `${w}\n`;
        }
      }
      await this.setConfig(urlKey, url);
      if (!this.quiet) {
        this.out.stderr += `Submodule '${sub.name}' (${url}) registered for path '${dp}'\n`;
      }
    }
    const updateKey = `submodule.${sub.name}.update`;
    if (typeof model.configText(updateKey) !== "string" && sub.update) {
      let value: string;
      if (sub.update.type === "command") {
        this.out.stderr += `warning: command update mode suggested for submodule '${sub.name}'\n`;
        value = "none";
      } else value = submoduleUpdateTypeName(sub.update);
      await this.setConfig(updateKey, value);
    }
    if (await submodulePathConfigOf(this.workingCopy))
      await this.createDefaultGitdirConfig(sub.name);
  }

  /**
   * submodule--helper.c's `create_default_gitdir_config`: the first of git's candidates for
   * the submodule's git directory that no other submodule's `gitdir` names (the plain name,
   * then its RFC 3986 encodings, with a digit appended, then the hash of the name) written to
   * `submodule.<name>.gitdir`, unless that is set.
   */
  private async createDefaultGitdirConfig(name: string): Promise<void> {
    const modules = await commonGitFileOf(this.workingCopy, "modules");
    const root = this.worktreeAccess?.getRoot() ?? "";
    if (!modules) return;
    const base = relativeFilesPath(root, modules.path);
    const encode = (upper: boolean) =>
      [...new TextEncoder().encode(name)]
        .map((b) => {
          const c = String.fromCharCode(b);
          const ok = upper ? /[a-z0-9\-._~]/.test(c) : /[A-Za-z0-9\-._~]/.test(c);
          return ok ? c : `%${b.toString(16).padStart(2, "0")}`;
        })
        .join("");
    const candidates = [`${base}/${name}`, `${base}/${encode(false)}`, `${base}/${encode(true)}`];
    for (let d = 0; d <= 9; d++) {
      candidates.push(`${base}/${encode(false)}${d}`, `${base}/${encode(true)}${d}`);
    }
    const hash = await computeObjectId("blob", new TextEncoder().encode(name), this.objectFormat);
    candidates.push(`${base}/${hash}`);
    const key = `submodule.${name}.gitdir`;
    const model = await this.model();
    for (const candidate of candidates) {
      const path = joinFilesPath(root, candidate);
      if (await validateSubmoduleGitDir(this.workingCopy, path, name, { encoded: true })) continue;
      if (typeof model.configText(key) === "string") return;
      await this.setConfig(key, candidate);
      return;
    }
    this.die(
      `fatal: failed to set a valid default config for '${key}'. Please ensure it is set, for example by running something like: 'git config ${key} .git/modules/${name}'`,
    );
  }
}

const DEINIT_USAGE = [
  "usage: git submodule deinit [--quiet] [-f | --force] [--all | [--] [<path>...]]",
  "",
  "    -q, --[no-]quiet      suppress submodule status output",
  "    -f, --[no-]force      remove submodule working trees even if they contain local changes",
  "    --[no-]all            unregister all submodules",
  "",
].join("\n");

/**
 * `git submodule deinit [-q] [-f] (--all | <path>...)`: each submodule's worktree emptied
 * (a `.git` directory first absorbed into `.git/modules/<name>`, local changes refused
 * without `-f` as `git rm -n` refuses them), its repository's `core.worktree` unset, an empty
 * directory left, and its `submodule.<name>` section removed from `.git/config`.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.submoduleDeinit().addPath("lib").call();
 * // "Cleared directory 'lib'\nSubmodule 'lib' (../lib) unregistered for path 'lib'\n"
 * ```
 */
export class SubmoduleDeinitCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];
  private force = false;
  private all = false;

  /** A path (pathspec element) naming the submodules to deinitialize. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `-f`: remove the worktrees even with local changes. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `--all`: every submodule (no path may be given). */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    if (this.all && this.paths.length > 0) {
      this.die(`error: pathspec and --all are incompatible\n${DEINIT_USAGE}`, 129);
    }
    if (!this.all && this.paths.length === 0) {
      this.die("fatal: Use '--all' if you really want to deinitialize all submodules");
    }
    const list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    for (const entry of list) await this.deinitSubmodule(entry.path);
    return this.finish();
  }

  private async deinitSubmodule(path: string): Promise<void> {
    await this.validatePath(path);
    const model = await this.model();
    const sub = model.fromPath(path);
    if (!sub) return;
    const dp = this.displayPath(path);
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) return;
    if ((await this.kindOf(path)) === "directory") {
      if ((await this.kindOf(`${path}/.git`)) === "directory") {
        if (!this.quiet) {
          this.out.stderr += `warning: Submodule work tree '${dp}' contains a .git directory. This will be replaced with a .git file by using absorbgitdirs.\n`;
        }
        await this.absorbGitDir(path, sub.name);
      }
      if (!this.force) {
        try {
          await new RmCommand(this.workingCopy).setDryRun(true).addFilepattern(path).call();
        } catch (error) {
          if (!(error instanceof RmFailedError)) throw error;
          this.out.stderr += `${error.message}\n`;
          this.die(
            `fatal: Submodule work tree '${dp}' contains local modifications; use '-f' to discard them`,
          );
        }
      }
      const removed = await files.remove(this.filesPath(path)).catch(() => false);
      if (!this.quiet) {
        this.out.stdout += removed
          ? `Cleared directory '${dp}'\n`
          : `Could not remove submodule work tree '${dp}'\n`;
      }
      await this.unsetCoreWorktree(sub);
    }
    // mkdir(path, 0777): its parent must be there, and nothing at the path
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const parentKind = parent === "" ? "directory" : await this.kindOf(parent);
    if (parentKind === "directory" && (await this.kindOf(path)) === undefined) {
      await files.mkdir(this.filesPath(path));
    } else {
      this.out.stdout += `could not create empty submodule directory ${dp}`;
    }
    // `git config --get-regexp 'submodule.<name>\.'` over the whole configuration
    const store = RemoteConfigStore.from(this.workingCopy);
    if (this.registered(store, sub.name)) {
      store.removeSection(`submodule.${sub.name}`);
      await store.save();
      if (!this.quiet) {
        this.out.stdout += `Submodule '${sub.name}' (${sub.url ?? "(null)"}) unregistered for path '${dp}'\n`;
      }
    }
  }

  /**
   * Whether the configuration holds a `submodule.<name>.*` variable (git runs `git config
   * --get-regexp 'submodule.<name>\.'`; the name is compared as a string, never compiled
   * into a pattern: a name from `.gitmodules` is untrusted).
   */
  private registered(store: RemoteConfigStore, name: string): boolean {
    const entries = store.entriesWithPrefix("submodule.");
    if (!entries) return store.values(`submodule.${name}.url`).length > 0;
    const prefix = `submodule.${name}.`;
    return entries.some((e) => e.key.startsWith(prefix) && e.key.length > prefix.length);
  }

  /** submodule.c's `submodule_unset_core_worktree`. */
  private async unsetCoreWorktree(sub: SubmoduleSettings): Promise<void> {
    const model = await this.model();
    let gitDir: string | undefined;
    try {
      await this.validatePath(sub.path ?? "");
      gitDir = await model.gitDirOf(sub.name);
    } catch (error) {
      if (error instanceof GitApiError && !(error instanceof SubmoduleCommandError)) {
        this.die(error.message);
      }
      throw error;
    }
    const done =
      gitDir !== undefined &&
      (await setInConfigFile(this.workingCopy, `${gitDir}/config`, "core.worktree", undefined));
    if (!done) {
      this.out.stderr += `warning: Could not unset core.worktree setting in submodule '${sub.path ?? ""}'\n`;
    }
  }

  /**
   * submodule.c's `relocate_single_git_dir_into_superproject`: the submodule's `.git`
   * directory moved to its place in the superproject's git directory, a gitfile and
   * `core.worktree` linking the two. Nested submodules are not absorbed.
   */
  private async absorbGitDir(path: string, name: string): Promise<void> {
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) return;
    await this.validatePath(path);
    const model = await this.model();
    const source = this.filesPath(`${path}/.git`);
    const host = (p: string) => {
      const root = (files as { rootDirectory?: string }).rootDirectory;
      return root ? `${root.replace(/\/+$/, "")}/${p}` : p;
    };
    const environment = (
      this.workingCopy.config as
        | { environment?: { realPath?(p: string): Promise<string> } }
        | undefined
    )?.environment;
    const real = async (p: string) =>
      (await environment?.realPath?.(host(p)).catch(() => undefined)) ?? host(p);
    let target: string | undefined;
    try {
      target = await model.gitDirOf(name);
    } catch (error) {
      if (error instanceof SubmoduleGitDirError && this.compatibility === "2.43") {
        // relocate_single_git_dir_into_superproject of 2.43
        this.out.stderr += error.refusal.map((l) => `${l}\n`).join("");
        this.die(`fatal: refusing to move '${await real(source)}' into an existing git dir`);
      }
      if (error instanceof GitApiError) this.die(error.message);
      throw error;
    }
    if (target === undefined) return;
    const parent = target.slice(0, Math.max(0, target.lastIndexOf("/")));
    if (parent) await files.mkdir(parent);
    const from = await real(source);
    this.out.stderr += `Migrating git directory of '${this.superPrefix}${path}' from\n'${from}' to\n'${host(target)}'\n`;
    if (!(await files.move(source, target))) {
      this.die(`fatal: could not migrate git directory from '${from}' to '${host(target)}'`);
    }
    await worktree.connectGitlink?.(path, target);
  }
}

/**
 * `git submodule sync [-q] [--recursive] [<path>...]`: each active submodule's URL
 * registered again in `.git/config` from `.gitmodules`, and written to the default remote of
 * a populated submodule (a relative URL resolved from the submodule's own place; in git 2.5x
 * the remote already naming that URL first). `--recursive` goes on in each populated
 * submodule's own submodules.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.submoduleSync().setRecursive(true).call();
 * // "Synchronizing submodule url for 'lib'\nSynchronizing submodule url for 'lib/nested'\n"
 * ```
 */
export class SubmoduleSyncCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];
  private recursive = false;

  /** A path (pathspec element) limiting the submodules. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--recursive`: sync nested submodules too. */
  setRecursive(recursive: boolean): this {
    this.checkCallable();
    this.recursive = recursive;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    const list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    for (const entry of list) await this.syncSubmodule(entry.path, this.recursive);
    return this.finish();
  }
}

const SET_URL_USAGE = [
  "usage: git submodule set-url [--quiet] <path> <newurl>",
  "",
  "    -q, --[no-]quiet      suppress output for setting url of a submodule",
  "",
].join("\n");

/**
 * `git submodule set-url [-q] <path> <newurl>`: the submodule's `url` in `.gitmodules` set
 * (the file is not staged), then synced as `git submodule sync` does.
 *
 * @example
 * ```typescript
 * await git.submoduleSetUrl().setPath("lib").setUrl("../new-lib").call();
 * ```
 */
export class SubmoduleSetUrlCommand extends SubmoduleCommandBase {
  private path?: string;
  private url?: string;

  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  setUrl(url: string): this {
    this.checkCallable();
    this.url = url;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    if (this.path === undefined || this.url === undefined) this.die(SET_URL_USAGE, 129);
    const model = await this.model();
    const sub = model.fromPath(this.path);
    if (!sub) {
      this.die(`fatal: no submodule mapping found in .gitmodules for path '${this.path}'`);
    }
    await this.setInGitmodules(`submodule.${sub.name}.url`, this.url);
    this.forgetModel();
    await this.syncSubmodule(sub.path ?? this.path, false);
    return this.finish();
  }
}

const SET_BRANCH_USAGE = [
  "usage: git submodule set-branch [-q|--quiet] (-d|--default) <path>",
  "   or: git submodule set-branch [-q|--quiet] (-b|--branch) <branch> <path>",
  "",
  "    -d, --[no-]default    set the default tracking branch to master",
  "    -b, --[no-]branch <branch>",
  "                          set the default tracking branch",
  "",
].join("\n");

/**
 * `git submodule set-branch (-b <branch> | -d) <path>`: the submodule's `branch` in
 * `.gitmodules` set, or removed with `-d` (exit status 1 when there was none).
 *
 * @example
 * ```typescript
 * await git.submoduleSetBranch().setPath("lib").setBranch("stable").call();
 * ```
 */
export class SubmoduleSetBranchCommand extends SubmoduleCommandBase {
  private path?: string;
  private branch?: string;
  private useDefault = false;

  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  /** `-b <branch>`. */
  setBranch(branch: string): this {
    this.checkCallable();
    this.branch = branch;
    return this;
  }

  /** `-d`: back to the default (the setting removed). */
  setDefault(useDefault: boolean): this {
    this.checkCallable();
    this.useDefault = useDefault;
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    if (this.branch === undefined && !this.useDefault) {
      this.die("fatal: --branch or --default required");
    }
    if (this.branch !== undefined && this.useDefault) {
      this.die("fatal: options '--branch' and '--default' cannot be used together");
    }
    if (this.path === undefined) this.die(SET_BRANCH_USAGE, 129);
    const model = await this.model();
    const sub = model.fromPath(this.path);
    if (!sub) {
      this.die(`fatal: no submodule mapping found in .gitmodules for path '${this.path}'`);
    }
    const done = await this.setInGitmodules(`submodule.${sub.name}.branch`, this.branch);
    if (!done) this.out.exitCode = 1;
    return this.finish();
  }
}

/** What a {@link SubmoduleForeachCommand} callback is given (git's variables). */
export interface SubmoduleForeachContext {
  /** `$name`: the submodule's name in `.gitmodules` */
  name: string;
  /** `$sm_path`: its path in the superproject running the command */
  path: string;
  /** `$displaypath`: its path from the top superproject */
  displayPath: string;
  /** `$sha1`: the commit the superproject's index records */
  sha1: ObjectId;
  /** `$toplevel`: the host path of the superproject running the command */
  toplevel: string | undefined;
  /** The submodule's working copy */
  workingCopy: WorkingCopy;
}

/** A callback run in each submodule in place of a command. */
export type SubmoduleForeachCallback = (
  context: SubmoduleForeachContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: a callback may return nothing
) => Promise<SubmoduleForeachOutcome | undefined | void>;

/** What a callback reports back: a non-zero `exitCode` stops the walk as git dies. */
export interface SubmoduleForeachOutcome {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * `git submodule foreach [-q] [--recursive] <command>`: in each populated submodule (index
 * order), `Entering '<displaypath>'` and the command, run through the host's command runner
 * (`GitHostEnvironment.hookRunner`) as git runs it: one argument through the shell with
 * `$name`, `$sm_path`, `$displaypath`, `$sha1`, `$toplevel` (and `$path`) set, several as
 * an argument list; `GIT_DIR=.git` and the repository variables cleared. A callback may take
 * the command's place. A command that fails stops the walk (git's "run_command returned
 * non-zero status"); `--recursive` runs it in nested submodules after their parent.
 *
 * @example
 * ```typescript
 * await git.submoduleForeach().setCommand(["git pull"]).call();
 * await git.submoduleForeach().setCallback(async ({ name, sha1 }) => {
 *   console.log(name, sha1);
 * }).call();
 * ```
 */
export class SubmoduleForeachCommand extends SubmoduleCommandBase {
  private command: string[] = [];
  private callback?: SubmoduleForeachCallback;
  private recursive = false;

  /** The command and its arguments (git's `<command>...`). */
  setCommand(command: string[]): this {
    this.checkCallable();
    this.command = [...command];
    return this;
  }

  /** A callback run in place of a command. */
  setCallback(callback: SubmoduleForeachCallback): this {
    this.checkCallable();
    this.callback = callback;
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
    const list = await this.moduleList([]);
    if (!list) return this.finish();
    const toplevel = await worktreeHostPath(this.workingCopy);
    for (const { path, id } of list) {
      await this.validatePath(path);
      const dp = this.displayPath(path);
      const model = await this.model();
      const sub = model.fromPath(path);
      if (!sub) this.die(`fatal: No url found for submodule path '${dp}' in .gitmodules`);
      const inner = await this.openSubmodule(path);
      if (!inner) continue;
      if (!this.quiet) this.out.stdout += `Entering '${dp}'\n`;
      const context: SubmoduleForeachContext = {
        name: sub.name,
        path,
        displayPath: dp,
        sha1: id,
        toplevel,
        workingCopy: inner,
      };
      let exitCode = 0;
      if (this.callback) {
        const outcome = (await this.callback(context)) ?? undefined;
        this.out.stdout += outcome?.stdout ?? "";
        this.out.stderr += outcome?.stderr ?? "";
        exitCode = outcome?.exitCode ?? 0;
      } else if (this.command.length > 0) {
        exitCode = await this.runCommand(context, inner);
      }
      if (exitCode !== 0) this.die(`fatal: run_command returned non-zero status for ${dp}\n.`);
      if (this.recursive) {
        const child = new SubmoduleForeachCommand(inner)
          .setQuiet(this.quiet)
          .setRecursive(true)
          .setCommand(this.command)
          .setSuperPrefix(`${dp}/`);
        if (this.callback) child.setCallback(this.callback);
        try {
          this.append(await child.call());
        } catch (error) {
          if (!(error instanceof SubmoduleCommandError)) throw error;
          this.append(error.result);
          this.out.stderr += `${error.message}\n`;
          this.die(
            `fatal: run_command returned non-zero status while recursing in the nested submodules of ${dp}\n.`,
          );
        }
      }
    }
    return this.finish();
  }

  /** The command in the submodule, through the host's runner; its exit status. */
  private async runCommand(context: SubmoduleForeachContext, inner: WorkingCopy): Promise<number> {
    const runner = hookRunnerOf(this.workingCopy);
    const [first, ...rest] = this.command as [string, ...string[]];
    if (!runner) {
      this.die(`fatal: cannot run '${first}': no command runner on this host`);
    }
    const single = this.command.length === 1;
    const command = single ? `path=${shellQuote(context.path)}; ${first}` : first;
    const env: Record<string, string> = { GIT_DIR: ".git" };
    if (single) {
      env.name = context.name;
      env.sm_path = context.path;
      env.displaypath = context.displayPath;
      env.sha1 = context.sha1;
      if (context.toplevel !== undefined) env.toplevel = context.toplevel;
    }
    const hostCwd = await worktreeHostPath(inner);
    const outcome = await runner.run({
      name: "submodule-foreach",
      path: command,
      command,
      args: single ? [] : rest,
      env,
      unsetEnv: SUBMODULE_UNSET_ENV,
      cwd: this.filesPath(context.path),
      ...(hostCwd !== undefined ? { hostCwd } : {}),
      stdoutToStderr: false,
    });
    if (!outcome) return 127;
    const decoder = new TextDecoder();
    this.out.stdout += decoder.decode(outcome.stdout);
    this.out.stderr += decoder.decode(outcome.stderr);
    return outcome.exitCode;
  }
}
