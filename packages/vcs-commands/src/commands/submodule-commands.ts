/**
 * `git submodule init`, `deinit`, `sync`, `set-url`, `set-branch` and `foreach`
 * (builtin/submodule--helper.c), over the submodule model of `submodule-model.ts`.
 *
 * Each command gives what git prints (`stdout`, `stderr`) and its exit status; where git dies
 * (`fatal:`, exit 128; a usage error, 129) the command throws {@link SubmoduleCommandError},
 * whose `result` holds what was printed before.
 */
import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { isGitDirectory } from "@statewalker/vcs-store-files";
import type { GitTransportRegistry } from "@statewalker/vcs-transport";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { type FilesApi, type PosixFilesApi, readFile } from "@statewalker/vcs-utils/files";
import { computeObjectId } from "@statewalker/vcs-utils/pack";
import type { GitHostEnvironment, WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError, RmFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { CloneCommand } from "./clone-command.js";
import { commonGitFileOf, gitFileOf, hookRunnerOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { InitCommand } from "./init-command.js";
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
  lstatKind,
  parentIsDirectory,
  physicalFilesPath,
  relativeFilesPath,
  remoteFromUrl,
  resolveFilesLinks,
  resolveRelativeUrl,
  SubmoduleGitDirError,
  SubmoduleModel,
  type SubmoduleSettings,
  safeCreateLeadingDirectories,
  setInConfigFile,
  submodulePathConfigOf,
  submoduleUpdateTypeName,
  upPathOf,
  urlIsLocalNotSsh,
  validateSubmoduleGitDir,
  validateSubmodulePath,
  worktreeHostPath,
} from "./submodule-model.js";

/** How {@link SubmoduleCommandBase.cloneSubmodule} clones (submodule--helper's `clone`). */
export interface SubmoduleCloneOptions {
  /** `--depth=<n>` */
  depth?: number;
  /** `--reference <repository>`s */
  references?: string[];
  /** `--require-init`: a non-empty directory at the path is refused */
  requireInit?: boolean;
  /**
   * The transports and timeout the clone reaches its remote with. No credentials or headers
   * are taken: a submodule's URL comes from the repository's content, so they are attached
   * by the transports themselves, per URL and origin (`guardSubmoduleTransports`).
   */
  transports?: GitTransportRegistry;
  timeout?: number;
}

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
  /** The entry's stage (0 unless the path is unmerged: git lists its first gitlink stage) */
  stage: number;
}

/**
 * The variables git clears for a submodule's child process (`local_repo_env`, config kept).
 *
 * @internal
 */
export const SUBMODULE_UNSET_ENV = [
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

/** Where `<path>/.git` leads (setup.c's `resolve_gitdir_gently`). */
interface ResolvedGitdir {
  /**
   * The repository directory as a physical FilesApi path (links followed); null when a gitfile
   * or a `.git` link leads beyond the FilesApi
   */
  gitDir: string | null;
  kind: "directory" | "gitfile";
}

/** How deep absorbgitdirs recurses into nested submodules before it gives up. */
const MAX_ABSORB_DEPTH = 64;

/** setup.c's `READ_GITFILE_ERR_*` codes. */
type GitfileError =
  | "missing"
  | "stat-failed"
  | "is-a-dir"
  | "not-a-file"
  | "too-large"
  | "read-failed"
  | "invalid-format"
  | "no-path"
  | "not-a-repo";

/**
 * The `strerror` text of a `rename(2)` of the directory `source` onto `target` that failed
 * (the FilesApi's `move` answers false without the errno): what is in the way, else what is
 * missing, else a refusal.
 */
async function renameFailure(
  files: FilesApi,
  source: string | null,
  target: string,
): Promise<string> {
  if (source === null) return "Permission denied";
  const there = await files.stats(target).catch(() => undefined);
  if (there?.kind === "directory") {
    for await (const _ of files.list(target)) return "Directory not empty";
  } else if (there) return "Not a directory";
  if (!(await files.stats(source).catch(() => undefined))) return "No such file or directory";
  return "Permission denied";
}

/** Whether resolving the `..` components of a FilesApi path climbs above its root. */
function climbsAboveRoot(path: string): boolean {
  let depth = 0;
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return true;
  }
  return false;
}

/** `read_gitfile_error_die`'s message prefixes; codes without one are not fatal there. */
const GITFILE_ERRORS: Partial<Record<GitfileError, string>> = {
  "too-large": "too large to be a .git file: ",
  "read-failed": "error reading ",
  "invalid-format": "invalid gitfile format: ",
  "no-path": "no path in gitfile: ",
};

/**
 * The parts every submodule command shares: output, the index's gitlinks, the model.
 *
 * @internal
 */
export abstract class SubmoduleCommandBase extends GitCommand<SubmoduleCommandResult> {
  protected quiet = false;
  protected superPrefix = "";
  protected compatibility: "2.43" | "2.56" = "2.56";
  protected out: SubmoduleCommandResult = { stdout: "", stderr: "", exitCode: 0 };
  private modelLoad?: Promise<SubmoduleModel>;
  /** The `.gitmodules` warnings were printed already (by a command run before this one) */
  protected modelWarningsShown = false;

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
        if (!this.modelWarningsShown) {
          for (const w of model.gitmodules.warnings) this.out.stderr += `${w}\n`;
        }
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
      list.push({ path: entry.path, id: entry.objectId, stage: entry.stage ?? 0 });
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

  /** git's `stat(2)` kind of a worktree path: symbolic links on the way followed. */
  protected async kindThroughLinks(path: string): Promise<string | undefined> {
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) return undefined;
    const physical = await physicalFilesPath(files, this.filesPath(path)).catch(() => undefined);
    if (physical === undefined) return undefined;
    return (await files.stats(physical).catch(() => undefined))?.kind;
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
  protected async defaultRemoteOfSubmodule(
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

  /**
   * submodule--helper.c's `create_default_gitdir_config`: the first of git's candidates for
   * the submodule's git directory that no other submodule's `gitdir` names (the plain name,
   * then its RFC 3986 encodings, with a digit appended, then the hash of the name) written to
   * `submodule.<name>.gitdir`, unless that is set.
   */
  protected async createDefaultGitdirConfig(name: string): Promise<void> {
    const modules = await gitFileOf(this.workingCopy, "modules");
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

  /**
   * submodule--helper.c's `clone_submodule`: `git clone --no-checkout --separate-git-dir
   * <gitdir> -- <url> <path>` with `GIT_PROTOCOL_FROM_USER=0` (or, with the git directory
   * kept, its index dropped), then `connect_work_tree_and_git_dir`.
   */
  protected async cloneSubmodule(
    path: string,
    realrepo: string,
    gitDir: string,
    gitFiles: FilesApi,
    kept: boolean,
    options: SubmoduleCloneOptions = {},
  ): Promise<void> {
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) return;
    const top = (await worktreeHostPath(this.workingCopy)) ?? "";
    const hostPath = `${top}/${path}`;
    const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
    const leadingOk = async (): Promise<boolean> => {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const kind = await this.kindOf(parts.slice(0, i).join("/"));
        if (kind !== undefined && kind !== "directory") return false;
      }
      return true;
    };

    const nonEmpty = async (): Promise<boolean> => {
      const kind = await this.kindOf(path);
      if (kind === undefined) return false;
      if (kind !== "directory") return true;
      for await (const _ of files.list(this.filesPath(path))) return true;
      return false;
    };
    if (options.requireInit && (await nonEmpty())) {
      this.die(`fatal: directory not empty: '${hostPath}'`);
    }
    if (!kept) {
      // safe_create_leading_directories of the git directory
      const parent = parentOf(gitDir);
      if (parent) await gitFiles.mkdir(parent);
      if (await nonEmpty()) {
        this.out.stderr += `fatal: destination path '${hostPath}' already exists and is not an empty directory.\n`;
        this.die(`fatal: clone of '${realrepo}' into submodule path '${hostPath}' failed`);
      }
      if (!(await leadingOk())) {
        this.out.stderr += `fatal: could not create leading directories of '${hostPath}': Not a directory\n`;
        this.die(`fatal: clone of '${realrepo}' into submodule path '${hostPath}' failed`);
      }
      // cmd_clone's get_repo_path: a local path names a repository, or the clone dies first
      if (urlIsLocalNotSsh(realrepo) && !/^file:/.test(realrepo)) {
        const opened = await worktree
          .openRepository?.(realrepo, { checkOwnership: false, alternates: false })
          .catch(() => undefined);
        const bundle =
          opened === undefined &&
          (await files.stats(joinFilesPath(worktree.getRoot(), realrepo)).catch(() => undefined))
            ?.kind === "file";
        if (worktree.openRepository && opened === undefined && !bundle) {
          this.out.stderr += `fatal: repository '${realrepo}' does not exist\n`;
          this.die(`fatal: clone of '${realrepo}' into submodule path '${hostPath}' failed`);
        }
      }
      if (!this.quiet) this.out.stderr += `Cloning into '${hostPath}'...\n`;
      const worktreeDir = this.filesPath(path);
      const createdDir = (await this.kindOf(path)) === undefined;
      const cleanup = async () => {
        await gitFiles.remove(gitDir).catch(() => false);
        // clone's remove_junk: the worktree it made, or what it wrote in an existing one
        if (createdDir) await files.remove(worktreeDir).catch(() => false);
        else await files.remove(`${worktreeDir}/.git`).catch(() => false);
      };
      try {
        const environment = hostEnvironmentOf(this.workingCopy);
        // git clone --separate-git-dir: a new repository there
        const init = new InitCommand().setFilesApi(gitFiles).setGitDir(gitDir);
        if (environment) init.setEnvironment(environment);
        await init.call();
        // create_default_files: a repository with a worktree logs its refs
        await setInConfigFile(
          this.workingCopy,
          `${gitDir}/config`,
          "core.logallrefupdates",
          "true",
        );
        await worktree.connectGitlink?.(path, gitDir);
        const inner = await worktree.openGitlink?.(path, {
          // always: git-submodule.sh exports GIT_PROTOCOL_FROM_USER=0 whatever the host
          // (without a host environment: one that reads no host files, as none does)
          environment: notFromUser(environment ?? { readFile: async () => undefined }),
        });
        if (!inner) throw new GitApiError(`fatal: could not open the clone at '${hostPath}'`);
        // the clone runs at the superproject's top: a relative path is read from there
        const cloneUrl = isLocalRelativePath(realrepo) ? `${top}/${realrepo}` : realrepo;
        const clone = new CloneCommand(inner)
          .setURI(cloneUrl)
          .setNoCheckout(true)
          .setDirectory(hostPath);
        if (options.depth !== undefined && options.depth > 0) clone.setDepth(options.depth);
        for (const reference of options.references ?? []) clone.addReference(reference);
        if (options.transports) clone.setTransports(options.transports);
        if (options.timeout !== undefined) clone.setTimeout(options.timeout);
        clone.shareHooksOf(this);
        const result = await clone.call();
        if (!this.quiet) {
          for (const line of result.messages ?? []) this.out.stderr += line;
          const local =
            !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(realrepo) &&
            !(result.messages ?? []).some((m) => m.includes("ignoring --local"));
          if (local) this.out.stderr += "done.\n";
        }
      } catch (error) {
        if (error instanceof SubmoduleCommandError || !(error instanceof Error)) throw error;
        await cleanup();
        this.out.stderr += `${error.message}\n`;
        this.die(`fatal: clone of '${realrepo}' into submodule path '${hostPath}' failed`);
      }
    } else {
      if (!(await leadingOk())) {
        this.die(`fatal: could not create directory '${hostPath}'`);
      }
      const parent = parentOf(path);
      if (parent) await files.mkdir(this.filesPath(parent));
      await gitFiles.remove(`${gitDir}/index`).catch(() => false);
      // connect_work_tree_and_git_dir: the gitfile's directory is the path itself
      const kind = await this.kindOf(path);
      if (kind !== undefined && kind !== "directory") {
        this.die(`fatal: could not create directories for ${hostPath}/.git`);
      }
    }

    await worktree.connectGitlink?.(path, gitDir);

    // submodule.alternateLocation and alternateErrorStrategy carried into the submodule
    const store = RemoteConfigStore.from(this.workingCopy);
    for (const key of ["submodule.alternateLocation", "submodule.alternateErrorStrategy"]) {
      const value = store.value(key);
      if (value !== undefined) {
        await setInConfigFile(this.workingCopy, `${gitDir}/config`, key, value);
      }
    }
  }

  /**
   * submodule.c's `absorb_git_dir_into_superproject`: the submodule at `path` whose
   * repository is a `.git` directory in its worktree gets it moved into the superproject's
   * git directory (`.git/modules/<name>`, or `submodule.<name>.gitdir` under
   * `extensions.submodulePathConfig`) and a gitfile in its place; one whose gitfile names no
   * repository (its superproject's git directory moved under it) is connected again to
   * where the repository now lives; nothing for one not populated. Then the same in its own
   * submodules (`--super-prefix=<path>/`), as git's child `submodule--helper absorbgitdirs`.
   */
  protected async absorbGitDirIntoSuperproject(path: string): Promise<void> {
    await this.validatePath(path);
    const state = await this.resolveGitdirGently(path);
    // where the submodule's repository is once absorbed (physically), for the child run
    let innerGitDir: string | null | undefined;
    if ("error" in state) {
      // 2.43 took a failed stat for an unpopulated submodule too
      if (state.error === "missing") return;
      if (state.error === "stat-failed" && this.compatibility === "2.43") return;
      if (state.error !== "not-a-repo") {
        // read_gitfile_error_die: the fatal codes die, the others go on to connect
        const fatal = GITFILE_ERRORS[state.error];
        if (fatal) this.die(`fatal: ${fatal}${path}`);
      }
      // populated, but its gitfile names no repository: the superproject was absorbed itself
      const sub = (await this.model()).fromPath(path);
      if (!sub) this.die(`fatal: could not lookup name for submodule '${path}'`);
      const gitDir = await this.submoduleGitDir(sub.name, path);
      if (gitDir === undefined) return;
      await this.connectWorkTreeAndGitDir(path, gitDir);
      innerGitDir = (await physicalFilesPath(this.filesOrFail(), gitDir)) ?? gitDir;
    } else if (state.gitDir === null && state.kind === "gitfile") {
      // its repository lies beyond this FilesApi: nothing to move, nothing reachable to recurse
      return;
    } else {
      // already absorbed into the superproject's git directory? (a string prefix, as git's)
      const common = await commonGitFileOf(this.workingCopy, "");
      const realSub = await this.realHostPath(state.gitDir ?? this.filesPath(`${path}/.git`));
      const realCommon = common ? await this.realHostPath(common.path) : undefined;
      innerGitDir = state.gitDir;
      if (realCommon === undefined || !realSub.startsWith(realCommon)) {
        innerGitDir = await this.relocateSingleGitDir(path, state);
      }
    }
    await this.absorbNested(path, innerGitDir ?? undefined);
  }

  private filesOrFail(): FilesApi {
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) throw new GitApiError("fatal: no worktree");
    return files;
  }

  /**
   * submodule.c's `relocate_single_git_dir_into_superproject`: the `.git` directory moved
   * (git's `rename`, its result checked before anything else changes) to the submodule's
   * place in the superproject's git directory, then the gitfile written and `core.worktree`
   * set (`connect_work_tree_and_git_dir`). A gitfile needs no migration.
   */
  private async relocateSingleGitDir(
    path: string,
    state: ResolvedGitdir,
  ): Promise<string | null | undefined> {
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) return;
    await this.validatePath(path);
    if (await this.usesWorktrees(files, state.gitDir)) {
      this.die(
        `fatal: relocate_gitdir for submodule '${path}' with more than one worktree not supported`,
      );
    }
    if (state.kind === "gitfile") return state.gitDir;
    // the `.git` directory, a link to one followed (git's real_pathdup): state.gitDir is the
    // physical place, null when a link leads beyond this FilesApi
    const source = state.gitDir;
    const from = await this.realHostPath(this.filesPath(`${path}/.git`));
    const sub = (await this.model()).fromPath(path);
    if (!sub) this.die(`fatal: could not lookup name for submodule '${path}'`);
    const target = await this.submoduleGitDir(sub.name, path, from);
    if (target === undefined) return;
    // safe_create_leading_directories, links followed as git's stat follows them: a dangling
    // link on the way (or one beyond the FilesApi) refuses before anything is created
    const physical = (await safeCreateLeadingDirectories(files, target))
      ? await physicalFilesPath(files, target)
      : undefined;
    if (physical === undefined) {
      this.die(`fatal: could not create directory '${(await this.model()).shownPath(target)}'`);
    }
    const to = await this.realHostPath(target);
    this.out.stderr += `Migrating git directory of '${this.superPrefix}${path}' from\n'${from}' to\n'${to}'\n`;
    // relocate_gitdir: nothing else is changed unless the rename succeeded (the source's data
    // is never removed: a failed move leaves it where it was). rename(2) creates no
    // directory: the place's parent must be there (the FilesApi's move would create it)
    const moved =
      source !== null &&
      (await parentIsDirectory(files, physical)) &&
      (await files.move(source, physical).catch(() => false));
    if (!moved) {
      const reason = await renameFailure(files, source, physical);
      this.die(`fatal: could not migrate git directory from '${from}' to '${to}': ${reason}`);
    }
    await this.connectWorkTreeAndGitDir(path, physical);
    return physical;
  }

  /** `submodule_name_to_gitdir`, its deaths (and 2.43's refusal to move) as git's. */
  private async submoduleGitDir(
    name: string,
    path: string,
    movedFrom?: string,
  ): Promise<string | undefined> {
    try {
      return await (await this.model()).gitDirOf(name);
    } catch (error) {
      if (error instanceof SubmoduleGitDirError && this.compatibility === "2.43") {
        // 2.43's relocate_single_git_dir_into_superproject checked the place itself
        this.out.stderr += error.refusal.map((l) => `${l}\n`).join("");
        const from = movedFrom ?? (await this.realHostPath(this.filesPath(`${path}/.git`)));
        this.die(`fatal: refusing to move '${from}' into an existing git dir`);
      }
      if (error instanceof GitApiError) this.die(error.message);
      throw error;
    }
  }

  /**
   * dir.c's `connect_work_tree_and_git_dir` (no nested ones): the gitfile at `<path>/.git`
   * naming `gitDir` relative to the worktree, then `core.worktree` in `<gitDir>/config`
   * naming the worktree relative to it (the directory created when missing, as git's
   * `safe_create_leading_directories` of the config file).
   */
  protected async connectWorkTreeAndGitDir(path: string, gitDir: string): Promise<void> {
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) return;
    const gitfile = `${path}/.git`;
    // the leading directories of the gitfile and of `<gitDir>/config`, as git creates them
    // (never through a dangling link)
    if (!(await safeCreateLeadingDirectories(files, this.filesPath(gitfile)))) {
      this.die(`fatal: could not create directories for ${gitfile}`);
    }
    if (!(await safeCreateLeadingDirectories(files, `${gitDir}/config`))) {
      this.die(
        `fatal: could not create directories for ${(await this.model()).shownPath(gitDir)}/config`,
      );
    }
    // both sides as their real paths name them (git's real_pathdup): links followed
    const realGitDir = await physicalFilesPath(files, gitDir);
    const workTree = (await physicalFilesPath(files, this.filesPath(path))) ?? this.filesPath(path);
    // write_file opens `<path>/.git` following a link there (to where the link points), which
    // creates no directory: the place's parent must be there
    const at = await resolveFilesLinks(files, this.filesPath(gitfile));
    if (at === "loop") {
      this.die(`fatal: could not open '${gitfile}' for writing: Too many levels of symbolic links`);
    }
    if (realGitDir === undefined || at === "outside") {
      this.die(`fatal: could not open '${gitfile}' for writing: Permission denied`);
    }
    if (!(await parentIsDirectory(files, at))) {
      this.die(`fatal: could not open '${gitfile}' for writing: No such file or directory`);
    }
    const relative = relativeFilesPath(workTree, realGitDir);
    // never written over a directory (git's open fails there: EISDIR)
    if ((await files.stats(at).catch(() => undefined))?.kind === "directory") {
      this.die(`fatal: could not open '${gitfile}' for writing: Is a directory`);
    }
    const written = await files.write(at, [new TextEncoder().encode(`gitdir: ${relative}\n`)]).then(
      () => true,
      () => false,
    );
    if (!written) this.die(`fatal: could not open '${gitfile}' for writing: Permission denied`);
    const worktreeValue = relativeFilesPath(realGitDir, workTree);
    const set = await setInConfigFile(
      this.workingCopy,
      `${realGitDir}/config`,
      "core.worktree",
      worktreeValue,
    ).catch(() => false);
    if (!set) this.die(`fatal: could not set 'core.worktree' to '${worktreeValue}'`);
  }

  /** git's child `submodule--helper absorbgitdirs --super-prefix=<prefix><path>/` there. */
  private async absorbNested(path: string, gitDir: string | undefined): Promise<void> {
    await this.validatePath(path);
    // the child git runs in the submodule finds its repository through `.git`, links and a
    // gitfile naming a place through a link followed: where the worktree cannot read through
    // them, the repository is opened from the physical place found here
    const inner =
      (await this.openSubmodule(path)) ??
      (gitDir === undefined
        ? undefined
        : await this.worktreeAccess?.openGitlink?.(path, { gitDir }).catch(() => undefined));
    // a chain of links cannot make this recurse forever
    const depth = this.superPrefix.split("/").length;
    if (!inner || depth > MAX_ABSORB_DEPTH) {
      this.die(`fatal: could not recurse into submodule '${path}'`);
    }
    const child = new SubmoduleAbsorbGitDirsCommand(inner)
      .setCompatibility(this.compatibility)
      .setSuperPrefix(`${this.superPrefix}${path}/`);
    try {
      this.append(await child.call());
    } catch (error) {
      if (!(error instanceof SubmoduleCommandError)) throw error;
      this.append(error.result);
      this.out.stderr += `${error.message}\n`;
      this.die(`fatal: could not recurse into submodule '${path}'`);
    }
  }

  /**
   * setup.c's `resolve_gitdir_gently` of `<path>/.git`: a `.git` directory that is a
   * repository, else what `read_gitfile_gently` makes of it (the repository a gitfile names,
   * `gitDir` null when it lies beyond this FilesApi, or git's error code).
   */
  private async resolveGitdirGently(
    path: string,
  ): Promise<ResolvedGitdir | { error: GitfileError }> {
    const files = this.worktreeAccess?.getFiles?.();
    if (!files) return { error: "missing" };
    const dotGit = this.filesPath(`${path}/.git`);
    // stat(2), not lstat: a `.git` link is followed to what it names (physically, since the
    // FilesApi never acts through a link)
    let at: string = dotGit;
    if ((await lstatKind(files, dotGit)) === "symlink") {
      const resolved = await resolveFilesLinks(files, dotGit);
      // a loop: stat(2) fails with ELOOP (READ_GITFILE_ERR_STAT_FAILED)
      if (resolved === "loop") return { error: "stat-failed" };
      if (resolved === "outside") {
        // beyond this FilesApi: git would read (and move) it; refused at the move
        return { gitDir: null, kind: "directory" };
      }
      at = resolved;
    }
    const st = await files.stats(at).catch(() => undefined);
    if (!st) return { error: "missing" };
    if (st.kind === "directory") {
      return (await isGitDirectory(files, at))
        ? { gitDir: at, kind: "directory" }
        : { error: "is-a-dir" };
    }
    if (st.kind !== "file") return { error: "not-a-file" };
    if ((st.size ?? 0) > 1 << 20) return { error: "too-large" };
    let text: string;
    try {
      text = decodeGitPath(await readFile(files, at));
    } catch {
      return { error: "read-failed" };
    }
    if (!text.startsWith("gitdir: ")) return { error: "invalid-format" };
    text = text.replace(/[\r\n]+$/, "");
    if (text.length < 9) return { error: "no-path" };
    const target = text.slice(8);
    let resolved: string | undefined;
    if (target.startsWith("/")) {
      const root = (files as { rootDirectory?: string }).rootDirectory?.replace(/\/+$/, "");
      if (root === undefined) resolved = joinFilesPath("", target);
      else if (target === root || target.startsWith(`${root}/`)) {
        resolved = joinFilesPath("", target.slice(root.length));
      }
    } else if (!climbsAboveRoot(`${this.filesPath(path)}/${target}`)) {
      resolved = joinFilesPath(this.filesPath(path), target);
    }
    if (resolved !== undefined) resolved = await physicalFilesPath(files, resolved);
    // a place beyond this FilesApi: a repository git would find, which it would not move
    if (resolved === undefined) return { gitDir: null, kind: "gitfile" };
    if (!(await isGitDirectory(files, resolved))) return { error: "not-a-repo" };
    return { gitDir: resolved, kind: "gitfile" };
  }

  /**
   * worktree.c's `submodule_uses_worktrees`: whether the submodule's common git directory
   * (its `commondir`) has anything in `worktrees/`.
   */
  private async usesWorktrees(files: FilesApi, gitDir: string | null): Promise<boolean> {
    if (gitDir === null) return false;
    let common = gitDir;
    const commondir = `${gitDir}/commondir`;
    if ((await files.stats(commondir).catch(() => undefined))?.kind === "file") {
      const value = decodeGitPath(await readFile(files, commondir)).replace(/[\r\n]+$/, "");
      if (value && !value.startsWith("/")) common = joinFilesPath(gitDir, value);
    }
    try {
      for await (const _ of files.list(`${common}/worktrees`)) return true;
    } catch {
      return false;
    }
    return false;
  }

  /** git's `real_pathdup` of a FilesApi path: its host path, links resolved where possible. */
  private async realHostPath(path: string): Promise<string> {
    const files = this.worktreeAccess?.getFiles?.();
    const root = (files as { rootDirectory?: string } | undefined)?.rootDirectory;
    const clean = joinFilesPath("", path);
    const host = root ? `${root.replace(/\/+$/, "")}/${clean}` : clean;
    const environment = hostEnvironmentOf(this.workingCopy);
    const real = await environment?.realPath?.(host).catch(() => undefined);
    if (real !== undefined) return real;
    // a dangling link resolved to where it points; a missing last component: its parent
    // resolved (`real_pathdup(path, 1)`)
    const physical = files ? await physicalFilesPath(files, clean) : undefined;
    if (physical !== undefined && physical !== clean) return this.realHostPath(physical);
    const slash = host.lastIndexOf("/");
    if (slash > 0) {
      const parent = await environment?.realPath?.(host.slice(0, slash)).catch(() => undefined);
      if (parent !== undefined) return `${parent}${host.slice(slash)}`;
    }
    return host;
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
      // stat(2) of `.git`: a link followed; one this FilesApi cannot follow is taken for the
      // directory git would find (the absorb then refuses rather than leave it behind)
      const dotGitKind = await this.kindThroughLinks(`${path}/.git`);
      const unfollowed =
        dotGitKind === undefined &&
        (await resolveFilesLinks(files, this.filesPath(`${path}/.git`))) === "outside";
      if (dotGitKind === "directory" || unfollowed) {
        if (!this.quiet) {
          this.out.stderr += `warning: Submodule work tree '${dp}' contains a .git directory. This will be replaced with a .git file by using absorbgitdirs.\n`;
        }
        await this.absorbGitDirIntoSuperproject(path);
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
    const files = this.worktreeAccess?.getFiles?.();
    // the config file as git's lock finds it: its directory through links, or the lock fails
    const physical =
      gitDir !== undefined && files ? await physicalFilesPath(files, gitDir) : undefined;
    const directory =
      physical !== undefined &&
      (await files?.stats(physical).catch(() => undefined))?.kind === "directory";
    if (gitDir !== undefined && !directory) {
      this.out.stderr += `error: could not lock config file ${model.shownPath(gitDir)}/config: No such file or directory\n`;
    }
    const done =
      directory &&
      (await setInConfigFile(this.workingCopy, `${physical}/config`, "core.worktree", undefined));
    if (!done) {
      this.out.stderr += `warning: Could not unset core.worktree setting in submodule '${sub.path ?? ""}'\n`;
    }
  }
}

/**
 * `git submodule absorbgitdirs [-q] [<path>...]` (submodule--helper's `absorbgitdirs`): each
 * submodule of the index (matching the paths) whose repository is a `.git` directory in its
 * worktree gets it moved into the superproject's git directory (`.git/modules/<name>`, or
 * `submodule.<name>.gitdir` under `extensions.submodulePathConfig`), a gitfile and
 * `core.worktree` linking the two, then the same for its own submodules, at every depth.
 * git prints each move on stderr whatever `-q` says.
 *
 * @example
 * ```typescript
 * const { stderr } = await git.submoduleAbsorbGitDirs().call();
 * // "Migrating git directory of 'lib' from\n'/w/sup/lib/.git' to\n'/w/sup/.git/modules/lib'\n"
 * ```
 */
export class SubmoduleAbsorbGitDirsCommand extends SubmoduleCommandBase {
  private readonly paths: string[] = [];

  /** A path (pathspec element) limiting the submodules. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  async call(): Promise<SubmoduleCommandResult> {
    this.start();
    const list = await this.moduleList(this.paths);
    if (!list) return this.finish();
    for (const entry of list) await this.absorbGitDirIntoSuperproject(entry.path);
    return this.finish();
  }

  /**
   * @internal `absorb_git_dir_into_superproject` of the submodule at `path` alone (no
   * pathspec, no module list), as `git rm` runs it before removing a submodule.
   */
  async callForPath(path: string): Promise<SubmoduleCommandResult> {
    this.start();
    await this.absorbGitDirIntoSuperproject(path);
    return this.finish();
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

/** A local path that is not absolute (`../up`, a remote's relative URL resolved). */
function isLocalRelativePath(url: string): boolean {
  return !url.startsWith("/") && urlIsLocalNotSsh(url);
}

/** The environment with `GIT_PROTOCOL_FROM_USER=0` (git-submodule.sh exports it). */
export function notFromUser(environment: GitHostEnvironment): GitHostEnvironment {
  return Object.create(environment, {
    protocolFromUser: { value: false, enumerable: true },
  }) as GitHostEnvironment;
}
