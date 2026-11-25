/**
 * `git var` (builtin/var.c): git's logical variables (`GIT_AUTHOR_IDENT`, `GIT_EDITOR`,
 * `GIT_PAGER`, `GIT_DEFAULT_BRANCH`, the configuration and attribute files ...), one asked
 * for, or all of them after the configuration (`-l`).
 *
 * @example
 * ```typescript
 * // git var GIT_AUTHOR_IDENT
 * await git.var().setVariable("GIT_AUTHOR_IDENT").call();
 * // { exitCode: 0, stdout: "A U Thor <author@example.com> 1112911993 -0700\n", stderr: "" }
 * ```
 */

import { formatPersonIdent } from "@statewalker/vcs-core";
import {
  expandUserPath,
  type GitHostEnvironment,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { isValidBranchName } from "./default-branch.js";
import { authorIdentOf, committerIdentOf, hostEnvironmentOf } from "./git-ident.js";

/** The variables `git var` knows, in the order `-l` lists them. */
export const GIT_VARIABLES = [
  "GIT_COMMITTER_IDENT",
  "GIT_AUTHOR_IDENT",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_DEFAULT_BRANCH",
  "GIT_SHELL_PATH",
  "GIT_ATTR_SYSTEM",
  "GIT_ATTR_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
] as const;

/** A variable of {@link GIT_VARIABLES}. */
export type GitVariable = (typeof GIT_VARIABLES)[number];

const USAGE = "usage: git var (-l | <variable>)\n";

/** git's `normalize_path_copy`: `//`, `.` and `..` components resolved (undefined above `/`). */
function normalizePath(path: string): string | undefined {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part === "" && i < parts.length - 1) continue;
    if (part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined;
}

/**
 * `git var -l` (every configuration variable as `key=value`, then every variable with a
 * value) or `git var <variable>` (its value; exit 1 when it has none, usage and 129 for an
 * unknown name). Identities are git's `fmt_ident` of the environment and configuration (strict
 * when asked for alone); the editor is `GIT_EDITOR`, `core.editor`, `VISUAL` (unless the
 * terminal is dumb), `EDITOR`, else `vi` (none on a dumb terminal); the pager `GIT_PAGER`,
 * `core.pager`, `PAGER`, else `less` (`cat` for an empty one; the host environment's
 * `defaultEditor` and `defaultPager` name another build's defaults); the shell `/bin/sh`; the
 * file paths those of the host environment.
 */
export class VarCommand extends GitCommand<PlumbingTextOutput> {
  private variable?: string;
  private list = false;

  /** The variable to print. */
  setVariable(name: GitVariable | string): this {
    this.checkCallable();
    this.variable = name;
    return this;
  }

  /** `-l`: the configuration, then every variable. */
  setList(list: boolean): this {
    this.checkCallable();
    this.list = list;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    const usage = { exitCode: 129, stdout: "", stderr: USAGE };
    if (this.list === (this.variable !== undefined)) return usage;
    if (this.list) {
      let stdout = "";
      for (const { key, text } of RemoteConfigStore.from(
        this._workingCopy,
      ).allEntriesWithOrigin() ?? []) {
        stdout += text === undefined ? `${key}\n` : `${key}=${text}\n`;
      }
      for (const name of GIT_VARIABLES) {
        let value: string | undefined;
        try {
          value = this.read(name, false);
        } catch (error) {
          if (error instanceof GitApiError)
            return { exitCode: 128, stdout, stderr: `${error.message}\n` };
          throw error;
        }
        if (value === undefined) continue;
        // the global files, one per line
        const lines = name === "GIT_CONFIG_GLOBAL" && value !== "" ? value.split("\n") : [value];
        for (const line of lines) stdout += `${name}=${line}\n`;
      }
      return { exitCode: 0, stdout, stderr: "" };
    }
    const name = this.variable as string;
    if (!(GIT_VARIABLES as readonly string[]).includes(name)) return usage;
    let value: string | undefined;
    try {
      value = this.read(name as GitVariable, true);
    } catch (error) {
      if (error instanceof GitApiError)
        return { exitCode: 128, stdout: "", stderr: `${error.message}\n` };
      throw error;
    }
    if (value === undefined) return { exitCode: 1, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
  }

  /** A variable's value, undefined when it has none. */
  private read(name: GitVariable, strict: boolean): string | undefined {
    const environment = hostEnvironmentOf(this._workingCopy);
    const config = RemoteConfigStore.from(this._workingCopy);
    const programs = environment?.programVariables ?? {};
    switch (name) {
      case "GIT_COMMITTER_IDENT":
        return formatPersonIdent(committerIdentOf(this._workingCopy, { strict }));
      case "GIT_AUTHOR_IDENT":
        return formatPersonIdent(authorIdentOf(this._workingCopy, { strict }));
      case "GIT_EDITOR":
        return this.editor(environment, config);
      case "GIT_SEQUENCE_EDITOR":
        return (
          programs.GIT_SEQUENCE_EDITOR ??
          config.value("sequence.editor") ??
          this.editor(environment, config)
        );
      case "GIT_PAGER": {
        const pager =
          programs.GIT_PAGER ??
          config.value("core.pager") ??
          programs.PAGER ??
          environment?.defaultPager ??
          "less";
        return pager === "" || pager === "cat" ? "cat" : pager;
      }
      case "GIT_DEFAULT_BRANCH": {
        const configured = config.value("init.defaultBranch");
        if (configured === undefined) return environment?.breakingChanges ? "main" : "master";
        if (!isValidBranchName(configured)) {
          throw new GitApiError(`fatal: invalid branch name: init.defaultBranch = ${configured}`);
        }
        return configured;
      }
      case "GIT_SHELL_PATH":
        return "/bin/sh";
      case "GIT_ATTR_SYSTEM":
        return environment?.systemAttributes !== undefined
          ? normalizePath(environment.systemAttributes)
          : undefined;
      case "GIT_ATTR_GLOBAL": {
        const configured = config.value("core.attributesFile");
        const path =
          configured !== undefined
            ? expandUserPath(configured, environment)
            : xdgConfigPath(environment, "attributes");
        return path === undefined ? undefined : normalizePath(path);
      }
      case "GIT_CONFIG_SYSTEM":
        return environment?.systemConfig !== undefined
          ? normalizePath(environment.systemConfig)
          : undefined;
      case "GIT_CONFIG_GLOBAL": {
        // git_global_config_paths: $GIT_CONFIG_GLOBAL alone, else the XDG file and ~/.gitconfig
        const paths =
          environment?.globalConfig !== undefined
            ? [environment.globalConfig]
            : [xdgConfigPath(environment, "config"), expandUserPath("~/.gitconfig", environment)];
        const found = paths
          .filter((p): p is string => p !== undefined && p !== "")
          .map((p) => normalizePath(p) ?? p);
        return found.length > 0 ? found.join("\n") : undefined;
      }
    }
  }

  /** git_editor */
  private editor(
    environment: GitHostEnvironment | undefined,
    config: RemoteConfigStore,
  ): string | undefined {
    const programs = environment?.programVariables ?? {};
    const term = programs.TERM;
    const dumb = term === undefined || term === "dumb";
    let editor = programs.GIT_EDITOR ?? config.value("core.editor");
    if (editor === undefined && !dumb) editor = programs.VISUAL;
    editor ??= programs.EDITOR;
    if (editor === undefined && dumb) return undefined;
    return editor ?? environment?.defaultEditor ?? "vi";
  }
}
