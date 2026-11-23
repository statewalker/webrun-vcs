/**
 * The submodule configuration git's submodule-config.c and submodule.c read: the
 * `.gitmodules` file (from the worktree, the index, HEAD or a commit, with git's precedence
 * and checks), the `submodule.<name>.*` settings of the repository's configuration over it,
 * the lookups by name and by path, a submodule's git directory (`.git/modules/<name>`, or
 * `submodule.<name>.gitdir` under `extensions.submodulePathConfig`) and whether it is
 * active. The submodule commands (`init`, `deinit`, `sync`, `set-url`, `set-branch`,
 * `foreach`) are built on it.
 *
 * @example
 * ```typescript
 * const model = await SubmoduleModel.load(workingCopy);
 * const sub = model.fromPath("libs/lib"); // { name: "lib", path: "libs/lib", url: "../lib" }
 * model.isActive("libs/lib"); // submodule.lib.active, submodule.active, or a url in .git/config
 * await model.gitDirOf("lib"); // ".git/modules/lib"
 * ```
 */
import type { ObjectId } from "@statewalker/vcs-core";
import {
  ConfigParseError,
  configFilesApiOf,
  GitWorkingCopyConfig,
  readRepositoryFormat,
} from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils";
import { collectChunks, type WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError, InvalidConfigError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { checkSubmoduleName } from "./fsck/fsck-object-checks.js";
import { commonGitFileOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { DO_MATCH_DIRECTORY, matchPathspec, parsePathspec } from "./pathspec.js";
import { isSubmoduleIgnoreMode, type SubmoduleIgnoreMode } from "./submodule-config.js";

/** How `git submodule update` brings a submodule to its recorded commit (`submodule.<name>.update`). */
export type SubmoduleUpdateType = "checkout" | "rebase" | "merge" | "none" | "command";

/** An update strategy (git's `struct submodule_update_strategy`). */
export interface SubmoduleUpdateStrategy {
  type: SubmoduleUpdateType;
  /** The command of `!<command>` */
  command?: string;
}

/** `submodule.<name>.fetchRecurseSubmodules` as git parses it. */
export type SubmoduleFetchRecurse = "on" | "off" | "on-demand";

/** One submodule of a `.gitmodules` (git's `struct submodule`). */
export interface SubmoduleSettings {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
  ignore?: SubmoduleIgnoreMode;
  update?: SubmoduleUpdateStrategy;
  fetchRecurseSubmodules?: SubmoduleFetchRecurse;
  /** `submodule.<name>.shallow` */
  shallow?: boolean;
}

/** git's `parse_submodule_update_strategy`: undefined for a value it refuses. */
export function parseSubmoduleUpdateStrategy(value: string): SubmoduleUpdateStrategy | undefined {
  if (value === "none" || value === "checkout" || value === "rebase" || value === "merge") {
    return { type: value };
  }
  if (value.startsWith("!")) return { type: "command", command: value.slice(1) };
  return undefined;
}

/** git's `submodule_update_type_to_string`. */
export function submoduleUpdateTypeName(strategy: SubmoduleUpdateStrategy): string {
  return strategy.type === "command" ? `!${strategy.command ?? ""}` : strategy.type;
}

/** Where a `.gitmodules` was read from. */
export type GitmodulesSource =
  | { kind: "worktree" }
  | { kind: "index"; id: ObjectId }
  | { kind: "head"; id: ObjectId }
  | { kind: "commit"; commit: ObjectId; id: ObjectId }
  | { kind: "none" };

/** How {@link Gitmodules.parse} reads a `.gitmodules` text. */
export interface GitmodulesParseOptions {
  /**
   * The commit the text was read from: git then keeps the first value of each setting
   * (`overwrite = 0`) and warns `<commit>:.gitmodules, multiple configurations found for
   * ...`; without one (the worktree's file, the index's or HEAD's blob) the last one wins.
   */
  commit?: ObjectId;
  /** How git names the text in its "bad config line" errors (default `file .gitmodules`) */
  origin?: string;
}

/**
 * A parsed `.gitmodules` (git's submodule cache for one `.gitmodules`): the submodules by
 * name and by path, and the warnings git printed while it read them.
 */
export class Gitmodules {
  /** git's `warning:` lines, in order */
  readonly warnings: string[] = [];
  private readonly names = new Map<string, SubmoduleSettings>();
  private readonly paths = new Map<string, SubmoduleSettings>();

  /** The submodules, in the order their names first appear. */
  list(): SubmoduleSettings[] {
    return [...this.names.values()];
  }

  /** git's `submodule_from_name`. */
  byName(name: string): SubmoduleSettings | undefined {
    return this.names.get(name);
  }

  /** git's `submodule_from_path`: the submodule the last `path` setting named `path` gave. */
  byPath(path: string): SubmoduleSettings | undefined {
    return this.paths.get(path.replace(/\/+$/, ""));
  }

  /**
   * git's `parse_config` over each `submodule.<name>.<item>` variable of a `.gitmodules`:
   * a suspicious name (empty, a `..` component) is ignored with git's warning, a `path` or
   * `url` starting with `-` too, an unknown `ignore` value warns, an update strategy that
   * is not `checkout`, `rebase`, `merge` or `none` (a `!command` included) and a bad
   * `fetchRecurseSubmodules` or `shallow` fail as git dies.
   *
   * @throws InvalidConfigError where git dies reading the file
   */
  static async parse(
    text: string | Uint8Array,
    options: GitmodulesParseOptions = {},
  ): Promise<Gitmodules> {
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    const out = new Gitmodules();
    const origin = options.origin ?? "file .gitmodules";
    const config = new GitWorkingCopyConfig(
      { read: async () => bytes, write: async () => {} },
      ".gitmodules",
      { includes: false },
    );
    try {
      await config.load();
    } catch (error) {
      if (error instanceof ConfigParseError) {
        throw new InvalidConfigError(
          ".gitmodules",
          `fatal: bad config line ${error.line} in ${origin}`,
        );
      }
      throw error;
    }
    const overwrite = options.commit === undefined;
    const commitName = options.commit ?? "WORKTREE";
    const multiple = (name: string, option: string) =>
      out.warnings.push(
        `warning: ${commitName}:.gitmodules, multiple configurations found for 'submodule.${name}.${option}'. Skipping second one!`,
      );
    const commandLineOption = (key: string, value: string) =>
      out.warnings.push(
        `warning: ignoring '${key}' which may be interpreted as a command-line option: ${value}`,
      );
    for (const entry of config.listWithOrigin()) {
      const parts = entry.key.split(".");
      if (parts.length < 3 || parts[0] !== "submodule") continue;
      const name = parts.slice(1, -1).join(".");
      const item = parts[parts.length - 1] as string;
      const key = `submodule.${name}.${item}`;
      if (!checkSubmoduleName(name)) {
        out.warnings.push(`warning: ignoring suspicious submodule name: ${name}`);
        continue;
      }
      let sub = out.names.get(name);
      if (!sub) {
        sub = { name };
        out.names.set(name, sub);
      }
      const value = entry.text;
      const nonbool = () =>
        new InvalidConfigError(
          key,
          `error: missing value for '${key}'\nfatal: bad config variable '${key}' in ${origin}${entry.line !== undefined ? ` at line ${entry.line}` : ""}`,
        );
      switch (item) {
        case "path":
          if (value === undefined) throw nonbool();
          if (value.startsWith("-")) commandLineOption(key, value);
          else if (!overwrite && sub.path !== undefined) multiple(name, "path");
          else {
            if (sub.path !== undefined && out.paths.get(sub.path) === sub) {
              out.paths.delete(sub.path);
            }
            sub.path = value;
            out.paths.set(value, sub);
          }
          break;
        case "fetchrecursesubmodules":
          if (!overwrite && sub.fetchRecurseSubmodules !== undefined) {
            multiple(name, "fetchrecursesubmodules");
          } else {
            const bool = value === undefined ? true : parseGitBool(value);
            if (bool !== undefined) sub.fetchRecurseSubmodules = bool ? "on" : "off";
            else if (value === "on-demand") sub.fetchRecurseSubmodules = "on-demand";
            else if (overwrite) {
              throw new InvalidConfigError(key, `fatal: bad ${key} argument: ${value}`);
            }
          }
          break;
        case "ignore":
          if (value === undefined) throw nonbool();
          if (!overwrite && sub.ignore !== undefined) multiple(name, "ignore");
          else if (!isSubmoduleIgnoreMode(value)) {
            out.warnings.push(
              `warning: Invalid parameter '${value}' for config option 'submodule.${name}.ignore'`,
            );
          } else sub.ignore = value;
          break;
        case "url":
          if (value === undefined) throw nonbool();
          if (value.startsWith("-")) commandLineOption(key, value);
          else if (!overwrite && sub.url !== undefined) multiple(name, "url");
          else sub.url = value;
          break;
        case "update": {
          if (value === undefined) throw nonbool();
          if (!overwrite && sub.update !== undefined) {
            multiple(name, "update");
            break;
          }
          const strategy = parseSubmoduleUpdateStrategy(value);
          if (!strategy || strategy.type === "command") {
            throw new InvalidConfigError(key, `fatal: invalid value for '${key}'`);
          }
          sub.update = strategy;
          break;
        }
        case "shallow": {
          if (!overwrite && sub.shallow !== undefined) {
            multiple(name, "shallow");
            break;
          }
          const bool = value === undefined ? true : parseGitBool(value);
          if (bool === undefined) {
            throw new InvalidConfigError(
              key,
              `fatal: bad boolean config value '${value}' for '${key}'`,
            );
          }
          sub.shallow = bool;
          break;
        }
        case "branch":
          if (value === undefined) throw nonbool();
          if (!overwrite && sub.branch !== undefined) multiple(name, "branch");
          else sub.branch = value;
          break;
      }
    }
    return out;
  }
}

/**
 * Reads the `.gitmodules` git's `config_from_gitmodules` reads: the worktree's file when it
 * exists, else the index's blob, else HEAD's (`:.gitmodules`, `HEAD:.gitmodules`); nothing
 * while the index holds `.gitmodules` unmerged (`repo_read_gitmodules`). With a commit, that
 * commit's `.gitmodules` (`gitmodules_config_oid`).
 */
class GitmodulesSourceReader extends GitCommand<{ bytes?: Uint8Array; source: GitmodulesSource }> {
  commit?: ObjectId;

  async call(): Promise<{ bytes?: Uint8Array; source: GitmodulesSource }> {
    const blob = async (id: ObjectId) => collectChunks((await this.blobs.load(id)) ?? []);
    if (this.commit !== undefined) {
      const id = await this.resolveRevision(`${this.commit}:.gitmodules`).catch(() => undefined);
      if (id === undefined) return { source: { kind: "none" } };
      return { bytes: await blob(id), source: { kind: "commit", commit: this.commit, id } };
    }
    let staged: ObjectId | undefined;
    for await (const entry of this.staging.entries()) {
      if (entry.path !== ".gitmodules") continue;
      if (entry.stage !== 0) return { source: { kind: "none" } };
      staged = entry.objectId;
    }
    const worktree = this.worktreeAccess;
    const file = await worktree?.getEntry(".gitmodules").catch(() => undefined);
    if (worktree && file) {
      return {
        bytes: await collectChunks(worktree.readContent(".gitmodules")),
        source: { kind: "worktree" },
      };
    }
    if (staged !== undefined)
      return { bytes: await blob(staged), source: { kind: "index", id: staged } };
    const head = await this.resolveRevision("HEAD:.gitmodules").catch(() => undefined);
    if (head !== undefined) return { bytes: await blob(head), source: { kind: "head", id: head } };
    return { source: { kind: "none" } };
  }
}

/** How {@link SubmoduleModel.load} reads the configuration. */
export interface SubmoduleModelOptions {
  /** Read this commit's `.gitmodules` instead of the worktree's (git's `treeish_name`) */
  commit?: ObjectId;
}

/**
 * The submodules of a working copy: its `.gitmodules` (see {@link Gitmodules}) with the
 * `submodule.<name>.*` settings of its configuration over it.
 */
export class SubmoduleModel {
  private constructor(
    private readonly workingCopy: WorkingCopy,
    /** The parsed `.gitmodules` (empty when there is none) */
    readonly gitmodules: Gitmodules,
    /** Where it was read from */
    readonly source: GitmodulesSource,
  ) {}

  /**
   * Reads the working copy's `.gitmodules` (see {@link GitmodulesSourceReader}) and parses
   * it as git does.
   *
   * @throws InvalidConfigError where git dies reading it (a bad line, an invalid update strategy)
   */
  static async load(
    workingCopy: WorkingCopy,
    options: SubmoduleModelOptions = {},
  ): Promise<SubmoduleModel> {
    const reader = new GitmodulesSourceReader(workingCopy);
    if (options.commit !== undefined) reader.commit = options.commit;
    const { bytes, source } = await reader.call();
    const origin =
      source.kind === "worktree" || source.kind === "none"
        ? "file .gitmodules"
        : `blob ${source.id}`;
    const gitmodules = bytes
      ? await Gitmodules.parse(bytes, {
          origin,
          ...(source.kind === "commit" ? { commit: source.commit } : {}),
        })
      : new Gitmodules();
    return new SubmoduleModel(workingCopy, gitmodules, source);
  }

  /** The repository's configuration (its whole chain). */
  get config(): RemoteConfigStore {
    return RemoteConfigStore.from(this.workingCopy);
  }

  /** git's `submodule_from_path`. */
  fromPath(path: string): SubmoduleSettings | undefined {
    return this.gitmodules.byPath(path);
  }

  /** git's `submodule_from_name`. */
  fromName(name: string): SubmoduleSettings | undefined {
    return this.gitmodules.byName(name);
  }

  /**
   * A setting of the repository's configuration, the last value as written: undefined when
   * unset, `null` for a variable without `=`.
   */
  configText(key: string): string | null | undefined {
    const values = this.config.valuesWithOrigin(key);
    if (values.length === 0) return undefined;
    return values[values.length - 1]?.text ?? null;
  }

  /**
   * The URL the repository's configuration registers for the submodule
   * (`submodule.<name>.url`, set by `init`), undefined when it is not registered.
   */
  registeredUrl(name: string): string | undefined {
    return this.configText(`submodule.${name}.url`) ?? undefined;
  }

  /** The URL to fetch the submodule from: the registered one, else `.gitmodules`'. */
  url(name: string): string | undefined {
    return this.registeredUrl(name) ?? this.fromName(name)?.url;
  }

  /** `submodule.<name>.update` of the configuration, else of `.gitmodules`. */
  update(name: string): SubmoduleUpdateStrategy | undefined {
    const configured = this.configText(`submodule.${name}.update`);
    if (typeof configured === "string") return parseSubmoduleUpdateStrategy(configured);
    return this.fromName(name)?.update;
  }

  /** `submodule.<name>.branch` of the configuration, else of `.gitmodules`. */
  branch(name: string): string | undefined {
    return this.configText(`submodule.${name}.branch`) ?? this.fromName(name)?.branch;
  }

  /**
   * git's `is_submodule_active`: the submodule `.gitmodules` maps `path` to is active when
   * `submodule.<name>.active` says so; without it, when one of the `submodule.active`
   * pathspecs matches its path; without those, when the configuration registers a URL for it.
   *
   * @throws InvalidConfigError for a `submodule.<name>.active` that is no boolean
   */
  isActive(path: string): boolean {
    const sub = this.fromPath(path);
    if (!sub) return false;
    const key = `submodule.${sub.name}.active`;
    const active = this.configText(key);
    if (active !== undefined) {
      if (active === null) return true;
      const bool = parseGitBool(active);
      if (bool === undefined) {
        throw new InvalidConfigError(
          key,
          `fatal: bad boolean config value '${active}' for '${key}'`,
        );
      }
      return bool;
    }
    const patterns = this.config.valuesWithOrigin("submodule.active").map((v) => v.text ?? "");
    if (patterns.length > 0) {
      return matchPathspec(parsePathspec(patterns), path, DO_MATCH_DIRECTORY) > 0;
    }
    return this.configText(`submodule.${sub.name}.url`) !== undefined;
  }

  /**
   * git's `submodule_name_to_gitdir`: where the repository of the submodule `name` lives,
   * as a path of the working copy's FilesApi: `<common git dir>/modules/<name>`, or under
   * `extensions.submodulePathConfig` the `submodule.<name>.gitdir` setting (relative to the
   * worktree top).
   *
   * @throws GitApiError where git dies: no `submodule.<name>.gitdir` under the extension, or
   * a git directory inside another submodule's
   */
  async gitDirOf(name: string): Promise<string | undefined> {
    const common = await commonGitFileOf(this.workingCopy, "modules");
    if (!common) return undefined;
    if (await submodulePathConfigOf(this.workingCopy)) {
      const key = `submodule.${name}.gitdir`;
      const value = this.configText(key);
      if (typeof value !== "string") {
        throw new GitApiError(
          `fatal: the '${key}' config does not exist for module '${name}'. Please ensure it is set, for example by running something like: 'git config ${key} .git/modules/${name}'. For details see the extensions.submodulePathConfig documentation.`,
        );
      }
      const root = this.workingCopy.worktree?.getRoot?.() ?? "";
      return joinFilesPath(root, value);
    }
    return `${common.path}/${name}`;
  }
}

/** Whether the repository's format has `extensions.submodulePathConfig` (git 2.52 and later). */
export async function submodulePathConfigOf(workingCopy: WorkingCopy): Promise<boolean> {
  const config = await commonGitFileOf(workingCopy, "config");
  if (!config) return false;
  const gitDir = config.path.slice(0, Math.max(0, config.path.lastIndexOf("/")));
  const format = await readRepositoryFormat(config.files, gitDir).catch(() => undefined);
  return format?.submodulePathConfig ?? false;
}

/** `path` joined to `base` with `.` and `..` resolved (FilesApi paths). */
export function joinFilesPath(base: string, path: string): string {
  const parts = (path.startsWith("/") ? path : `${base}/${path}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// ------------------------------------------------------------------------------------------
// URLs relative to the superproject's remote

/** git's `url_is_local_not_ssh`. */
export function urlIsLocalNotSsh(url: string): boolean {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon < 0 || (slash >= 0 && slash < colon);
}

const startsDotSlash = (s: string) => s.startsWith("./");
const startsDotDotSlash = (s: string) => s.startsWith("../");

/** A URL starting with `./` or `../` (either separator): one relative to the superproject's remote. */
export function isRelativeSubmoduleUrl(url: string): boolean {
  return /^\.\.?[/\\]/.test(url);
}

/**
 * git's `relative_url` (remote.c): `url` (`../sub`, `./sub`) resolved against the
 * superproject's remote URL `remoteUrl`, then, when the remote URL is itself relative,
 * prefixed with `upPath` (the way from a submodule's directory back to the superproject's).
 * A URL that is not relative is returned as it is.
 *
 * @throws GitApiError "cannot strip one component off url" where git dies
 *
 * @example
 * ```typescript
 * relativeUrl("https://example.com/org/super", "../lib"); // "https://example.com/org/lib"
 * relativeUrl("user@host:repo", "../sub");                 // "user@host:sub"
 * relativeUrl("../super", "../sub", "../");                // "../../sub"
 * ```
 */
export function relativeUrl(remoteUrl: string, url: string, upPath?: string): string {
  if (!urlIsLocalNotSsh(url) || url.startsWith("/")) return url;
  if (remoteUrl === "") throw new GitApiError("BUG: invalid empty remote_url");
  let remote = remoteUrl.endsWith("/") ? remoteUrl.slice(0, -1) : remoteUrl;
  let isRelative = false;
  if (urlIsLocalNotSsh(remote) && !remote.startsWith("/")) {
    isRelative = true;
    if (!startsDotSlash(remote) && !startsDotDotSlash(remote)) remote = `./${remote}`;
  }
  const chopLastDir = (): boolean => {
    const slash = remote.lastIndexOf("/");
    if (slash >= 0) {
      remote = remote.slice(0, slash);
      return false;
    }
    const colon = remote.lastIndexOf(":");
    if (colon >= 0) {
      remote = remote.slice(0, colon);
      return true;
    }
    if (isRelative || remote === ".") {
      throw new GitApiError(`fatal: cannot strip one component off url '${remote}'`);
    }
    remote = ".";
    return false;
  };
  let rest = url;
  let colonsep = false;
  while (rest !== "") {
    if (startsDotDotSlash(rest)) {
      rest = rest.slice(3);
      colonsep = chopLastDir() || colonsep;
    } else if (startsDotSlash(rest)) rest = rest.slice(2);
    else break;
  }
  let joined = `${remote}${colonsep ? ":" : "/"}${rest}`;
  if (rest.endsWith("/")) joined = joined.slice(0, -1);
  const out = startsDotSlash(joined) ? joined.slice(2) : joined;
  if (!upPath || !isRelative) return out;
  return `${upPath}${out}`;
}

/** git's `get_up_path`: one `../` per component of `path`. */
export function upPathOf(path: string): string {
  const slashes = (path.match(/\//g) ?? []).length;
  return "../".repeat(slashes) + (path.endsWith("/") ? "" : "../");
}

/**
 * What a working copy needs to resolve relative submodule URLs: its current branch (for the
 * default remote) and the host path of its worktree top (git's `xgetcwd()`, the fallback
 * remote).
 */
class RepositoryFacts extends GitCommand<never> {
  async call(): Promise<never> {
    throw new Error("not callable");
  }

  /** The short name of HEAD's branch, undefined when detached. */
  async branch(): Promise<string | undefined> {
    const ref = await this.getCurrentBranch().catch(() => undefined);
    return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  }
}

/** The host's path of the working copy's worktree top (git's `xgetcwd()` there). */
export async function worktreeHostPath(workingCopy: WorkingCopy): Promise<string | undefined> {
  const worktree = workingCopy.worktree;
  const host = worktree?.hostPath;
  const files = worktree?.getFiles?.() as { rootDirectory?: string } | undefined;
  let path = host;
  if (path === undefined && files?.rootDirectory) {
    const root = worktree?.getRoot() ?? "";
    path = `${files.rootDirectory.replace(/\/+$/, "")}${root ? `/${root}` : ""}`;
  }
  if (path === undefined) return undefined;
  const environment = hostEnvironmentOf(workingCopy);
  return (await environment?.realPath?.(path).catch(() => undefined)) ?? path;
}

/** git's `repo_default_remote`: HEAD's branch's remote, the only remote, else `origin`. */
export async function defaultRemoteOf(workingCopy: WorkingCopy): Promise<string> {
  const branch = await new RepositoryFacts(workingCopy).branch();
  return RemoteConfigStore.from(workingCopy).remoteForBranch(branch);
}

/**
 * git 2.5x's `repo_remote_from_url`: the first remote (in configuration order) one of whose
 * URLs is `url` (rewritten by `insteadOf`), undefined when none is.
 */
export function remoteFromUrl(workingCopy: WorkingCopy, url: string): string | undefined {
  const store = RemoteConfigStore.from(workingCopy);
  const wanted = store.aliasUrl(url) ?? url;
  return store.configuredNames().find((name) => store.remoteUrls(name).includes(wanted));
}

/**
 * builtin/submodule--helper.c's `resolve_relative_url`: `url` resolved against the URL of
 * the working copy's default remote; without one, against the worktree's own directory, with
 * git's warning (unless `quiet`) added to `warnings`.
 */
export async function resolveRelativeUrl(
  workingCopy: WorkingCopy,
  url: string,
  upPath: string | undefined,
  options: { quiet?: boolean; warnings?: string[] } = {},
): Promise<string> {
  const remote = await defaultRemoteOf(workingCopy);
  const key = `remote.${remote}.url`;
  const values = RemoteConfigStore.from(workingCopy).valuesWithOrigin(key);
  let remoteUrl = values.length > 0 ? values[values.length - 1]?.text : undefined;
  if (remoteUrl === undefined || remoteUrl === null) {
    if (!options.quiet) {
      options.warnings?.push(
        `warning: could not look up configuration '${key}'. Assuming this repository is its own authoritative upstream.`,
      );
    }
    remoteUrl = (await worktreeHostPath(workingCopy)) ?? ".";
  }
  return relativeUrl(remoteUrl, url, upPath);
}

// ------------------------------------------------------------------------------------------
// Editing configuration files

/**
 * A config file of the working copy's FilesApi opened for editing (git's
 * `git_config_set_in_file`): `.gitmodules`, a submodule's `config`.
 */
export async function openConfigFile(
  workingCopy: WorkingCopy,
  path: string,
): Promise<GitWorkingCopyConfig | undefined> {
  const files = workingCopy.worktree?.getFiles?.();
  if (!files) return undefined;
  const config = new GitWorkingCopyConfig(configFilesApiOf(files), path, { includes: false });
  await config.load();
  return config;
}

/**
 * git's `git_config_set_in_file_gently` of one variable (`value` undefined unsets it):
 * false when there was nothing to unset (git's `CONFIG_NOTHING_SET`) or no such file to
 * write.
 */
export async function setInConfigFile(
  workingCopy: WorkingCopy,
  path: string,
  key: string,
  value: string | undefined,
): Promise<boolean> {
  const config = await openConfigFile(workingCopy, path).catch(() => undefined);
  if (!config) return false;
  if (value === undefined) {
    if (config.getLocal(key).length === 0) return false;
    config.unset(key);
  } else config.set(key, value);
  await config.save();
  return true;
}
