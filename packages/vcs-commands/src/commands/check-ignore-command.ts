/**
 * `git check-ignore` (builtin/check-ignore.c): which paths the ignore rules exclude, and with
 * `-v` the pattern that decides (`<source>:<line>:<pattern>\t<path>`).
 *
 * @example
 * ```typescript
 * // git check-ignore -v build/out.o
 * await git.checkIgnore().setVerbose(true).addPath("build/out.o").call();
 * // { exitCode: 0, stdout: ".gitignore:1:build/\tbuild/out.o\n", stderr: "" }
 * ```
 */

import { expandUserPath, type IgnoreMatch, xdgConfigPath } from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { quotePath } from "../results/quote-path.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { configBool, configValue } from "./merge-config.js";
import { DO_MATCH_DIRECTORY, matchPathspec, parsePathspecItem } from "./pathspec.js";
import { directoryPrefix, inputRecords, prefixPath } from "./plumbing-input.js";
import { worktreeHostPath } from "./submodule-model.js";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;
const S_IFDIR = 0o040000;

/**
 * `git check-ignore [-q] [-v [-n]] [--no-index] (<pathname>... | --stdin [-z])`: each path the
 * ignore rules exclude is printed (as given, C-quoted as `core.quotePath` asks); with `-v`
 * the deciding pattern before it, negated patterns too, and with `-n` the paths no pattern
 * matches (`::\t<path>`). A path the index holds (or a directory holding one) is never
 * checked, unless `--no-index`. Exit status 0 when a path was printed with a pattern, 1 when
 * none, 128 for git's deaths (its argument errors, a path beyond a symbolic link or inside a
 * submodule, a bare repository). Paths are read against {@link setCurrentDirectory}.
 */
export class CheckIgnoreCommand extends GitCommand<PlumbingTextOutput> {
  private readonly paths: string[] = [];
  private stdin?: Uint8Array;
  private nul = false;
  private quiet = false;
  private verbose = false;
  private nonMatching = false;
  private noIndex = false;
  private prefix = "";

  /** A path to check. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--stdin`: the paths of this input (git's stdin). */
  setStdin(input: string | Uint8Array): this {
    this.checkCallable();
    this.stdin = typeof input === "string" ? new TextEncoder().encode(input) : input;
    return this;
  }

  /** `-z`: NUL-terminated input and output records. */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /** `-q`: print nothing, only the exit status. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** `-v`: the deciding pattern too. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `-n` (with `-v`): the paths no pattern matches too. */
  setNonMatching(nonMatching: boolean): this {
    this.checkCallable();
    this.nonMatching = nonMatching;
    return this;
  }

  /** `--no-index`: paths the index holds are checked too. */
  setNoIndex(noIndex: boolean): this {
    this.checkCallable();
    this.noIndex = noIndex;
    return this;
  }

  /** The directory git runs in, from the top of the worktree (paths are relative to it). */
  setCurrentDirectory(dir: string): this {
    this.checkCallable();
    this.prefix = directoryPrefix(dir);
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    let stdout = "";
    const stderr = "";
    const die = (message: string, exitCode = 128) => ({
      exitCode,
      stdout,
      stderr: `${stderr}fatal: ${message}\n`,
    });
    if (this.stdin !== undefined) {
      if (this.paths.length > 0) return die("cannot specify pathnames with --stdin");
    } else {
      if (this.nul) return die("-z only makes sense with --stdin");
      if (this.paths.length === 0) return die("no path specified");
    }
    if (this.quiet) {
      if (this.paths.length > 1) return die("--quiet is only valid with a single pathname");
      if (this.verbose) return die("cannot have both --quiet and --verbose");
    }
    if (this.nonMatching && !this.verbose) {
      return die("--non-matching is only valid with --verbose");
    }
    const worktree = "worktree" in this._workingCopy ? this._workingCopy.worktree : undefined;
    if (!worktree?.ignoreMatch) return die("this operation must be run in a work tree");
    const staging = this.noIndex ? undefined : this._workingCopy.checkout?.staging;
    const index = staging ? await this.indexEntries() : [];
    const quoteFully = configBool(this._workingCopy, "core.quotePath", true);
    const sources = await this.sourceNames();
    let ignored = 0;

    const top = await worktreeHostPath(this._workingCopy);
    const checkOne = async (original: string): Promise<string | undefined> => {
      const full = prefixPath(this.prefix, original, top);
      if (full === undefined) {
        return `${original}: '${original}' is outside repository at '${top ?? ""}'`;
      }
      const path = full.replace(/\/+$/, "");
      // PATHSPEC_SYMLINK_LEADING_PATH
      const parts = path.split("/");
      for (let k = 1; k < parts.length; k++) {
        const entry = await worktree.getEntry(parts.slice(0, k).join("/")).catch(() => undefined);
        if (entry && (entry.mode & S_IFMT) === S_IFLNK) {
          return `pathspec '${original}' is beyond a symbolic link`;
        }
      }
      if (staging) {
        // die_path_inside_submodule
        for (const e of index) {
          if ((e.mode & S_IFMT) === S_IFGITLINK && path.startsWith(`${e.path}/`)) {
            return `Pathspec '${original}' is in submodule '${e.path}'`;
          }
        }
      }
      let match: IgnoreMatch | undefined;
      if (!staging || !this.seenInIndex(full, index)) {
        match = await worktree.ignoreMatch?.(path);
        if (!this.verbose && match?.negated) match = undefined;
      }
      if (!this.quiet && (match || this.nonMatching))
        stdout += this.line(original, match, sources, quoteFully);
      if (match) ignored++;
      return undefined;
    };

    const run = async () => {
      if (this.stdin === undefined) {
        for (const path of this.paths) {
          const death = await checkOne(path);
          if (death) return die(death);
        }
      } else {
        const { records, badlyQuoted } = inputRecords(this.stdin, this.nul);
        for (const path of records) {
          const death = await checkOne(path);
          if (death) return die(death);
        }
        if (badlyQuoted) return die("line is badly quoted");
      }
      return { exitCode: ignored ? 0 : 1, stdout, stderr };
    };
    return worktree.batch ? worktree.batch(run) : run();
  }

  /** One output record (`output_pattern`). */
  private line(
    path: string,
    match: IgnoreMatch | undefined,
    sources: { info: string; excludes: string | undefined },
    quoteFully: boolean,
  ): string {
    let source = "";
    if (match) {
      const s = match.source;
      source =
        s.kind === "directory"
          ? `${s.directory ? `${s.directory}/` : ""}.gitignore`
          : s.kind === "exclude" && s.name === "info/exclude"
            ? sources.info
            : s.kind === "exclude" && s.name === "core.excludesFile"
              ? (sources.excludes ?? "")
              : "";
    }
    if (this.nul) {
      if (!this.verbose) return `${path}\0`;
      return match ? `${source}\0${match.line}\0${match.pattern}\0${path}\0` : `\0\0\0${path}\0`;
    }
    if (!this.verbose) return `${quotePath(path, quoteFully)}\n`;
    const where = match
      ? `${quotePath(source, quoteFully)}:${match.line}:${match.pattern}\t`
      : "::\t";
    return `${where}${quotePath(path, quoteFully)}\n`;
  }

  /** The index's entries git asks (`PS_HEED_SKIP_WORKTREE`: skip-worktree ones left out). */
  private async indexEntries(): Promise<{ path: string; mode: number }[]> {
    const staging = this._workingCopy.checkout.staging;
    const out: { path: string; mode: number }[] = [];
    for await (const e of staging.entries()) {
      if (!(e as { skipWorktree?: boolean }).skipWorktree) out.push({ path: e.path, mode: e.mode });
    }
    return out;
  }

  /** `find_pathspecs_matching_against_index`: whether the element names an index entry. */
  private seenInIndex(full: string, index: { path: string; mode: number }[]): boolean {
    let item: ReturnType<typeof parsePathspecItem>;
    try {
      item = parsePathspecItem(full === "" ? "." : full);
    } catch {
      return false;
    }
    for (const e of index) {
      const dir = (e.mode & S_IFMT) === S_IFGITLINK || (e.mode & S_IFMT) === S_IFDIR;
      if (matchPathspec([item], e.path, dir ? DO_MATCH_DIRECTORY : 0)) return true;
    }
    return false;
  }

  /** How git names the exclude files in `-v` lines. */
  private async sourceNames(): Promise<{ info: string; excludes: string | undefined }> {
    const environment = hostEnvironmentOf(this._workingCopy);
    const configured = configValue(this._workingCopy, "core.excludesFile");
    const excludes =
      typeof configured === "string" && configured !== ""
        ? expandUserPath(configured, environment)
        : xdgConfigPath(environment, "ignore");
    // git_path_info_exclude: the git directory as setup names it (`.git` at the top)
    const gitDir = (this._workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
    const top = await worktreeHostPath(this._workingCopy);
    const trimmed = gitDir?.replace(/\/+$/, "");
    const info =
      trimmed === undefined || (top !== undefined && trimmed === `${top.replace(/\/+$/, "")}/.git`)
        ? ".git/info/exclude"
        : `${trimmed}/info/exclude`;
    return { info, excludes };
  }
}
