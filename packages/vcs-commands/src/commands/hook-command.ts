/**
 * `git hook run` and `git hook list` (builtin/hook.c) as library commands.
 *
 * ```typescript
 * const result = await git.hookRun("pre-commit").setArgs(["--check"]).call();
 * result.exitCode; // the hooks' exit codes or'ed together, 1 when there is none
 * result.output; // what git writes on stderr: the hooks' output and git's messages
 *
 * const listed = await git.hookList("pre-commit").setShowScope(true).call();
 * listed.stdout; // "local\tlint\nhook from hookdir\n"
 * ```
 */

import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type HookListEntry, isKnownHook } from "./git-hooks.js";

/** What {@link HookRunCommand} gave. */
export interface HookRunResult {
  /**
   * git's exit status: the hooks' exit codes or'ed together (0 when they all succeed or,
   * with `setIgnoreMissing`, none exists), 1 for a missing or unknown hook, 128 where git
   * dies (a broken `hook.*` configuration, a `--to-stdin` file it cannot open)
   */
  exitCode: number;
  /** Whether a hook ran */
  ran: boolean;
  /**
   * git's stderr: what the hooks wrote (their stdout included, as `git hook run` sends it
   * there), git's hints and warnings, and its `error:` / `fatal:` line
   */
  output: string;
}

/**
 * Run a hook, as `git hook run [--ignore-missing] [--to-stdin=<path>] <hook-name> [--
 * <hook-args>]`.
 *
 * The hooks of the name run as git's `run_hooks_opt` runs them, through the host
 * environment's hook runner: git 2.5x's configured hooks (`hook.<name>.event` /
 * `.command` / `.enabled`) first, then the hooks directory's script, each in the worktree
 * top (the git directory when bare), their output gathered in {@link HookRunResult.output}
 * (and {@link getHookOutput}). A missing hook is git's "cannot find a hook named" error
 * (exit 1) unless `setIgnoreMissing`; git 2.5x refuses a name that is not one of git's
 * hooks unless `setAllowUnknownHookName` (2.43 runs any name). The `--to-stdin` file is
 * read for each hook only when one runs; a relative path is from the directory git runs
 * in (the worktree top).
 */
export class HookRunCommand extends GitCommand<HookRunResult> {
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

  private name?: string;
  private args: string[] = [];
  private ignoreMissing = false;
  private toStdin?: string;
  private allowUnknown = false;

  /** The hook to run (`<hook-name>`). */
  setHookName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /** The arguments given to each hook (`-- <hook-args>`). */
  setArgs(args: string[]): this {
    this.checkCallable();
    this.args = [...args];
    return this;
  }

  /** `--ignore-missing`: no hook of the name is no error. */
  setIgnoreMissing(ignore: boolean): this {
    this.checkCallable();
    this.ignoreMissing = ignore;
    return this;
  }

  /** `--to-stdin=<path>`: the file each hook reads on stdin. */
  setToStdin(path: string | undefined): this {
    this.checkCallable();
    this.toStdin = path;
    return this;
  }

  /** `--allow-unknown-hook-name` (git 2.5x): run a name that is not one of git's hooks. */
  setAllowUnknownHookName(allow: boolean): this {
    this.checkCallable();
    this.allowUnknown = allow;
    return this;
  }

  async call(): Promise<HookRunResult> {
    this.checkCallable();
    this.setCallable(false);
    const name = this.name;
    if (!name) {
      throw new GitApiError("usage: git hook run <hook-name> [-- <hook-args>]", { exitCode: 129 });
    }
    const hooks = this.hooks;
    if (!hooks.enabled) {
      throw new GitApiError("cannot run hooks: the host environment has no hook runner");
    }
    const done = (exitCode: number, ran = false, message?: string): HookRunResult => {
      if (message) hooks.append(`${message}\n`);
      return { exitCode, ran, output: hooks.output };
    };
    if (hooks.compatibility !== "2.43" && !this.allowUnknown && !isKnownHook(name)) {
      return done(
        1,
        false,
        `error: unknown hook event '${name}';\nuse --allow-unknown-hook-name to allow non-native hook names`,
      );
    }
    let listed: HookListEntry[];
    try {
      listed = await hooks.listAll(name);
    } catch (error) {
      if (error instanceof GitApiError) return done(error.exitCode, false, error.message);
      throw error;
    }
    if (listed.length === 0) {
      return this.ignoreMissing
        ? done(0)
        : done(1, false, `error: cannot find a hook named ${name}`);
    }
    const runs = listed.some((h) => h.kind === "traditional" || !(h.disabled || h.eventDisabled));
    let stdin: Uint8Array | undefined;
    if (runs && this.toStdin !== undefined) {
      stdin = await hooks.readFileAt(this.toStdin);
      if (!stdin) {
        return done(
          128,
          false,
          `fatal: could not open '${this.toStdin}' for reading: No such file or directory`,
        );
      }
    }
    const result = await hooks.run(name, { args: this.args, ...(stdin ? { stdin } : {}) });
    return done(result?.exitCode ?? 0, result !== undefined);
  }
}

/** What {@link HookListCommand} gave. */
export interface HookListResult {
  /** git's exit status: 0, or 1 when no hook was found or the name is unknown */
  exitCode: number;
  /** The hooks of the event in the order they run (disabled configured ones included) */
  hooks: HookListEntry[];
  /** git's stdout: a line (`-z`: a NUL-ended record) per hook */
  stdout: string;
  /** git's stderr: its hints, warnings and `error:` line */
  output: string;
}

/**
 * List the hooks of an event, as git 2.5x's `git hook list [-z] [--show-scope] <hook-name>`:
 * a configured hook by its friendly name (`disabled\t` or `event-disabled\t` before it when
 * it does not run, its config scope first with `setShowScope`), the hooks directory's script
 * as `hook from hookdir`. No hook is git's "no hooks found" warning (exit 1). git 2.43 has no
 * `git hook list`: the command throws its usage error there.
 */
export class HookListCommand extends GitCommand<HookListResult> {
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

  private name?: string;
  private nul = false;
  private showScope = false;
  private allowUnknown = false;

  /** The event whose hooks to list (`<hook-name>`). */
  setHookName(name: string): this {
    this.checkCallable();
    this.name = name;
    return this;
  }

  /** `-z`: end each record with NUL instead of a newline. */
  setNullTerminated(nul: boolean): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /** `--show-scope`: the config scope (`local`, `global`, ...) before each configured hook. */
  setShowScope(show: boolean): this {
    this.checkCallable();
    this.showScope = show;
    return this;
  }

  /** `--allow-unknown-hook-name`: list a name that is not one of git's hooks. */
  setAllowUnknownHookName(allow: boolean): this {
    this.checkCallable();
    this.allowUnknown = allow;
    return this;
  }

  async call(): Promise<HookListResult> {
    this.checkCallable();
    this.setCallable(false);
    const hooks = this.hooks;
    if (hooks.compatibility === "2.43") {
      throw new GitApiError("error: unknown subcommand: `list'", { exitCode: 129 });
    }
    const name = this.name;
    if (!name) {
      throw new GitApiError("usage: you must specify a hook event name to list", {
        exitCode: 129,
      });
    }
    const done = (exitCode: number, listed: HookListEntry[], stdout: string, message?: string) => {
      if (message) hooks.append(`${message}\n`);
      return { exitCode, hooks: listed, stdout, output: hooks.output };
    };
    if (!this.allowUnknown && !isKnownHook(name)) {
      return done(
        1,
        [],
        "",
        `error: unknown hook event '${name}';\nuse --allow-unknown-hook-name to allow non-native hook names`,
      );
    }
    let listed: HookListEntry[];
    try {
      listed = await hooks.listAll(name);
    } catch (error) {
      if (error instanceof GitApiError) return done(error.exitCode, [], "", error.message);
      throw error;
    }
    if (listed.length === 0) {
      return done(1, [], "", `warning: no hooks found for event '${name}'`);
    }
    const end = this.nul ? "\0" : "\n";
    let stdout = "";
    for (const hook of listed) {
      if (hook.kind === "traditional") {
        stdout += `hook from hookdir${end}`;
        continue;
      }
      const disability = hook.eventDisabled
        ? "event-disabled\t"
        : hook.disabled
          ? "disabled\t"
          : "";
      const scope = this.showScope ? `${hook.scope ?? "unknown"}\t` : "";
      stdout += `${scope}${disability}${hook.name}${end}`;
    }
    return done(0, listed, stdout);
  }
}
