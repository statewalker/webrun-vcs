/**
 * The plumbing diffs: `git diff-tree`, `git diff-index` and `git diff-files` (builtin/diff-tree.c,
 * builtin/diff-index.c, builtin/diff-files.c), on top of {@link DiffCommand}'s comparisons and
 * {@link LogCommand}'s log_tree_commit.
 *
 * ```typescript
 * // git diff-tree -r -z HEAD~1 HEAD
 * const raw = await git.diffTree().addArgument("HEAD~1").addArgument("HEAD")
 *   .setRecursive(true).setNullTerminated(true).call();
 *
 * // git diff-files --name-status
 * const text = await git.diffFiles().setFormats(["name-status"]).callText();
 * ```
 *
 * Their defaults are git's plumbing ones: the raw format (`:<modes> <ids> <status>\t<path>`)
 * with full ids unless `--abbrev` is given, no rename detection unless `-M`/`-C` asks, no
 * `diff.*` porcelain configuration (`git_diff_basic_config`).
 */

import { decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { DiffCommand, type DiffOutputFormat, type DiffTextOptions } from "../diff-command.js";
import { LogCommand } from "../log-command.js";

/** The name formats and `--check` turn the others off (diff.c's diff_setup_done) */
const EXCLUSIVE_FORMATS: readonly DiffOutputFormat[] = ["name-only", "name-status", "check"];

/** What the plumbing diffs share: formats, diff options, pathspec */
export abstract class DiffPlumbingCommand extends GitCommand<Uint8Array> {
  protected formats?: DiffOutputFormat[];
  protected textOptions: DiffTextOptions = {};
  protected pathspec: string[] = [];
  private abbrevGiven = false;

  /**
   * The outputs, as their options ask (`--raw`, `-p`, `--stat`, `--name-only`...; the raw
   * format alone by default). `--patch-with-raw` is `["raw", "patch"]`, `--patch-with-stat`
   * `["stat", "patch"]`.
   */
  setFormats(formats: DiffOutputFormat[]): this {
    this.checkCallable();
    this.formats = [...formats];
    return this;
  }

  /** Diff options (`-M`, `-C`, `-B`, `-R`, `-U<n>`, `--diff-filter`, `-O`, ...) */
  setOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.textOptions = { ...this.textOptions, ...options };
    return this;
  }

  /** The paths compared (git's pathspec) */
  setPathspec(paths: string[]): this {
    this.checkCallable();
    this.pathspec = [...paths];
    return this;
  }

  /**
   * `--abbrev[=<n>]`: the raw output's ids abbreviated (at least `n` digits, unique), as
   * the patches' `index` lines are anyway
   */
  setAbbrev(length?: number): this {
    this.checkCallable();
    this.abbrevGiven = true;
    if (length !== undefined) this.textOptions = { ...this.textOptions, abbrev: length };
    return this;
  }

  /** `-z`: NUL-terminated fields, paths unquoted */
  setNullTerminated(z: boolean): this {
    this.checkCallable();
    this.textOptions = { ...this.textOptions, nullTerminated: z };
    return this;
  }

  /** The output as text (paths decoded as {@link decodeGitPath} decodes them) */
  async callText(): Promise<string> {
    return decodeGitPath(await this.call());
  }

  /** The formats asked for, git's default otherwise, with diff_setup_done's exclusions */
  protected outputFormats(fallback: DiffOutputFormat = "raw"): DiffOutputFormat[] {
    const formats = this.formats && this.formats.length > 0 ? this.formats : [fallback];
    const exclusive = formats.find((f) => EXCLUSIVE_FORMATS.includes(f));
    return exclusive ? [exclusive] : formats;
  }

  /** Whether a format needs the whole tree walked (anything but raw and the names) */
  protected impliesRecursive(formats: DiffOutputFormat[]): boolean {
    return formats.some((f) => f !== "raw" && f !== "name-only" && f !== "name-status");
  }

  /** The diff options of a plumbing run: no ui configuration, no renames unless asked */
  protected plumbingOptions(): DiffTextOptions {
    const o = this.textOptions;
    return {
      uiConfig: false,
      rawFullIds: !this.abbrevGiven,
      ...(o.findRenames === undefined && (o.findCopies === undefined || o.findCopies === false)
        ? { findRenames: false }
        : {}),
      ...o,
    };
  }

  /** A DiffCommand set up with the run's options and pathspec */
  protected diffCommand(): DiffCommand {
    const diff = new DiffCommand(this.workingCopy).shareReadsOf(this);
    diff.setRenames(false).setOptions(this.plumbingOptions());
    if (this.pathspec.length > 0) diff.setPathspec(this.pathspec);
    return diff;
  }

  /** The bytes a DiffCommand prints for these formats (nothing for an empty diff) */
  protected async printed(diff: DiffCommand, formats: DiffOutputFormat[]): Promise<Uint8Array> {
    const shown = await diff.callFormats(formats);
    return shown.bytes ?? new Uint8Array(0);
  }
}

/** How `git diff-tree` shows a merge: not at all (default), `-m`, `-c` or `--cc` */
export type DiffTreeMerges = "none" | "separate" | "combined" | "dense-combined";

/**
 * `git diff-tree [--stdin] [-m] [-c | --cc] [-r] [-t] [--root] [--no-commit-id] [--pretty]
 * <tree-ish> [<tree-ish>] [<path>...]`.
 *
 * Two tree-ishes are compared as trees; one names a commit, shown with its id (or its log
 * with `--pretty`) and its diff against its parent, nothing when that diff is empty (a root
 * commit only with `--root`, a merge only with `-m`, `-c` or `--cc`). `--stdin` reads
 * `<commit> [<parent>...]` lines (the parents grafted for that diff) and `<tree> <tree>` lines
 * (printed before their diff); any other line is echoed. Without `-r` the top tree's entries
 * are compared (subtrees as `040000` entries); a patch or a stat walks the whole tree.
 */
export class DiffTreeCommand extends DiffPlumbingCommand {
  private args: string[] = [];
  private recursive = false;
  private showTrees = false;
  private root = false;
  private stdin?: string;
  private merges: DiffTreeMerges = "none";
  private noCommitId = false;
  private pretty?: string;

  /** A tree-ish (one: a commit; two: the trees compared) */
  addArgument(treeish: string): this {
    this.checkCallable();
    this.args.push(treeish);
    return this;
  }

  /** `-r`: the subtrees' contents compared */
  setRecursive(recursive: boolean): this {
    this.checkCallable();
    this.recursive = recursive;
    return this;
  }

  /** `-t`: the subtrees shown too on the way to their contents (implies `-r`) */
  setShowTrees(show: boolean): this {
    this.checkCallable();
    this.showTrees = show;
    return this;
  }

  /** `--root`: a root commit shown against the empty tree */
  setRoot(root: boolean): this {
    this.checkCallable();
    this.root = root;
    return this;
  }

  /** `--stdin`: the lines read (git's standard input) */
  setStdin(input: string | Uint8Array): this {
    this.checkCallable();
    this.stdin = typeof input === "string" ? input : decodeGitPath(input);
    return this;
  }

  /** `-m`, `-c`, `--cc`: how a merge is shown */
  setMerges(merges: DiffTreeMerges): this {
    this.checkCallable();
    this.merges = merges;
    return this;
  }

  /** `--no-commit-id`: no commit id before a commit's diff */
  setNoCommitId(noCommitId: boolean): this {
    this.checkCallable();
    this.noCommitId = noCommitId;
    return this;
  }

  /** `--pretty[=<format>]`: the commit's log instead of its id (`medium` for `--pretty`) */
  setPretty(format: string): this {
    this.checkCallable();
    this.pretty = format;
    return this;
  }

  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const formats = this.outputFormats(this.merges === "dense-combined" ? "patch" : "raw");
    if (this.args.length > 2) {
      throw new GitApiError(`usage: git diff-tree [--stdin] [-m] [-s] [-v] [--no-commit-id]`, {
        exitCode: 129,
      });
    }
    if (this.args.length === 0 && this.stdin === undefined) {
      throw new GitApiError("usage: git diff-tree [--stdin] [-m] [-s] [-v] [--no-commit-id]", {
        exitCode: 129,
      });
    }
    const out: Uint8Array[] = [];
    if (this.args.length === 2) {
      out.push(await this.diffTrees(this.args[0] as string, this.args[1] as string, formats));
    } else if (this.args.length === 1) {
      // diff_tree_commit_oid: a commit (a tag peeled to it); a tree shows nothing
      const id = await this.resolveTreeish(this.args[0] as string);
      const commit = (await this.revisionResolver().peelTags(id)).id;
      if ((await this.objectKind(commit)) === "commit") {
        out.push(await this.commitOrTree(commit, undefined, formats));
      }
    }
    if (this.stdin !== undefined) {
      const encoder = new TextEncoder();
      for (const line of linesOf(this.stdin)) {
        const parsed = parseStdinLine(line, this.objectFormat.hexLength);
        if (!parsed) {
          out.push(encoder.encode(line));
          continue;
        }
        const [first, ...rest] = parsed;
        const kind = await this.objectKind(first as string);
        if (kind === "tree") {
          if (rest.length !== 1) continue;
          out.push(encoder.encode(`${first} ${rest[0]}\n`));
          out.push(await this.diffTrees(first as string, rest[0] as string, formats));
        } else if (kind === "commit") {
          out.push(
            await this.commitOrTree(first as string, rest.length ? rest : undefined, formats),
          );
        }
      }
    }
    return concat(out);
  }

  /** The tree walk the run asks for (diff_setup_done: a patch or a stat recurses) */
  private walk(formats: DiffOutputFormat[]): "recursive" | "flat" | "show-trees" {
    if (this.showTrees) return "show-trees";
    return this.recursive || this.impliesRecursive(formats) ? "recursive" : "flat";
  }

  /** Two trees compared: their diff alone */
  private async diffTrees(a: string, b: string, formats: DiffOutputFormat[]): Promise<Uint8Array> {
    const diff = this.diffCommand()
      .setOldTree(a)
      .setNewTree(b)
      .setRotateStrict(true)
      .setTreeWalk(this.walk(formats));
    return this.printed(diff, formats);
  }

  /** One commit (its log and diff), or the tree a single argument names against nothing */
  private async commitOrTree(
    id: string,
    parents: readonly string[] | undefined,
    formats: DiffOutputFormat[],
  ): Promise<Uint8Array> {
    const log = new LogCommand(this.workingCopy)
      .shareReadsOf(this)
      .setLogConfig(false)
      .setNoWalk([{ id, ...(parents ? { parents } : {}) }])
      .setTreeWalk(this.walk(formats))
      .setDiffOptions(this.plumbingOptions());
    for (const path of this.pathspec) log.addPath(path);
    const has = (f: DiffOutputFormat) => formats.includes(f);
    return log.callBytes({
      diffTree: true,
      raw: has("raw"),
      patch: has("patch"),
      stat: has("stat"),
      numstat: has("numstat"),
      shortstat: has("shortstat"),
      summary: has("summary"),
      nameOnly: has("name-only"),
      nameStatus: has("name-status"),
      check: has("check"),
      showRoot: this.root,
      abbrevCommit: false,
      mailmap: false,
      decorate: "no",
      ...(this.merges === "separate" ? { m: true } : {}),
      ...(this.merges === "combined" ? { c: true } : {}),
      ...(this.merges === "dense-combined" ? { cc: true } : {}),
      ...(this.merges === "none" ? { diffMerges: "off" as const } : {}),
      ...(this.pretty !== undefined ? { pretty: this.pretty } : {}),
      ...(this.pretty === undefined || !/%N/.test(this.pretty) ? { notes: false } : {}),
      ...(this.noCommitId ? { noCommitId: true } : {}),
    });
  }

  /** A tree-ish's object id (a commit's, or a tree's for a tree) */
  private async resolveTreeish(name: string): Promise<string> {
    const id = await this.revisionResolver().resolve(name);
    if (!id) throw new GitApiError(`fatal: ambiguous argument '${name}': unknown revision`);
    return id;
  }

  /** Whether an id names a commit or a tree (anything else: undefined) */
  private async objectKind(id: string): Promise<"commit" | "tree" | undefined> {
    const history = this.workingCopy.history;
    if (await history?.commits.has(id)) return "commit";
    if (await history?.trees.has(id)) return "tree";
    return undefined;
  }
}

/**
 * `git diff-index [--cached] <tree-ish> [<path>...]`: a tree against the index
 * (`--cached`) or against the worktree, the index telling which files are unchanged by their
 * stat; a worktree file whose stat differs shows the null id in the raw output.
 */
export class DiffIndexCommand extends DiffPlumbingCommand {
  private tree?: string;
  private cached = false;

  /** The tree-ish compared */
  setTree(treeish: string): this {
    this.checkCallable();
    this.tree = treeish;
    return this;
  }

  /** `--cached`: the index, not the worktree */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    if (this.tree === undefined) {
      throw new GitApiError("usage: git diff-index [-m] [--cached] [--merge-base]", {
        exitCode: 129,
      });
    }
    const formats = this.outputFormats();
    const diff = this.diffCommand()
      .setOldTree(this.tree)
      .setCached(this.cached)
      .setIntentToAddVisible(this.cached)
      .setPlumbingWorktree(true);
    return this.printed(diff, formats);
  }
}

/**
 * `git diff-files [<path>...]`: the index against the worktree, by the entries' stat (a file
 * whose stat differs is listed even when its content did not change, its raw id the null
 * id); an unmerged path is listed as `U`, then against stage 2.
 */
export class DiffFilesCommand extends DiffPlumbingCommand {
  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const formats = this.outputFormats();
    return this.printed(this.diffCommand().setPlumbingWorktree(true), formats);
  }
}

/** The lines of git's stdin, each with its line end (a last one without) */
function linesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * diff_tree_stdin: a line of hex ids separated by single spaces, ending in a newline (the
 * ids, or undefined for a line git echoes)
 */
function parseStdinLine(line: string, hexLength: number): string[] | undefined {
  if (!line.endsWith("\n")) return undefined;
  const body = line.slice(0, -1);
  const hex = /^[0-9a-f]+$/;
  const ids: string[] = [];
  let at = 0;
  while (at < body.length) {
    const id = body.slice(at, at + hexLength);
    if (id.length !== hexLength || !hex.test(id)) break;
    ids.push(id);
    at += hexLength;
    if (body[at] !== " ") break;
    at++;
  }
  return ids.length > 0 ? ids : undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
