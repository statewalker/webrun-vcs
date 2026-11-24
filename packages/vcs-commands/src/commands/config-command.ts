/**
 * `git config` as a library command (builtin/config.c): `get`, `set`, `--add`, `unset`,
 * `--replace-all` / `--unset-all` with value patterns, `rename-section` and
 * `remove-section`, on the repository's file or on one scope's.
 *
 * ```typescript
 * await git.config().set("core.editor", "vim").call();
 * await git.config().add("remote.origin.fetch", "+refs/tags/*:refs/tags/*").call();
 * await git.config().unset("remote.origin.fetch").setValuePattern("tags").call();
 * await git.config().setScope("global").set("user.name", "A U Thor").call();
 * await git.config().renameSection("remote.origin", "remote.upstream").call();
 * const { stdout, exitCode } = await git.config().get("core.bare").call(); // "false\n", 0
 * ```
 *
 * Writes edit the scope's file as git does (`setConfigMultivarInFile`,
 * `renameConfigSectionInFile` of vcs-store-files: under `<file>.lock`, comments, includes and
 * other sections kept byte for byte), and give git's exit status and stderr: 5 for a key to
 * unset that is not there or several values without `setAll`, 1 or 2 for an invalid key, 6
 * for an invalid pattern, 3 for a file whose header git cannot name, 255 for a lock held,
 * 128 where git dies (`no such section`, a bad config line).
 */

import {
  CONFIG_REGEX_NONE,
  type ConfigFileLocation,
  ConfigParseError,
  GitWorkingCopyConfig,
  parseConfigKey,
  prepareConfigComment,
  readConfigFileThroughLinks,
  renameConfigSectionInFile,
  setConfigMultivarInFile,
} from "@statewalker/vcs-store-files";
import { compilePosixRegex, PosixRegexError } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  expandUserPath,
  type GitHostEnvironment,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { hostEnvironmentOf } from "./git-ident.js";

/** The file `git config` reads or writes: `--local`, `--worktree`, `--global`, `--system`. */
export type ConfigCommandScope = "local" | "worktree" | "global" | "system";

/** What {@link ConfigCommand} did. */
export interface ConfigCommandResult {
  /** git's exit status */
  exitCode: number;
  /** git's stdout: the values `get` prints, one per line */
  stdout: string;
  /** git's stderr: its `warning:`, `error:` and `fatal:` lines */
  stderr: string;
  /** The values `get` found, in order (undefined for a variable without `=`) */
  values?: (string | undefined)[];
}

type ConfigAction =
  | { kind: "get"; key: string }
  | { kind: "set"; key: string; value: string }
  | { kind: "add"; key: string; value: string }
  | { kind: "unset"; key: string }
  | { kind: "rename-section"; from: string; to: string }
  | { kind: "remove-section"; name: string };

/** A refusal of git's: its exit status and its lines. */
class Refusal {
  constructor(
    readonly exitCode: number,
    readonly lines: string[],
  ) {}
}

const fatal = (message: string) => new Refusal(128, [`fatal: ${message}`]);

/**
 * `git config` on one key or section (see the module comment).
 *
 * The action is one of {@link get}, {@link set}, {@link add}, {@link unset},
 * {@link renameSection}, {@link removeSection}. Without {@link setScope} or {@link setFile}
 * writes go to the repository's `config` and `get` reads the whole configuration (system,
 * global, the repository's, `config.worktree`, the command line, includes followed); with one,
 * only that file is read, its includes not followed, as git does.
 *
 * git's two syntaxes differ only in their messages and refusals: the legacy one (`git config
 * <key> <value> [<value-pattern>]`, `--add`, `--replace-all`, `--unset[-all]`,
 * `--rename-section`, `--remove-section`, `--get[-all]`) with {@link setLegacySyntax}, else
 * git 2.46's subcommands (`git config set [--all] [--value=<pattern>] [--append]`,
 * `unset`, `get`, `rename-section`, `remove-section`).
 */
export class ConfigCommand extends GitCommand<ConfigCommandResult> {
  private action?: ConfigAction;
  private scope?: ConfigCommandScope;
  private file?: string;
  private all = false;
  private valuePattern?: string;
  private fixedValue = false;
  private comment?: string;
  private defaultValue?: string;
  private legacy = false;
  /** git's warnings of a read (a file it cannot open), printed before the values */
  private warnings: string[] = [];

  /** `get <key>` / `--get <key>` (`--get-all` with {@link setAll}). */
  get(key: string): this {
    return this.setAction({ kind: "get", key });
  }

  /**
   * `set <key> <value>` / `<key> <value>`: the key's value replaced (`--all` /
   * `--replace-all` with {@link setAll}; only values matching {@link setValuePattern}).
   */
  set(key: string, value: string): this {
    return this.setAction({ kind: "set", key, value });
  }

  /** `set --append <key> <value>` / `--add <key> <value>`: a new line, the old ones kept. */
  add(key: string, value: string): this {
    return this.setAction({ kind: "add", key, value });
  }

  /** `unset <key>` / `--unset <key>` (`--all` / `--unset-all` with {@link setAll}). */
  unset(key: string): this {
    return this.setAction({ kind: "unset", key });
  }

  /** `rename-section <old> <new>` / `--rename-section`: `old` as written in its headers. */
  renameSection(from: string, to: string): this {
    return this.setAction({ kind: "rename-section", from, to });
  }

  /** `remove-section <name>` / `--remove-section`: every section of that name, whole. */
  removeSection(name: string): this {
    return this.setAction({ kind: "remove-section", name });
  }

  /** `--local`, `--worktree`, `--global`, `--system`: the file read or written. */
  setScope(scope: ConfigCommandScope | undefined): this {
    this.checkCallable();
    this.scope = scope;
    return this;
  }

  /**
   * `--file <path>`: an absolute host path (written through the host environment's
   * `hostFilesOf`), or a path relative to the worktree top.
   */
  setFile(path: string | undefined): this {
    this.checkCallable();
    this.file = path;
    return this;
  }

  /** `--all` (`--get-all`, `--replace-all`, `--unset-all`): every value matching. */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /**
   * `--value=<pattern>` / the legacy positional `<value-pattern>`: only the values matching it
   * (a POSIX extended regex, `!` first to invert, or the string with {@link setFixedValue}).
   */
  setValuePattern(pattern: string | undefined): this {
    this.checkCallable();
    this.valuePattern = pattern;
    return this;
  }

  /** `--fixed-value`: the value pattern is compared as a string. */
  setFixedValue(fixed: boolean): this {
    this.checkCallable();
    this.fixedValue = fixed;
    return this;
  }

  /** `--comment <text>`: written after the value set or added. */
  setComment(comment: string | undefined): this {
    this.checkCallable();
    this.comment = comment;
    return this;
  }

  /** `--default <value>`: what `get` prints when the key has no value. */
  setDefault(value: string | undefined): this {
    this.checkCallable();
    this.defaultValue = value;
    return this;
  }

  /** git's legacy option syntax (`--add`, `--unset-all`, ...): its messages and refusals. */
  setLegacySyntax(legacy: boolean): this {
    this.checkCallable();
    this.legacy = legacy;
    return this;
  }

  private setAction(action: ConfigAction): this {
    this.checkCallable();
    this.action = action;
    return this;
  }

  async call(): Promise<ConfigCommandResult> {
    this.checkCallable();
    this.setCallable(false);
    const action = this.action;
    if (!action) throw new GitApiError("error: no action specified", { exitCode: 129 });
    try {
      return await this.run(action);
    } catch (error) {
      if (error instanceof Refusal) return result(error.exitCode, error.lines);
      throw error;
    }
  }

  private async run(action: ConfigAction): Promise<ConfigCommandResult> {
    this.checkOptions(action);
    const comment = this.comment === undefined ? undefined : prepared(this.comment);
    if (this.scope !== undefined && this.file !== undefined) {
      throw new Refusal(129, ["error: only one config file at a time"]);
    }
    if (action.kind === "get") return this.runGet(action.key);
    const location = await this.location();
    let outcome: { status: number; stderr: string[] };
    switch (action.kind) {
      case "set":
      case "add": {
        const pattern =
          action.kind === "add" ? CONFIG_REGEX_NONE : (this.valuePattern ?? undefined);
        outcome = await setConfigMultivarInFile(location, action.key, action.value, {
          ...(pattern !== undefined ? { valuePattern: pattern } : {}),
          fixedValue: this.fixedValue,
          multiReplace: action.kind === "set" && this.all,
          ...(comment !== undefined ? { comment } : {}),
        });
        if (
          outcome.status === 5 &&
          action.kind === "set" &&
          !this.all &&
          this.valuePattern === undefined
        ) {
          outcome.stderr.push(
            "error: cannot overwrite multiple values with a single value",
            this.legacy
              ? `       Use a regexp, --add or --replace-all to change ${action.key}.`
              : `       Use --value=<pattern>, --append or --all to change ${action.key}.`,
          );
        }
        break;
      }
      case "unset":
        outcome = await setConfigMultivarInFile(location, action.key, undefined, {
          ...(this.valuePattern !== undefined ? { valuePattern: this.valuePattern } : {}),
          fixedValue: this.fixedValue,
          multiReplace: this.all,
        });
        break;
      case "rename-section":
      case "remove-section": {
        const from = action.kind === "rename-section" ? action.from : action.name;
        const renamed = await renameConfigSectionInFile(
          location,
          from,
          action.kind === "rename-section" ? action.to : undefined,
        );
        if (renamed.count < 0) outcome = { status: 255, stderr: renamed.stderr };
        else if (renamed.count === 0) {
          outcome = { status: 128, stderr: [...renamed.stderr, `fatal: no such section: ${from}`] };
        } else outcome = { status: 0, stderr: renamed.stderr };
        break;
      }
    }
    if (outcome.status === 0 || action.kind === "rename-section") await this.reloadConfig();
    return result(outcome.status, outcome.stderr);
  }

  /** The option checks git makes before it reads or writes anything. */
  private checkOptions(action: ConfigAction): void {
    const hasPattern = this.valuePattern !== undefined;
    const sectionAction = action.kind === "rename-section" || action.kind === "remove-section";
    if (this.legacy) {
      // cmd_config_actions: the action's argument count, then the option combinations
      if (action.kind === "add" && hasPattern) {
        throw new Refusal(129, ["error: wrong number of arguments, should be 2"]);
      }
      if (sectionAction && (hasPattern || this.all)) {
        throw new Refusal(129, ["error: only one action at a time"]);
      }
      if (this.defaultValue !== undefined && (action.kind !== "get" || this.all)) {
        throw new Refusal(129, ["error: --default is only applicable to --get"]);
      }
      if (this.comment !== undefined && !(action.kind === "set" || action.kind === "add")) {
        throw new Refusal(129, [
          "error: --comment is only applicable to add/set/replace operations",
        ]);
      }
      if (this.fixedValue && (!hasPattern || action.kind === "add" || sectionAction)) {
        throw new Refusal(129, ["error: --fixed-value only applies with 'value-pattern'"]);
      }
      return;
    }
    if (sectionAction && (hasPattern || this.all || this.fixedValue)) {
      throw new Refusal(129, [`error: unknown option for ${action.kind}`]);
    }
    if ((action.kind === "unset" || action.kind === "get") && this.comment !== undefined) {
      throw new Refusal(129, ["error: unknown option `comment'"]);
    }
    if (this.fixedValue && !hasPattern) {
      throw fatal(
        action.kind === "set" || action.kind === "add"
          ? "--fixed-value only applies with --value=<pattern>"
          : "--fixed-value only applies with 'value-pattern'",
      );
    }
    if (action.kind === "add" && hasPattern) {
      throw fatal("--append cannot be used with --value=<pattern>");
    }
    if (action.kind === "get" && this.defaultValue !== undefined && this.all) {
      throw fatal("--default= cannot be used with --all or --url=");
    }
    if (action.kind !== "get" && this.defaultValue !== undefined) {
      throw new Refusal(129, ["error: unknown option `default'"]);
    }
  }

  /** `get`: the values of the key in the file or the whole configuration, filtered. */
  private async runGet(key: string): Promise<ConfigCommandResult> {
    const parsed = parseConfigKey(key);
    if ("status" in parsed) return result(1, [`error: ${parsed.error}`]);
    let matcher: ((value: string | undefined) => boolean) | undefined;
    const pattern = this.valuePattern;
    if (pattern !== undefined && this.fixedValue) {
      matcher = (value) => pattern === (value ?? "");
    } else if (pattern !== undefined) {
      const invert = pattern.startsWith("!");
      const source = invert ? pattern.slice(1) : pattern;
      let regex: ReturnType<typeof compilePosixRegex>;
      try {
        regex = compilePosixRegex(encodeGitPath(source), { extended: true });
      } catch (error) {
        if (!(error instanceof PosixRegexError)) throw error;
        return result(6, [`error: invalid pattern: ${source}`]);
      }
      matcher = (value) => invert !== regex.test(encodeGitPath(value ?? ""));
    }
    const all = await this.readValues(parsed.key);
    const values = matcher ? all.filter(matcher) : all;
    if (values.length === 0 && this.defaultValue !== undefined) {
      return {
        ...result(0, this.warnings),
        stdout: `${this.defaultValue}\n`,
        values: [this.defaultValue],
      };
    }
    const shown = this.all ? values : values.slice(-1);
    return {
      ...result(values.length > 0 ? 0 : 1, this.warnings),
      stdout: shown.map((v) => `${v ?? ""}\n`).join(""),
      values,
    };
  }

  /** Every value of the canonical `key`: in the scope's file, or the whole configuration. */
  private async readValues(key: string): Promise<(string | undefined)[]> {
    if (this.scope === undefined && this.file === undefined) {
      const config = this.workingCopy.config as GitWorkingCopyConfig | undefined;
      if (!config || typeof config.getAllWithOrigin !== "function") {
        const value = this.workingCopy.config?.[key];
        return value === undefined ? [] : [value === true ? undefined : String(value)];
      }
      return config.getAllWithOrigin(key).map((e) => e.text);
    }
    const location = await this.location();
    const reader = new GitWorkingCopyConfig(
      {
        read: async (path) => {
          // read through its links, as git's open; one it cannot open is warned about
          const read = await readConfigFileThroughLinks(location.files, path);
          if (read.kind === "error" || read.kind === "directory") {
            const reason = read.kind === "error" ? read.reason : "Is a directory";
            this.warnings.push(`warning: unable to access '${location.name}': ${reason}`);
            return undefined;
          }
          return read.kind === "file" ? read.bytes : undefined;
        },
        write: async () => {
          throw new Error("read only");
        },
      },
      location.path,
      { includes: false },
    );
    try {
      await reader.load();
    } catch (error) {
      if (error instanceof ConfigParseError) {
        throw fatal(`bad config line ${error.line} in file ${location.name}`);
      }
      throw error;
    }
    return reader.getAllWithOrigin(key).map((e) => e.text);
  }

  /** The working copy's configuration, read again after a write (git's `repo_config_clear`). */
  private async reloadConfig(): Promise<void> {
    const config = this.workingCopy.config as { load?: () => Promise<void> } | undefined;
    if (config instanceof GitWorkingCopyConfig) await config.load();
  }

  /** git's `location_options_init`: the file the scope names. */
  private async location(): Promise<ConfigFileLocation> {
    const environment = hostEnvironmentOf(this.workingCopy);
    if (this.file !== undefined) return this.fileLocation(this.file, environment);
    if (this.scope === "global") {
      const path = await globalConfigPath(environment);
      if (path === undefined) throw fatal("$HOME not set");
      return hostLocation(path, environment);
    }
    if (this.scope === "system") {
      const path = environment?.systemConfig;
      if (path === undefined) {
        throw new GitApiError(
          "cannot use --system: the host environment names no system configuration file",
        );
      }
      return hostLocation(path, environment);
    }
    const config = this.repositoryConfig();
    let path = config.filePath;
    if (this.scope === "worktree") {
      const enabled = config.getLocal("extensions.worktreeConfig");
      const on = enabled.length > 0 && isTrue(enabled[enabled.length - 1]);
      if (on) path = config.worktreeFilePath;
      else if (((await this.workingCopy.worktrees?.list()) ?? []).length > 1) {
        throw fatal(
          "--worktree cannot be used with multiple working trees unless the config\n" +
            'extension worktreeConfig is enabled. Please read "CONFIGURATION FILE"\n' +
            'section in "git help worktree" for details',
        );
      }
    }
    const files = config.configFiles.storage as FilesApi;
    return { files, path, name: path };
  }

  /** The repository's configuration, which must be backed by files to be edited. */
  private repositoryConfig(): GitWorkingCopyConfig {
    const config = this.workingCopy.config;
    if (!(config instanceof GitWorkingCopyConfig) || !config.configFiles.storage) {
      throw new GitApiError("cannot edit the configuration: it is not stored in files");
    }
    return config;
  }

  /** `--file <path>`: a host path, or one relative to the worktree top. */
  private fileLocation(
    path: string,
    environment: GitHostEnvironment | undefined,
  ): ConfigFileLocation {
    if (path.startsWith("/")) return hostLocation(path, environment);
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) {
      throw new GitApiError(`cannot use --file ${path}: there is no worktree to resolve it in`);
    }
    const root = worktree.getRoot().replace(/\/+$/, "");
    return { files, path: root ? `${root}/${path}` : path, name: path };
  }
}

/** A result of the lines git wrote on stderr. */
function result(exitCode: number, lines: string[]): ConfigCommandResult {
  return {
    exitCode,
    stdout: "",
    stderr: lines.length > 0 ? `${lines.join("\n")}\n` : "",
  };
}

/** `--comment` as git writes it, or git's death. */
function prepared(comment: string): string {
  try {
    return prepareConfigComment(comment);
  } catch (error) {
    throw fatal((error as Error).message);
  }
}

/** A host path written through the host environment's storage. */
function hostLocation(
  path: string,
  environment: GitHostEnvironment | undefined,
): ConfigFileLocation {
  const host = environment?.hostFilesOf?.(path);
  if (!host) {
    throw new GitApiError(
      `cannot write ${path}: the host environment gives no access to its files`,
    );
  }
  return { files: host.files, path: host.path, name: path };
}

/**
 * git's `git_global_config`: `$GIT_CONFIG_GLOBAL`, else `~/.gitconfig` unless it cannot be
 * read and `$XDG_CONFIG_HOME/git/config` can.
 */
async function globalConfigPath(
  environment: GitHostEnvironment | undefined,
): Promise<string | undefined> {
  if (environment?.globalConfig) return environment.globalConfig;
  const user = expandUserPath("~/.gitconfig", environment);
  if (user === undefined) return undefined;
  const xdg = xdgConfigPath(environment, "config");
  if (
    xdg !== undefined &&
    (await environment?.readFile(user)) === undefined &&
    (await environment?.readFile(xdg)) !== undefined
  ) {
    return xdg;
  }
  return user;
}

/** git's `git_config_bool` of a value as the configuration gives it. */
function isTrue(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  const text = String(value).toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  const n = Number(text);
  return text !== "" && Number.isFinite(n) && n !== 0;
}
