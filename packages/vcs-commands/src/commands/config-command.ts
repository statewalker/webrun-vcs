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
 *
 * Reads follow `git config --get`, `--get-all`, `--get-regexp`, `--get-urlmatch`, `--list`,
 * `--get-color` and `--get-colorbool` (and 2.46's `get [--all] [--regexp] [--url=<url>]` and
 * `list`): values canonicalised by {@link ConfigCommand.setType} as builtin/config.c's
 * `format_config` (`--type=bool|int|bool-or-int|bool-or-str|path|expiry-date|color`; `set`
 * writes them as `normalize_value`), `--default`, `--show-origin`, `--show-scope`,
 * `--name-only`, `--show-names`, `-z`, and `--blob=<rev>:<path>`.
 *
 * ```typescript
 * const { stdout } = await git.config().list().setShowOrigin(true).call(); // "file:.git/config\tcore.bare=false\n"
 * await git.config().get("pack.window").setType("int").call(); // "1024\n" for `1k`
 * await git.config().getUrlmatch("http", "https://example.com/repo").call(); // "http.sslverify false\n"
 * await git.config().getRegexp("^remote\\.").setBlob("HEAD:shared.config").call();
 * ```
 */

import {
  CONFIG_REGEX_NONE,
  type ConfigFileLocation,
  ConfigParseError,
  type ConfigScope,
  GitWorkingCopyConfig,
  parseConfigKey,
  prepareConfigComment,
  readConfigFileThroughLinks,
  renameConfigSectionInFile,
  setConfigMultivarInFile,
} from "@statewalker/vcs-store-files";
import {
  compilePosixRegex,
  isUrlNormalizeError,
  normalizeUrl,
  PosixRegexError,
  selectUrlMatches,
} from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  expandUserPath,
  type GitHostEnvironment,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { quotePath } from "../results/quote-path.js";
import {
  CONFIG_VALUE_TYPES,
  type ConfigValueContext,
  ConfigValueDeath,
  type ConfigValueSource,
  type ConfigValueType,
  type FormattedConfigValue,
  formatConfigValue,
  gitConfigBool,
  gitConfigColorBool,
  normalizeConfigValue,
  parseGitColor,
} from "./config-value-types.js";
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
  | { kind: "get-regexp"; pattern: string }
  | { kind: "get-urlmatch"; name: string; url: string }
  | { kind: "list" }
  | { kind: "get-color"; slot: string; defaultColor?: string }
  | { kind: "get-colorbool"; slot: string; stdoutIsTty?: string }
  | { kind: "set"; key: string; value: string }
  | { kind: "add"; key: string; value: string }
  | { kind: "unset"; key: string }
  | { kind: "rename-section"; from: string; to: string }
  | { kind: "remove-section"; name: string };

/** One value as a query reads it, with where it was read (git's `key_value_info`). */
interface QueryEntry extends ConfigValueSource {
  /** The canonical key */
  key: string;
  /** The value as written; undefined for a key without `=` */
  text: string | undefined;
  /** The scope of the value (`--show-scope`) */
  scope?: ConfigScope;
  /** Its line in its file or blob */
  line?: number;
}

/** builtin/config.c's display terminators. */
interface Display {
  term: string;
  keyDelim: string;
  showKeys: boolean;
  omitValues: boolean;
}

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
  /** git's command reads no core settings: an unparsable `core.whitespace` does not stop it */
  protected override readsCoreConfig(): boolean {
    return false;
  }

  private action?: ConfigAction;
  private scope?: ConfigCommandScope;
  private file?: string;
  private all = false;
  private valuePattern?: string;
  private fixedValue = false;
  private comment?: string;
  private defaultValue?: string;
  private legacy = false;
  private type?: ConfigValueType;
  private blob?: string;
  private includes?: boolean;
  private showOrigin = false;
  private showScope = false;
  private nameOnly = false;
  private showNames = false;
  private nullTerminated = false;
  private compatibility: "2.43" | "2.56" = "2.56";
  private dumbTerminal = false;
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
   * `--get-regexp <pattern>` / `get --regexp <pattern>`: the keys matching a POSIX extended
   * regex (its section and last part lowered, as git does). The legacy syntax prints every
   * value with its key; the subcommand only the last value unless {@link setAll}, with its
   * key under {@link setShowNames}.
   */
  getRegexp(pattern: string): this {
    return this.setAction({ kind: "get-regexp", pattern });
  }

  /**
   * `--get-urlmatch <name> <url>` / `get --url=<url> <name>`: the value of `<section>.<key>`
   * (or, for a bare section, of each of its keys with the key) that best matches the URL
   * among `<section>.<url-pattern>.<key>` entries (urlmatch.c).
   */
  getUrlmatch(name: string, url: string): this {
    return this.setAction({ kind: "get-urlmatch", name, url });
  }

  /** `--list` / `list`: every value, `key=value` per line. */
  list(): this {
    return this.setAction({ kind: "list" });
  }

  /**
   * `--get-color <slot> [<default>]`: the escape sequence of the color the slot is set to
   * (the default's when unset), with no newline.
   */
  getColor(slot: string, defaultColor?: string): this {
    return this.setAction({
      kind: "get-color",
      slot,
      ...(defaultColor !== undefined ? { defaultColor } : {}),
    });
  }

  /**
   * `--get-colorbool <slot> [<stdout-is-tty>]`: whether color is wanted for the slot (falling
   * back to `diff.color` for `color.diff`, then `color.ui`). With `stdoutIsTty` (a boolean as
   * git reads it) git prints `true`/`false`; without, the exit status tells (stdout is no
   * terminal here). `auto` needs a terminal that is not dumb ({@link setDumbTerminal}).
   */
  getColorBool(slot: string, stdoutIsTty?: string): this {
    return this.setAction({
      kind: "get-colorbool",
      slot,
      ...(stdoutIsTty !== undefined ? { stdoutIsTty } : {}),
    });
  }

  /**
   * `--type=<type>` (`--bool`, `--int`, `--bool-or-int`, `--bool-or-str`, `--path`,
   * `--expiry-date`, `--type=color`): values printed canonical, and written canonical by
   * `set`/`add`. A name git does not know is refused when the command runs (git's
   * `unrecognized --type argument`).
   */
  setType(type: ConfigValueType | string | undefined): this {
    this.checkCallable();
    this.type = type as ConfigValueType | undefined;
    return this;
  }

  /** `--blob=<blob-ish>`: read the configuration from a blob (`HEAD:shared.config`). */
  setBlob(blob: string | undefined): this {
    this.checkCallable();
    this.blob = blob;
    return this;
  }

  /**
   * `--includes` / `--no-includes` for a file read with {@link setScope} or {@link setFile}
   * (default off there, as git; the whole configuration always follows them).
   */
  setIncludes(includes: boolean | undefined): this {
    this.checkCallable();
    this.includes = includes;
    return this;
  }

  /** `--show-origin`: each value after `file:<name>`, `blob:<name>` or `command line:`. */
  setShowOrigin(show: boolean): this {
    this.checkCallable();
    this.showOrigin = show;
    return this;
  }

  /** `--show-scope`: each value after its scope (`local`, `global`, `command`, ...). */
  setShowScope(show: boolean): this {
    this.checkCallable();
    this.showScope = show;
    return this;
  }

  /** `--name-only`: keys without their values (`--list`, `--get-regexp`). */
  setNameOnly(nameOnly: boolean): this {
    this.checkCallable();
    this.nameOnly = nameOnly;
    return this;
  }

  /** `--show-names` (2.46's `get`): each value after its key. */
  setShowNames(show: boolean): this {
    this.checkCallable();
    this.showNames = show;
    return this;
  }

  /** `-z` / `--null`: values end with NUL, a key and its value separated by a newline. */
  setNullTerminated(nul: boolean): this {
    this.checkCallable();
    this.nullTerminated = nul;
    return this;
  }

  /**
   * The git version whose behaviour applies where they differ (default 2.56): 2.43's `--list`
   * ignores `--type`, knows no `:(optional)` paths nor `#rgb` colors, and dies on a
   * `--get-color` default it cannot parse (2.5x: an error, exit 255).
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  /** Whether the terminal is dumb (`TERM` unset or `dumb`): `--get-colorbool`'s `auto`. */
  setDumbTerminal(dumb: boolean): this {
    this.checkCallable();
    this.dumbTerminal = dumb;
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
    if (this.type !== undefined && !CONFIG_VALUE_TYPES.includes(this.type)) {
      throw fatal(`unrecognized --type argument, ${this.type}`);
    }
    const sources =
      (this.scope !== undefined ? 1 : 0) +
      (this.file !== undefined ? 1 : 0) +
      (this.blob !== undefined ? 1 : 0);
    if (sources > 1) throw new Refusal(129, ["error: only one config file at a time"]);
    this.checkOptions(action);
    const comment = this.comment === undefined ? undefined : prepared(this.comment);
    switch (action.kind) {
      case "get":
        // cmd_config_get: `get --type=color --default=<color> ""` is `--get-color "" <color>`
        if (
          !this.legacy &&
          this.type === "color" &&
          action.key === "" &&
          this.defaultValue !== undefined
        ) {
          return this.runGetColor("", this.defaultValue);
        }
        return this.runGet(action.key, false);
      case "get-regexp":
        return this.runGet(action.pattern, true);
      case "list":
        return this.runList();
      case "get-urlmatch":
        return this.runUrlmatch(action.name, action.url);
      case "get-color":
        return this.runGetColor(action.slot, action.defaultColor);
      case "get-colorbool":
        return this.runGetColorBool(action.slot, action.stdoutIsTty);
    }
    if (this.blob !== undefined) throw fatal("writing config blobs is not supported");
    const location = await this.location();
    let outcome: { status: number; stderr: string[] };
    switch (action.kind) {
      case "set":
      case "add": {
        const pattern =
          action.kind === "add" ? CONFIG_REGEX_NONE : (this.valuePattern ?? undefined);
        const value = this.normalized(action.key, action.value);
        outcome = await setConfigMultivarInFile(location, action.key, value, {
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

  /** builtin/config.c's `normalize_value` of a value to write, or git's death. */
  private normalized(key: string, value: string): string {
    try {
      return normalizeConfigValue(this.type, key, value, this.compatibility);
    } catch (error) {
      if (error instanceof ConfigValueDeath) throw new Refusal(128, error.lines);
      throw error;
    }
  }

  /** The option checks git makes before it reads or writes anything. */
  private checkOptions(action: ConfigAction): void {
    const hasPattern = this.valuePattern !== undefined;
    const sectionAction = action.kind === "rename-section" || action.kind === "remove-section";
    const reads = new Set([
      "get",
      "get-regexp",
      "get-urlmatch",
      "list",
      "get-color",
      "get-colorbool",
    ]);
    if (this.legacy) {
      // cmd_config_actions: the action's argument count, then the option combinations
      if (
        (action.kind === "get-color" || action.kind === "get-colorbool") &&
        this.type !== undefined
      ) {
        throw new Refusal(129, ["error: --get-color and variable type are incoherent"]);
      }
      if (action.kind === "add" && hasPattern) {
        throw new Refusal(129, ["error: wrong number of arguments, should be 2"]);
      }
      if (sectionAction && (hasPattern || this.all)) {
        throw new Refusal(129, ["error: only one action at a time"]);
      }
      if (this.nameOnly && !(action.kind === "list" || action.kind === "get-regexp")) {
        throw new Refusal(129, ["error: --name-only is only applicable to --list or --get-regexp"]);
      }
      if (
        this.showOrigin &&
        !(action.kind === "get" || action.kind === "get-regexp" || action.kind === "list")
      ) {
        throw new Refusal(129, [
          "error: --show-origin is only applicable to --get, --get-all, --get-regexp, and --list",
        ]);
      }
      if (this.defaultValue !== undefined && (action.kind !== "get" || this.all)) {
        throw new Refusal(129, ["error: --default is only applicable to --get"]);
      }
      if (this.comment !== undefined && !(action.kind === "set" || action.kind === "add")) {
        throw new Refusal(129, [
          "error: --comment is only applicable to add/set/replace operations",
        ]);
      }
      if (
        this.fixedValue &&
        (!hasPattern ||
          action.kind === "add" ||
          sectionAction ||
          action.kind === "list" ||
          action.kind === "get-urlmatch" ||
          action.kind === "get-color" ||
          action.kind === "get-colorbool")
      ) {
        throw new Refusal(129, ["error: --fixed-value only applies with 'value-pattern'"]);
      }
      return;
    }
    if (action.kind === "get-color" || action.kind === "get-colorbool") {
      throw new GitApiError(
        "git config has no get-color subcommand: use the legacy syntax (setLegacySyntax)",
      );
    }
    if (sectionAction && (hasPattern || this.all || this.fixedValue)) {
      throw new Refusal(129, [`error: unknown option for ${action.kind}`]);
    }
    if (reads.has(action.kind) && this.comment !== undefined) {
      throw new Refusal(129, ["error: unknown option `comment'"]);
    }
    if (action.kind === "list") {
      if (hasPattern) throw new Refusal(129, ["error: unknown option `value'"]);
      if (this.defaultValue !== undefined) {
        throw new Refusal(129, ["error: unknown option `default'"]);
      }
      return;
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
    const getLike =
      action.kind === "get" || action.kind === "get-regexp" || action.kind === "get-urlmatch";
    if (
      getLike &&
      this.defaultValue !== undefined &&
      (this.all || action.kind === "get-urlmatch")
    ) {
      throw fatal("--default= cannot be used with --all or --url=");
    }
    if (action.kind === "get-urlmatch" && (this.all || hasPattern)) {
      throw fatal("--url= cannot be used with --all, --regexp or --value");
    }
    if (!getLike && this.defaultValue !== undefined) {
      throw new Refusal(129, ["error: unknown option `default'"]);
    }
  }

  /** The display options as builtin/config.c's `display_options_init` sets them. */
  private display(list: boolean): Display {
    const nul = this.nullTerminated;
    return {
      term: nul ? "\0" : "\n",
      keyDelim: nul ? "\n" : list ? "=" : " ",
      showKeys: list,
      omitValues: this.nameOnly,
    };
  }

  /** What a value's formatting needs from the host. */
  private valueContext(): ConfigValueContext {
    const environment = hostEnvironmentOf(this.workingCopy);
    return {
      compatibility: this.compatibility,
      home: environment?.home,
      now: this.clock(),
      userHome: async (name) => environment?.expandUserHome?.(name),
      isMissing: async (path) => {
        try {
          if (path.startsWith("/")) {
            if (environment?.statFile) return (await environment.statFile(path)) === undefined;
            return (await environment?.readFile(path)) === undefined;
          }
          const worktree = this.worktreeAccess;
          const files = worktree?.getFiles?.();
          if (!worktree || !files) return true;
          const root = worktree.getRoot().replace(/\/+$/, "");
          return (await files.stats(root ? `${root}/${path}` : path)) === undefined;
        } catch {
          return true;
        }
      },
    };
  }

  /**
   * builtin/config.c's `format_config`: scope, origin, key and the value as typed, ended
   * with the terminator; a death of git's thrown as a {@link Refusal}.
   */
  private async format(
    display: Display,
    entry: QueryEntry,
    key: string,
    gently: boolean,
    typed = true,
  ): Promise<{ text: string } | { skip: true } | { error: string[]; partial: string }> {
    const sep = this.nullTerminated ? "\0" : "\t";
    let text = "";
    if (this.showScope) text += `${entry.scope ?? "unknown"}${sep}`;
    if (this.showOrigin) {
      text += `${entry.origin}:${this.nullTerminated ? entry.name : quotePath(entry.name)}${sep}`;
    }
    if (display.showKeys) text += key;
    if (!display.omitValues) {
      if (display.showKeys) text += display.keyDelim;
      if (this.type === undefined || !typed) {
        if (entry.text !== undefined) text += entry.text;
        else if (display.showKeys) text = text.slice(0, -display.keyDelim.length);
      } else {
        let formatted: FormattedConfigValue;
        try {
          formatted = await formatConfigValue(
            this.type,
            key,
            entry.text,
            entry,
            this.valueContext(),
            gently,
          );
        } catch (error) {
          if (error instanceof ConfigValueDeath) throw new Refusal(128, error.lines);
          throw error;
        }
        if ("skip" in formatted) return formatted;
        if ("error" in formatted) return { error: formatted.error, partial: text };
        text += formatted.ok;
      }
    }
    return { text: text + display.term };
  }

  /**
   * A value that failed to format while git read the configuration: the read stops with git's
   * `bad config line` (or the command line's) death after the formatter's error.
   */
  private configReadDeath(entry: QueryEntry, lines: string[]): Refusal {
    const where =
      entry.origin === "command line"
        ? "fatal: unable to parse command-line config"
        : entry.origin === "blob"
          ? `fatal: bad config line ${entry.line ?? 0} in blob ${entry.name}`
          : entry.origin === "file"
            ? `fatal: bad config line ${entry.line ?? 0} in file ${entry.name}`
            : `fatal: bad config line ${entry.line ?? 0} in ${entry.name}`;
    return new Refusal(128, [...this.warnings, ...lines, where]);
  }

  /** `get` / `--get[-all]` / `--get-regexp`: builtin/config.c's `get_value`. */
  private async runGet(name: string, keyRegexp: boolean): Promise<ConfigCommandResult> {
    let matchKey: (key: string) => boolean;
    if (keyRegexp) {
      // git lowers the section (up to the first dot) and the part after the last dot
      const lastDot = name.lastIndexOf(".");
      const firstDot = name.indexOf(".");
      let lowered = name;
      if (lastDot < 0) lowered = name.toLowerCase();
      else {
        lowered =
          name.slice(0, firstDot).toLowerCase() +
          name.slice(firstDot, lastDot + 1) +
          name.slice(lastDot + 1).toLowerCase();
      }
      let regex: ReturnType<typeof compilePosixRegex>;
      try {
        regex = compilePosixRegex(encodeGitPath(lowered), { extended: true });
      } catch (error) {
        if (!(error instanceof PosixRegexError)) throw error;
        return result(6, [`error: invalid key pattern: ${name}`]);
      }
      matchKey = (key) => regex.test(encodeGitPath(key));
    } else {
      const parsed = parseConfigKey(name);
      if ("status" in parsed) return result(1, [`error: ${parsed.error}`]);
      matchKey = (key) => key === parsed.key;
    }
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
    const entries = await this.readEntries(false);
    const display = this.display(false);
    const all = keyRegexp && this.legacy ? true : this.all;
    display.showKeys = keyRegexp && this.legacy ? true : this.showNames;
    const matched = entries.filter((e) => matchKey(e.key) && (!matcher || matcher(e.text)));
    const shown: string[] = [];
    const values: (string | undefined)[] = [];
    for (const entry of matched) {
      const formatted = await this.format(display, entry, entry.key, false);
      if ("error" in formatted) throw this.configReadDeath(entry, formatted.error);
      if ("skip" in formatted) continue;
      shown.push(formatted.text);
      values.push(entry.text);
    }
    if (shown.length === 0 && this.defaultValue !== undefined) {
      const param: QueryEntry = {
        key: name,
        text: this.defaultValue,
        origin: "command line",
        name: "",
        scope: "command",
      };
      const formatted = await this.format(display, param, name, false);
      if ("error" in formatted) {
        throw new Refusal(128, [
          ...this.warnings,
          ...formatted.error,
          `fatal: failed to format default config value: ${this.defaultValue}`,
        ]);
      }
      if ("text" in formatted) {
        return {
          ...result(0, this.warnings),
          stdout: formatted.text,
          values: [this.defaultValue],
        };
      }
    }
    const printed = all ? shown : shown.slice(-1);
    return {
      ...result(shown.length > 0 ? 0 : 1, this.warnings),
      stdout: printed.join(""),
      values,
    };
  }

  /** `list` / `--list`: builtin/config.c's `show_all_config` over the whole read. */
  private async runList(): Promise<ConfigCommandResult> {
    const entries = await this.readEntries(true);
    const display = this.display(true);
    const errors: string[] = [];
    let stdout = "";
    for (const entry of entries) {
      // 2.43 prints values as written whatever the type; 2.5x drops those it cannot format
      const formatted = await this.format(
        display,
        entry,
        entry.key,
        true,
        this.compatibility !== "2.43",
      );
      if ("text" in formatted) stdout += formatted.text;
      else if ("error" in formatted) errors.push(...formatted.error);
    }
    return { ...result(0, [...this.warnings, ...errors]), stdout };
  }

  /** `--get-urlmatch` / `get --url=`: builtin/config.c's `get_urlmatch`. */
  private async runUrlmatch(name: string, url: string): Promise<ConfigCommandResult> {
    const normalized = normalizeUrl(url);
    if (isUrlNormalizeError(normalized)) throw fatal(normalized.error);
    const lowered = name.toLowerCase();
    const dot = lowered.indexOf(".");
    const section = dot < 0 ? lowered : lowered.slice(0, dot);
    const key = dot < 0 ? undefined : lowered.slice(dot + 1);
    const entries = await this.readEntries(false);
    const chosen = selectUrlMatches(entries, section, normalized, key);
    const display = this.display(false);
    display.showKeys = key === undefined;
    display.omitValues = false;
    let stdout = "";
    const errors: string[] = [];
    for (const [synthetic, entry] of chosen) {
      const formatted = await this.format(display, entry, synthetic, false);
      if ("text" in formatted) stdout += formatted.text;
      else if ("error" in formatted) {
        errors.push(...formatted.error);
        // 2.43 writes what it formatted before the failure, unterminated
        if (this.compatibility === "2.43") stdout += formatted.partial;
      }
    }
    return { ...result(chosen.size > 0 ? 0 : 1, [...this.warnings, ...errors]), stdout };
  }

  /** `--get-color`: builtin/config.c's `get_color`. */
  private async runGetColor(
    slot: string,
    defaultColor: string | undefined,
  ): Promise<ConfigCommandResult> {
    const entries = await this.readEntries(false);
    let parsed = "";
    let found = false;
    for (const entry of entries) {
      if (entry.key !== slot) continue;
      const lines = entry.text === undefined ? [`error: missing value for '${slot}'`] : [];
      const color =
        entry.text === undefined ? undefined : parseGitColor(entry.text, this.compatibility);
      if (color === undefined) {
        throw this.configReadDeath(entry, [
          ...lines,
          `error: invalid color value: ${entry.text ?? ""}`,
        ]);
      }
      parsed = color;
      found = true;
    }
    if (!found && defaultColor !== undefined) {
      const color = parseGitColor(defaultColor, this.compatibility);
      if (color === undefined) {
        const invalid = `error: invalid color value: ${defaultColor}`;
        if (this.compatibility === "2.43") {
          throw new Refusal(128, [invalid, "fatal: unable to parse default color value"]);
        }
        return result(255, [
          ...this.warnings,
          invalid,
          "error: unable to parse default color value",
        ]);
      }
      parsed = color;
    }
    return { ...result(0, this.warnings), stdout: parsed };
  }

  /** `--get-colorbool`: builtin/config.c's `get_colorbool`. */
  private async runGetColorBool(
    slot: string,
    stdoutIsTty: string | undefined,
  ): Promise<ConfigCommandResult> {
    let tty = false;
    try {
      if (stdoutIsTty !== undefined) tty = gitConfigBool("command line", stdoutIsTty);
      const entries = await this.readEntries(false);
      let found: "never" | "always" | "auto" | undefined;
      let diff: typeof found;
      let ui: typeof found;
      for (const entry of entries) {
        if (entry.key === slot) found = gitConfigColorBool(entry.key, entry.text);
        else if (entry.key === "diff.color") diff = gitConfigColorBool(entry.key, entry.text);
        else if (entry.key === "color.ui") ui = gitConfigColorBool(entry.key, entry.text);
      }
      if (found === undefined) {
        if (slot === "color.diff") found = diff;
        if (found === undefined) found = ui;
      }
      const wanted = (found ?? "auto") === "auto" ? tty && !this.dumbTerminal : found === "always";
      if (stdoutIsTty !== undefined) {
        return { ...result(0, this.warnings), stdout: wanted ? "true\n" : "false\n" };
      }
      return result(wanted ? 0 : 1, this.warnings);
    } catch (error) {
      if (error instanceof ConfigValueDeath)
        throw new Refusal(128, [...this.warnings, ...error.lines]);
      throw error;
    }
  }

  /**
   * The entries read, in git's order: of the blob, of the scope's file or `--file`, or of the
   * whole configuration. A source `list` cannot read is git's death there; `get` reads it as
   * empty.
   */
  private async readEntries(list: boolean): Promise<QueryEntry[]> {
    if (this.blob !== undefined) return this.readBlobEntries(list);
    if (this.scope === undefined && this.file === undefined) {
      const config = this.workingCopy.config as GitWorkingCopyConfig | undefined;
      if (!config) return [];
      if (typeof config.listWithOrigin !== "function") return plainConfigEntries(config);
      return config.listWithOrigin().map((e) => ({
        key: e.key,
        text: e.text,
        origin: e.file !== undefined ? "file" : e.scope === "command" ? "command line" : "",
        name: e.file ?? "",
        ...(e.scope !== undefined ? { scope: e.scope } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
      }));
    }
    const location = await this.location();
    const environment = hostEnvironmentOf(this.workingCopy);
    const scope: ConfigScope =
      this.file !== undefined
        ? "command"
        : this.scope === "global"
          ? "global"
          : this.scope === "system"
            ? "system"
            : "local";
    let failure: string | undefined;
    const reader = new GitWorkingCopyConfig(
      {
        read: async (path) => {
          // read through its links, as git's open; one it cannot open is warned about
          const read = await readConfigFileThroughLinks(location.files, path);
          if (read.kind === "error" || read.kind === "directory") {
            const reason = read.kind === "error" ? read.reason : "Is a directory";
            if (path === location.path) {
              this.warnings.push(`warning: unable to access '${location.name}': ${reason}`);
              failure = reason;
            }
            return undefined;
          }
          if (read.kind === "absent" && path === location.path) {
            failure = "No such file or directory";
          }
          return read.kind === "file" ? read.bytes : undefined;
        },
        write: async () => {
          throw new Error("read only");
        },
      },
      location.path,
      {
        includes: this.includes ?? false,
        fileOnly: true,
        ...(environment ? { environment } : {}),
      },
    );
    try {
      await reader.load();
    } catch (error) {
      if (error instanceof ConfigParseError) {
        throw fatal(`bad config line ${error.line} in file ${location.name}`);
      }
      throw error;
    }
    if (failure !== undefined && list) {
      throw new Refusal(128, [
        ...this.warnings,
        `fatal: unable to read config file '${location.name}': ${failure}`,
      ]);
    }
    // the file alone: not the `config.worktree` its `extensions.worktreeConfig` would add
    return reader
      .listWithOrigin()
      .filter((e) => e.scope !== "worktree")
      .map((e) => {
        const bare = (path: string) => path.replace(/^\/+/, "");
        const own = e.file === undefined || bare(e.file) === bare(location.path);
        return {
          key: e.key,
          text: e.text,
          origin: "file",
          name: own
            ? scope === "local"
              ? bare(location.name)
              : location.name
            : (e.file as string),
          scope,
          ...(e.line !== undefined ? { line: e.line } : {}),
        };
      });
  }

  /** `--blob=<blob-ish>`: git's `git_config_from_blob_ref`. */
  private async readBlobEntries(list: boolean): Promise<QueryEntry[]> {
    const name = this.blob as string;
    const refuse = (line: string): QueryEntry[] => {
      if (list) throw new Refusal(128, [line, "fatal: error processing config file(s)"]);
      this.warnings.push(line);
      return [];
    };
    let id: string | undefined;
    try {
      id = await this.revisionResolver().resolve(name);
    } catch {
      id = undefined;
    }
    if (id === undefined) return refuse(`error: unable to resolve config blob '${name}'`);
    const bytes =
      (await this.revisionResolver().objectType(id)) === "blob"
        ? await this.readBlob(id)
        : undefined;
    if (bytes === undefined) return refuse(`error: reference '${name}' does not point to a blob`);
    const reader = new GitWorkingCopyConfig(
      {
        read: async () => bytes,
        write: async () => {
          throw new Error("read only");
        },
      },
      "blob",
      // the blob alone: its own `extensions.worktreeConfig` adds no `config.worktree`
      { includes: false, fileOnly: true },
    );
    try {
      await reader.load();
    } catch (error) {
      if (error instanceof ConfigParseError) {
        return refuse(`error: bad config line ${error.line} in blob ${name}`);
      }
      throw error;
    }
    return reader.listWithOrigin().map((e) => ({
      key: e.key,
      text: e.text,
      origin: "blob",
      name,
      scope: "command",
      ...(e.line !== undefined ? { line: e.line } : {}),
    }));
  }

  /** A blob's bytes. */
  private async readBlob(id: string): Promise<Uint8Array | undefined> {
    const content = await this.blobs.load(id);
    if (!content) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of content) {
      chunks.push(c);
      size += c.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
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
      return await hostLocation(path, environment);
    }
    if (this.scope === "system") {
      const path = environment?.systemConfig;
      if (path === undefined) {
        throw new GitApiError(
          "cannot use --system: the host environment names no system configuration file",
        );
      }
      return await hostLocation(path, environment);
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
  private async fileLocation(
    path: string,
    environment: GitHostEnvironment | undefined,
  ): Promise<ConfigFileLocation> {
    if (path.startsWith("/")) return await hostLocation(path, environment);
    const worktree = this.worktreeAccess;
    const files = worktree?.getFiles?.();
    if (!worktree || !files) {
      throw new GitApiError(`cannot use --file ${path}: there is no worktree to resolve it in`);
    }
    const root = worktree.getRoot().replace(/\/+$/, "");
    return { files, path: root ? `${root}/${path}` : path, name: path };
  }
}

/**
 * The entries of a configuration held as a plain object (a `MemoryWorkingCopy`'s): `true`
 * for a key without a value, an array for several values, anything else as its string.
 */
function plainConfigEntries(config: Record<string, unknown>): QueryEntry[] {
  const out: QueryEntry[] = [];
  for (const [name, raw] of Object.entries(config)) {
    if (typeof raw === "function" || raw === undefined || raw === null) continue;
    const parsed = parseConfigKey(name);
    const key = "status" in parsed ? name : parsed.key;
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      out.push({
        key,
        text: v === true ? undefined : String(v),
        origin: "",
        name: "",
      });
    }
  }
  return out;
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
async function hostLocation(
  path: string,
  environment: GitHostEnvironment | undefined,
): Promise<ConfigFileLocation> {
  const host = await environment?.hostFilesOf?.(path);
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
