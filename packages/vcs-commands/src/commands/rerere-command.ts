/**
 * `git rerere` (builtin/rerere.c): with no subcommand, rerere's record and replay (what the
 * merge family runs on conflicts and `git commit` after a commit); `clear`, `forget
 * <pathspec>`, `status`, `remaining`, `diff` and `gc`.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.rerere().setSubcommand("status").call(); // "f\n"
 * await git.rerere().setSubcommand("forget").addPath("f").call();
 * ```
 */

import { rerereGc } from "@statewalker/vcs-store-files";
import { unifiedDiff } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitCommand } from "../git-command.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { matchPathspec, parsePathspec } from "./pathspec.js";
import {
  RerereError,
  type RerereHost,
  rerereClear,
  rerereDiff,
  rerereForget,
  rerereGcLocation,
  rerereRemaining,
  rerereStatus,
  runRerere,
} from "./rerere.js";

/** The subcommands of `git rerere` (`record` is the bare `git rerere`). */
export type RerereSubcommand =
  | "record"
  | "clear"
  | "forget"
  | "status"
  | "remaining"
  | "diff"
  | "gc";

const USAGE =
  "usage: git rerere [clear | forget <pathspec>... | diff | status | remaining | gc]\n\n" +
  "    --[no-]rerere-autoupdate\n" +
  "                          register clean resolutions in index\n\n";

/**
 * `git rerere [--[no-]rerere-autoupdate] [<subcommand>]`: git's stdout, stderr and exit
 * status.
 */
export class RerereCommand extends GitCommand<PlumbingTextOutput> {
  private subcommand = "record";
  private readonly paths: string[] = [];
  private autoUpdate?: boolean;

  /** The subcommand (default `record`, the bare `git rerere`); an unknown one is git's usage */
  setSubcommand(subcommand: RerereSubcommand | string): this {
    this.checkCallable();
    this.subcommand = subcommand;
    return this;
  }

  /** A pathspec element of `forget` */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--rerere-autoupdate` (true) / `--no-rerere-autoupdate` (false) */
  setAutoUpdate(value: boolean): this {
    this.checkCallable();
    this.autoUpdate = value;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    const stderr = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
    try {
      return await this.run(stderr);
    } catch (error) {
      if (error instanceof RerereError) {
        return { exitCode: error.exitCode, stdout: "", stderr: stderr(error.lines) };
      }
      throw error;
    }
  }

  private async run(stderr: (lines: string[]) => string): Promise<PlumbingTextOutput> {
    const host = this.rerereHost();
    const empty = { exitCode: 0, stdout: "", stderr: "" };
    switch (this.subcommand) {
      case "record": {
        if (!host) return empty;
        await this.staging.read();
        const out = await runRerere(
          host,
          this.autoUpdate === undefined ? {} : { autoUpdate: this.autoUpdate },
        );
        return { exitCode: 0, stdout: "", stderr: stderr(out.messages) };
      }
      case "forget": {
        if (!host) return empty;
        await this.staging.read();
        const items = parsePathspec(this.paths.length > 0 ? this.paths : ["."]);
        const out = await rerereForget(host, (path) => matchPathspec(items, path, 0) > 0);
        return { exitCode: 0, stdout: "", stderr: stderr(out.messages) };
      }
      case "clear": {
        if (!host) return empty;
        const out = await rerereClear(host);
        return { exitCode: 0, stdout: "", stderr: stderr(out.messages) };
      }
      case "status": {
        if (!host) return empty;
        const paths = await rerereStatus(host);
        return { exitCode: 0, stdout: paths.map((p) => `${p}\n`).join(""), stderr: "" };
      }
      case "remaining": {
        if (!host) return empty;
        await this.staging.read();
        const paths = await rerereRemaining(host);
        return { exitCode: 0, stdout: paths.map((p) => `${p}\n`).join(""), stderr: "" };
      }
      case "diff": {
        if (!host) return empty;
        const out = await rerereDiff(host, (minus, plus) =>
          unifiedDiff(minus, plus, {
            context: 3,
            algorithm: "myers",
            findFunction: () => undefined,
          }),
        );
        const bytes = out.stdout.reduce((n, b) => n + b.length, 0);
        const all = new Uint8Array(bytes);
        let at = 0;
        for (const b of out.stdout) {
          all.set(b, at);
          at += b.length;
        }
        return {
          exitCode: out.fatal ? 128 : 0,
          stdout: decodeGitPath(all),
          stderr: out.fatal ? `fatal: ${out.fatal}\n` : "",
        };
      }
      case "gc": {
        const location = await rerereGcLocation(this.workingCopy);
        if (location) {
          const environment = hostEnvironmentOf(this.workingCopy);
          await rerereGc({ ...location, ...(environment ? { environment } : {}) });
        }
        return empty;
      }
      default:
        return { exitCode: 129, stdout: "", stderr: USAGE };
    }
  }

  /** The bytes git writes on stdout for `diff` are its paths' bytes. */
  static stdoutBytes(output: PlumbingTextOutput): Uint8Array {
    return encodeGitPath(output.stdout);
  }

  private rerereHost(): RerereHost | undefined {
    const worktree = this.worktreeAccess;
    if (!worktree) return undefined;
    return {
      workingCopy: this.workingCopy,
      staging: this.staging,
      worktree,
      blobs: this.blobs,
      objectFormat: this.objectFormat,
    };
  }
}
