import {
  canonTreeMode,
  EMPTY_TREE_ID,
  type FileModeValue,
  type ObjectId,
  type TreeEntry,
  TreeEntryCursor,
} from "@statewalker/vcs-core";
import { ByteSink, parseGitBool, type XdiffAlgorithm } from "@statewalker/vcs-utils";
import { compareGitPaths, decodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  collectChunks,
  compareWithWorktree,
  expandUserPath,
  type GitHostEnvironment,
  readCleanContent,
  smudgeContent,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { NoHeadError, RefNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  DEFAULT_RENAME_LIMIT,
  detectRenames,
  findFollowSource,
  scorePercent,
} from "../rename/index.js";
import { writeCombinedDiff } from "../results/combined-diff.js";
import { ChangeType, type DiffEntry } from "../results/diff-entry.js";
import { diffEntryToPair } from "../results/diff-formatter.js";
import { orderByPatterns, parseOrderFile } from "../results/diff-order.js";
import {
  blobSide,
  computeDiffstat,
  contentSide,
  type DiffDriver,
  type DiffFilePair,
  type DiffOutputOptions,
  type DiffstatOptions,
  diffDriverOf,
  formatNameOnly,
  formatNameStatus,
  formatNumstat,
  formatShortstat,
  formatStat,
  formatSummary,
  writePairPatch,
} from "../results/diff-output.js";
import { quotePath } from "../results/quote-path.js";
import { worktreeModeTrust } from "./core-config.js";
import { textconvRunnerOf } from "./diff-textconv.js";
import { matchPathspec, type PathspecItem, parsePathspecItem } from "./pathspec.js";
import { readSubmoduleDirt } from "./status-command.js";

/** The output formats of {@link DiffCommand.callText} */
export type DiffOutputFormat =
  | "patch"
  | "stat"
  | "numstat"
  | "shortstat"
  | "summary"
  | "name-only"
  | "name-status";

/** Options of the text output that `git diff` takes on its command line */
export interface DiffTextOptions
  extends Omit<DiffOutputOptions, "driver" | "algorithm" | "indentHeuristic"> {
  /** `--diff-algorithm` (default `diff.algorithm`, else myers) */
  algorithm?: XdiffAlgorithm;
  /** `--indent-heuristic` / `--no-indent-heuristic` (default `diff.indentHeuristic`, true) */
  indentHeuristic?: boolean;
  /**
   * `--abbrev=<n>`: the `index` lines' ids at least n digits, clamped as git clamps it (below
   * 4, 0 too, is 4; above 40 is 40); the combined diffs of conflicted paths ignore it, as
   * git's do
   */
  abbrev?: number;
  /** `--stat=...` widths (default width 80, as git without a terminal) */
  stat?: DiffstatOptions;
  /**
   * Score renames counting a last line without a newline, as git 2.50 and later (default
   * true); false scores them as older git
   */
  renameCountLastSpan?: boolean;
  /**
   * With whitespace-ignoring options (`-w`, `-b`, `--ignore-space-at-eol`,
   * `--ignore-cr-at-eol`), `--name-only` and `--name-status` list only the files whose patch
   * shows a change, as git 2.5x does (default true; false lists every changed file, as
   * older git)
   */
  namesFromContents?: boolean;
  /**
   * `--no-prefix`: no `a/` and `b/` prefixes (default `diff.noprefix`); `srcPrefix` and
   * `dstPrefix` still apply on top, as if given after it
   */
  noPrefix?: boolean;
  /**
   * `--default-prefix`: `a/` and `b/`, whatever `diff.noprefix`, `diff.mnemonicPrefix`,
   * `diff.srcPrefix` and `diff.dstPrefix` say; it wins over `noPrefix`, and `srcPrefix` /
   * `dstPrefix` still apply on top
   */
  defaultPrefix?: boolean;
  /**
   * `diff.noprefix` is not read (`git format-patch` ignores it, honouring only
   * `format.noprefix`, which it passes as `noPrefix`); the other prefix settings still apply
   */
  ignoreConfigNoPrefix?: boolean;
  /**
   * `-O<orderfile>`: show the files in the order of the file's glob patterns (default
   * `diff.orderFile`); a relative path is read from the worktree's root, through the host
   * environment when it leaves the worktree (`../x`)
   */
  orderFile?: string;
  /**
   * `--textconv` / `--no-textconv`: run `diff.<driver>.textconv` on both sides of a patch
   * (default true, as `git diff`); it takes a runner registered with
   * `installTextconvRunner`, without one no textconv applies
   */
  textconv?: boolean;
}

/** What a diff compares, for `diff.mnemonicPrefix` */
type DiffSides = "trees" | "cached" | "commit-worktree" | "index-worktree";

/** git's mnemonic prefixes (`diff_set_mnemonic_prefix`) of each comparison */
const MNEMONIC_PREFIXES: Record<DiffSides, [string, string] | undefined> = {
  // builtin_diff_tree sets none: builtin_diff's own fallback, a/ and b/
  trees: undefined,
  // run_diff_index
  cached: ["c/", "i/"],
  "commit-worktree": ["c/", "w/"],
  // run_diff_files
  "index-worktree": ["i/", "w/"],
};

/** One side of a path in a tree, the index or the worktree */
interface Side {
  mode: number;
  id: ObjectId;
  read?: () => Promise<Uint8Array>;
  /** A submodule with changes of its own in the worktree ("Subproject commit <id>-dirty") */
  dirty?: boolean;
}

/** An index entry, of any stage */
type StageEntry = Parameters<typeof compareWithWorktree>[1];

/** The worktree side of an index entry, as diff-files sees it; undefined when deleted */
type WorktreeCompare = (entry: StageEntry) => Promise<Side | undefined>;

/** A conflicted path `git diff` shows as a combined diff: stages 2 and 3 against the file */
interface CombinedEntry {
  path: string;
  ours: StageEntry;
  theirs: StageEntry;
}

/** `diff.ignoreSubmodules` (git's `--ignore-submodules`); undefined when unset or invalid */
function submoduleIgnoreValue(
  value: string | undefined,
): "none" | "untracked" | "dirty" | "all" | undefined {
  const v = value?.trim().toLowerCase();
  return v === "none" || v === "untracked" || v === "dirty" || v === "all" ? v : undefined;
}

const S_IFMT = 0o170000;
const GITLINK = 0o160000;
const NULL_ID = "0".repeat(40);
const encoder = new TextEncoder();

/** git's path order: bytes, as `strcmp` */
function compareBytes(a: string, b: string): number {
  return compareGitPaths(a, b);
}

/** A git boolean (`git_config_bool`), undefined when unset or not one. */
const boolValue = (v: string | undefined): boolean | undefined => parseGitBool(v);

function intValue(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(-?\d+)([kmg]?)$/i);
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Number(m[1]) * unit;
}

/**
 * `git diff --abbrev=<n>` as revision.c's handle_revision_opt takes it (before diff.c sees
 * it; setup_revisions copies it to the diff options): below 4 (0 too) is 4, above 40 is 40
 */
function abbrevOption(value: number | undefined): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Math.min(40, Math.max(4, Math.trunc(value)));
}

/** `diff.renames` as git_config_rename reads it: `copies`/`copy` detect copies too. */
function renamesValue(value: string | undefined): boolean | "copies" | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "copies" || v === "copy") return "copies";
  return boolValue(v);
}

const ALGORITHMS: readonly string[] = ["myers", "minimal", "patience", "histogram"];
const algorithmValue = (v: string | undefined): XdiffAlgorithm | undefined => {
  const s = v?.trim().toLowerCase();
  if (s === "default") return "myers";
  return s && ALGORITHMS.includes(s) ? (s as XdiffAlgorithm) : undefined;
};

/**
 * Show changes between commits, trees, the index and the worktree.
 *
 * Equivalent to `git diff`:
 * - `setOldTree(a).setNewTree(b)`: `git diff a b`
 * - `setCached(true)` (with `setOldTree(a)`): `git diff --cached [a]` (HEAD by default)
 * - nothing set: `git diff`, the index against the worktree
 * - `setOldTree(a)` alone: `git diff a`, a commit against the worktree
 *
 * Without a worktree, the last two compare with HEAD's tree.
 *
 * `call()` gives the changed paths; `callText()` prints them as git does (patch, `--stat`,
 * `--numstat`, `--shortstat`, `--name-only`, `--name-status`), byte for byte, reading
 * `diff.algorithm`, `diff.indentHeuristic`, `diff.context`, `diff.interHunkContext`,
 * `diff.renames`, `diff.renameLimit`, `diff.statNameWidth`, `diff.statGraphWidth`,
 * `core.quotePath`, `core.bigFileThreshold`, `core.abbrev`, `diff.ignoreSubmodules`,
 * `diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`, `diff.dstPrefix`,
 * `diff.orderFile` and the `diff` attribute's drivers (`diff.<driver>.xfuncname`,
 * `.funcname`, `.binary`, `.algorithm`, `.textconv`, `.cachetextconv`, builtin drivers).
 *
 * The prefixes follow git's porcelain: `diff.mnemonicPrefix` gives `i/` and `w/` for the
 * index against the worktree, `c/` and `w/` for a commit against it, `c/` and `i/` for
 * `--cached`, and `a/` and `b/` between two trees. Textconv runs through the runner the host
 * registers with `installTextconvRunner` (running a command is not portable); without one no
 * textconv applies, as `git diff --no-textconv`; it reads a blob as checkout writes it
 * (smudged) and a worktree file as it is, as git's `prepare_temp_file`. A relative order
 * file is read from the worktree's root (one outside it, `../x`, through the host
 * environment).
 *
 * As git: a conflicted path is, in `git diff`, the combined diff (`diff --cc`) of stages 2
 * and 3 against the worktree file, printed before the other files (in the other formats, an
 * unmerged entry and stage 2 against the worktree), and in `git diff A` the worktree file;
 * a submodule with changes of its own is `Subproject commit <id>-dirty`; `index` lines
 * abbreviate ids as git does; a revision that names nothing throws `RefNotFoundError`.
 *
 * @example
 * ```typescript
 * // Compare two commits
 * const entries = await git.diff().setOldTree(commitA).setNewTree(commitB).call();
 *
 * // `git diff --cached --stat`
 * const stat = await git.diff().setCached(true).callText("stat");
 *
 * // `git diff -U1 -w`
 * const patch = await git.diff().setOptions({ context: 1, ignoreWhitespace: true }).callText();
 *
 * // `git diff --no-prefix -O order.txt --no-textconv`
 * await git.diff().setOptions({ noPrefix: true, orderFile: "order.txt", textconv: false }).callText();
 * ```
 */
export class DiffCommand extends GitCommand<DiffEntry[]> {
  private oldTree?: string;
  private newTree?: string;
  private cached = false;
  private pathFilter?: string;
  private pathspecItems?: PathspecItem[];
  private renames?: boolean;
  private renameLimit?: number;
  private textOptions: DiffTextOptions = {};

  /**
   * Set the old (base) tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set, defaults to HEAD (or the index, for the worktree diff).
   *
   * @param refOrId Commit-ish or tree ID
   */
  setOldTree(refOrId: string): this {
    this.checkCallable();
    this.oldTree = refOrId;
    return this;
  }

  /**
   * Set the new tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set and cached=true, compares to the index; otherwise to the worktree (HEAD's
   * tree when there is none).
   *
   * @param refOrId Commit-ish or tree ID
   */
  setNewTree(refOrId: string): this {
    this.checkCallable();
    this.newTree = refOrId;
    return this;
  }

  /**
   * Compare HEAD (or the old tree) to the index instead of the worktree.
   *
   * Equivalent to `git diff --cached` or `git diff --staged`.
   *
   * @param cached Whether to compare to staging
   */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /**
   * Filter results to only paths starting with this prefix.
   *
   * @param path Path prefix to filter by
   */
  setPathFilter(path: string): this {
    this.checkCallable();
    this.pathFilter = path;
    return this;
  }

  /**
   * Limit the comparison to a pathspec, as `git diff -- <pathspec>...` (and `git log -p --
   * <pathspec>`) does: paths from the top, with wildcards and magic (see `LogCommand.addPath`).
   */
  setPathspec(paths: string[]): this {
    this.checkCallable();
    this.pathspecItems = paths.map((p) => parsePathspecItem(p));
    if (this.pathspecItems.length > 0 && this.pathspecItems.every((i) => i.exclude)) {
      this.pathspecItems.push(parsePathspecItem("."));
    }
    return this;
  }

  /**
   * Detect renames (`-M`, `--no-renames`). Default: off for `call()` (each path as added and
   * deleted), `diff.renames` (default on) for `callText()`.
   */
  setRenames(renames: boolean): this {
    this.checkCallable();
    this.renames = renames;
    return this;
  }

  /** `-l<n>`: the rename limit (default `diff.renameLimit`, 1000) */
  setRenameLimit(limit: number): this {
    this.checkCallable();
    this.renameLimit = limit;
    return this;
  }

  /** `diff` stores no objects: its abbreviations read each loose fan-out directory once */
  protected override writesNoObjects(): boolean {
    return true;
  }

  /** Text output options: context, algorithm, whitespace, `--stat` widths, ... */
  setOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.textOptions = { ...this.textOptions, ...options };
    return this;
  }

  /**
   * Execute the diff.
   *
   * @returns List of diff entries representing changes, in git's path order
   */
  async call(): Promise<DiffEntry[]> {
    this.checkCallable();
    this.setCallable(false);
    return (await this.collect(this.renames ?? false)).entries;
  }

  /**
   * Execute the diff and print it as `git diff` does, in the given format.
   *
   * The output is bytes; the text decodes them as paths decode ({@link decodeGitPath}):
   * UTF-8, and each byte that is no UTF-8 (a path printed raw with `core.quotePath=false`,
   * or file content in another encoding) as the lone surrogate U+DC00 + byte, never U+FFFD.
   * So `encodeGitPath(await callText())` is exactly {@link callBytes}, and a path cut from
   * the text is the path's string as trees and the index hold it.
   */
  async callText(format: DiffOutputFormat = "patch"): Promise<string> {
    return decodeGitPath(await this.callBytes(format));
  }

  /** {@link callText} as bytes (file content that is not UTF-8 kept as it is). */
  async callBytes(format: DiffOutputFormat = "patch"): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const config = this.config;
    const renames = this.renames ?? renamesValue(config.value("diff.renames")) ?? true;
    const collected = await this.collect(renames, format === "patch");
    const sink = new ByteSink();
    await this.writeFormats(sink, [format], collected);
    return sink.bytes();
  }

  /**
   * Several formats of one comparison in the order git's `diff_flush` prints them (`git log
   * --stat -p`): `--name-only`/`--name-status`, then `--numstat`, `--stat`, `--shortstat`,
   * then the patch, after a blank line when something came before it. Undefined when
   * nothing differs (git's empty diff queue, which `git log` shows no diff for).
   *
   * `follow` is `--follow`'s path: the comparison is limited to it, and when it is added, a
   * file it was renamed from is looked for among the other side's paths (tree-diff.c's
   * try_to_follow_renames); `followPath` is then the path followed from there on, and
   * `followChange` whether it was a rename or a copy.
   */
  async callFormats(
    formats: DiffOutputFormat[],
    follow?: string,
  ): Promise<{
    bytes?: Uint8Array;
    followPath?: string;
    followChange?: ChangeType.RENAME | ChangeType.COPY;
  }> {
    this.checkCallable();
    this.setCallable(false);
    const config = this.config;
    const renames = this.renames ?? renamesValue(config.value("diff.renames")) ?? true;
    let followPath = follow;
    let followChange: ChangeType.RENAME | ChangeType.COPY | undefined;
    let collected: { entries: DiffEntry[]; combined: CombinedEntry[] };
    if (follow !== undefined) {
      const spec = this.pathspecItems;
      this.pathspecItems = [parsePathspecItem(`:(literal)${follow}`)];
      collected = await this.collect(false, false);
      const only = collected.entries[0];
      if (collected.entries.length === 1 && only?.changeType === ChangeType.ADD) {
        this.pathspecItems = spec;
        const found = await this.followSource(only);
        if (found) {
          collected = { entries: [found], combined: [] };
          followPath = found.oldPath;
          followChange = found.changeType as ChangeType.RENAME | ChangeType.COPY;
        }
      }
    } else collected = await this.collect(renames, formats.includes("patch"));
    const followed = {
      ...(followPath !== undefined ? { followPath } : {}),
      ...(followChange !== undefined ? { followChange } : {}),
    };
    if (collected.entries.length === 0 && collected.combined.length === 0) return followed;
    const sink = new ByteSink();
    await this.writeFormats(sink, formats, collected);
    return { bytes: sink.bytes(), ...followed };
  }

  /**
   * tree-diff.c's try_to_follow_renames for the path a comparison of two trees adds: copies
   * found harder, every path of the old tree a source (see `findFollowSource`); the rename
   * or copy found, undefined for none.
   */
  private async followSource(added: DiffEntry): Promise<DiffEntry | undefined> {
    const path = added.newPath;
    if (path === undefined || added.newId === undefined) return undefined;
    const oldSide = await this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined);
    if (oldSide.size === 0) return undefined;
    const newSide = this.newTree ? await this.treeSide(this.newTree) : new Map<string, Side>();
    const sources = [...oldSide].map(([p, side]) => ({ path: p, mode: side.mode, id: side.id }));
    const deleted = new Set(sources.filter((c) => !newSide.has(c.path)).map((c) => c.path));
    const readBlob = async (id: ObjectId) => collectChunks((await this.blobs.load(id)) ?? []);
    const found = await findFollowSource(
      sources,
      { path, mode: added.newMode ?? 0o100644, id: added.newId },
      deleted,
      {
        countLastSpan: this.textOptions.renameCountLastSpan,
        size: async (c) => {
          try {
            return await this.blobs.size(c.id);
          } catch {
            return undefined;
          }
        },
        load: (c) => readBlob(c.id),
      },
    );
    if (!found) return undefined;
    const source = oldSide.get(found.from) as Side;
    return {
      changeType: found.renamed ? ChangeType.RENAME : ChangeType.COPY,
      oldPath: found.from,
      newPath: path,
      oldId: source.id,
      newId: added.newId,
      oldMode: source.mode as FileModeValue,
      newMode: added.newMode as FileModeValue,
      score: scorePercent(found.score),
    };
  }

  /** The formats of the collected comparison, in diff_flush's order */
  private async writeFormats(
    sink: ByteSink,
    formats: DiffOutputFormat[],
    collected: { entries: DiffEntry[]; combined: CombinedEntry[] },
  ): Promise<void> {
    const config = this.config;
    const { combined } = collected;
    const entries = await this.ordered(collected.entries);
    const options = this.outputOptions();
    Object.assign(options, this.prefixes());
    const pairs: DiffFilePair[] = [];
    const unmerged = new Set<DiffFilePair>();
    for (const entry of entries) {
      // an unmerged path: only its name is printed
      const pair: DiffFilePair = entry.unmerged
        ? {
            status: "M",
            old: contentSide(entry.oldPath ?? "", 0, NULL_ID, async () => new Uint8Array(0)),
          }
        : this.withTextconvInputs(diffEntryToPair(entry, this.blobs), entry);
      if (entry.unmerged) unmerged.add(pair);
      pairs.push(pair);
    }
    const quote = options.quotePath;
    const order: DiffOutputFormat[] = [
      "name-only",
      "name-status",
      "numstat",
      "stat",
      "shortstat",
      "summary",
      "patch",
    ];
    // run_diff_files prints the combined diff (`diff --cc`) of a conflicted path as it finds
    // it, before diff_flush prints any format of the rest
    if (combined.length > 0 && formats.includes("patch")) {
      // combine-diff.c's index lines take DEFAULT_ABBREV, whatever --abbrev says
      let combinedLengths: ReadonlyMap<string, number> | undefined;
      if (!options.fullIndex) {
        const ids = new Set<string>([NULL_ID]);
        for (const c of combined) {
          ids.add(c.ours.objectId);
          ids.add(c.theirs.objectId);
        }
        combinedLengths = await this.idAbbreviator().lengths(ids);
      }
      for (const c of combined) await this.writeCombined(sink, c, options, combinedLengths);
    }
    // diff_flush of an empty queue prints nothing
    if (pairs.length === 0) return;
    let separator = false;
    for (const format of order) {
      if (!formats.includes(format)) continue;
      if (format === "patch" && separator) sink.text("\n");
      // diff_flush: an empty summary (is_summary_empty) prints nothing and asks no separator
      if (format === "summary") {
        const text = formatSummary(
          pairs.filter((p) => !unmerged.has(p)),
          quote,
        );
        if (text) {
          sink.text(text);
          separator = true;
        }
        continue;
      }
      separator = true;
      switch (format) {
        case "patch": {
          // index lines abbreviate as git does (core.abbrev, the repository's size, uniqueness)
          if (!options.fullIndex) {
            const ids = new Set<string>();
            for (const pair of pairs) {
              if (unmerged.has(pair)) continue;
              ids.add(pair.old?.id ?? NULL_ID);
              ids.add(pair.new?.id ?? NULL_ID);
            }
            // `--abbrev=<n>`: at least n digits
            options.abbrevLengths = await this.idAbbreviator().lengths(ids, options.abbrev);
          }
          for (const pair of pairs) {
            if (unmerged.has(pair)) {
              sink.text(`* Unmerged path ${pair.new?.path ?? pair.old?.path}\n`);
            } else await writePairPatch(sink, pair, options);
          }
          break;
        }
        case "name-only":
          sink.text(
            formatNameOnly(await this.shownNames(pairs, unmerged, options), { quotePath: quote }),
          );
          break;
        case "name-status":
          for (const pair of await this.shownNames(pairs, unmerged, options)) {
            if (unmerged.has(pair)) {
              sink.text(`U\t${quotePath(pair.new?.path ?? pair.old?.path ?? "", quote)}\n`);
            } else sink.text(formatNameStatus([pair], { quotePath: quote }));
          }
          break;
        default: {
          const files = [];
          for (const pair of pairs) {
            if (unmerged.has(pair)) {
              const name = pair.new?.path ?? pair.old?.path ?? "";
              files.push({
                name,
                isRenamed: false,
                isBinary: false,
                isUnmerged: true,
                added: 0,
                deleted: 0,
              });
            } else files.push(...(await computeDiffstat([pair], options)));
          }
          const statOptions: DiffstatOptions = {
            nameWidth: intValue(config.value("diff.statNameWidth")),
            graphWidth: intValue(config.value("diff.statGraphWidth")),
            ...this.textOptions.stat,
            quotePath: quote,
          };
          if (format === "stat") sink.text(formatStat(files, statOptions));
          else if (format === "numstat") sink.text(formatNumstat(files, { quotePath: quote }));
          else sink.text(formatShortstat(files));
        }
      }
    }
  }

  /** The combined diff (`diff --cc`) of a conflicted path: stages 2 and 3 against the file */
  private async writeCombined(
    sink: ByteSink,
    c: CombinedEntry,
    options: DiffOutputOptions,
    lengths: ReadonlyMap<string, number> | undefined,
  ): Promise<void> {
    const worktree = this.worktreeAccess;
    const driver = await options.driver?.(c.path);
    // combine-diff.c's grab_blob: a gitlink's or a deleted side's content is not converted
    const textconv = driver?.textconv;
    const stage = async (e: StageEntry) => {
      const side = blobSide(this.blobs, c.path, e.mode, e.objectId);
      const convert = textconv && (e.mode & S_IFMT) !== GITLINK && e.objectId !== NULL_ID;
      return {
        id: e.objectId,
        mode: e.mode,
        content: convert
          ? await textconv(await this.smudged(c.path, e.mode, side.read), c.path)
          : await side.read(),
      };
    };
    // the file as git reads it for the result: its real mode (canon_mode), cleaned content
    let mode = 0;
    let content: Uint8Array = new Uint8Array(0);
    const file = await worktree?.getEntry(c.path);
    if (worktree && file) {
      if (file.isDirectory) {
        mode = GITLINK;
        content = encoder.encode(`Subproject commit ${NULL_ID}\n`);
      } else {
        const kind = file.mode & S_IFMT;
        mode = kind === 0o120000 ? 0o120000 : file.mode & 0o111 ? 0o100755 : 0o100644;
        // a symbolic link's target is not converted; textconv reads the file as it is
        content =
          textconv && kind !== 0o120000
            ? await textconv(await collectChunks(worktree.readContent(c.path)), c.path)
            : await readCleanContent(worktree, c.path);
      }
    }
    writeCombinedDiff(
      sink,
      {
        path: c.path,
        parents: [await stage(c.ours), await stage(c.theirs)],
        result: { id: NULL_ID, mode, content },
      },
      {
        ...options,
        ...(textconv
          ? { binary: false }
          : driver?.binary !== undefined
            ? { binary: driver.binary }
            : {}),
        abbreviate: (id) => id.slice(0, options.fullIndex ? 40 : (lengths?.get(id) ?? 7)),
      },
    );
  }

  /**
   * The textconv input of a pair's sides, as git's `prepare_temp_file` writes it: a blob
   * smudged as checkout would write it (`convert_to_working_tree`), a worktree file's bytes
   * as they are (the entry's `readNew`, which reads it cleaned)
   */
  private withTextconvInputs(pair: DiffFilePair, entry: DiffEntry): DiffFilePair {
    const worktree = this.worktreeAccess;
    if (!worktree) return pair;
    const blob = (side: DiffFilePair["old"]) =>
      side && { ...side, readTextconvInput: () => this.smudged(side.path, side.mode, side.read) };
    const raw = (side: DiffFilePair["new"]) =>
      side && {
        ...side,
        readTextconvInput: () => collectChunks(worktree.readContent(side.path)),
      };
    return {
      ...pair,
      old: entry.readOld ? pair.old : blob(pair.old),
      new: entry.readNew ? raw(pair.new) : blob(pair.new),
    };
  }

  /** A blob's content as checkout writes it to the worktree (the worktree's smudge filter) */
  private async smudged(
    path: string,
    mode: number,
    read: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    const content = await read();
    return collectChunks(
      await smudgeContent(this.worktreeAccess?.contentFilter, path, content, mode),
    );
  }

  /** The pairs `--name-only` lists: with whitespace options, those whose patch shows a change */
  private async shownNames(
    pairs: DiffFilePair[],
    unmerged: Set<DiffFilePair>,
    options: DiffOutputOptions,
  ): Promise<DiffFilePair[]> {
    const fromContents =
      (this.textOptions.namesFromContents ?? true) &&
      (options.ignoreWhitespace ||
        options.ignoreWhitespaceChange ||
        options.ignoreWhitespaceAtEol ||
        options.ignoreCrAtEol);
    if (!fromContents) return pairs;
    const shown: DiffFilePair[] = [];
    for (const pair of pairs) {
      if (unmerged.has(pair)) {
        shown.push(pair);
        continue;
      }
      const scratch = new ByteSink();
      await writePairPatch(scratch, pair, options);
      if (scratch.length > 0) shown.push(pair);
    }
    return shown;
  }

  private get config(): RemoteConfigStore {
    return RemoteConfigStore.from(this.workingCopy);
  }

  /** What this diff compares */
  private get sides(): DiffSides {
    if (this.newTree) return "trees";
    if (this.cached) return "cached";
    if (!this.worktreeAccess) return "trees";
    return this.oldTree ? "commit-worktree" : "index-worktree";
  }

  /**
   * The path prefixes, as git sets them: `diff.noprefix`, else `diff.srcPrefix` /
   * `diff.dstPrefix` (default `a/`, `b/`) unless `diff.mnemonicPrefix`; then the options;
   * a prefix left unset takes the comparison's mnemonic one, else `a/` / `b/`.
   */
  private prefixes(): { srcPrefix: string; dstPrefix: string } {
    const get = (key: string) => this.config.value(key);
    const configSrc = get("diff.srcPrefix");
    const configDst = get("diff.dstPrefix");
    let src: string | undefined;
    let dst: string | undefined;
    if (!this.textOptions.ignoreConfigNoPrefix && boolValue(get("diff.noprefix"))) {
      src = "";
      dst = "";
    } else if (!boolValue(get("diff.mnemonicPrefix"))) {
      src = configSrc ?? "a/";
      dst = configDst ?? "b/";
    }
    const options = this.textOptions;
    if (options.noPrefix) {
      src = "";
      dst = "";
    }
    // `--default-prefix` resets `diff.srcPrefix` / `diff.dstPrefix` too (git-diff(1))
    if (options.defaultPrefix) {
      src = "a/";
      dst = "b/";
    }
    if (options.srcPrefix !== undefined) src = options.srcPrefix;
    if (options.dstPrefix !== undefined) dst = options.dstPrefix;
    const mnemonic = MNEMONIC_PREFIXES[this.sides];
    return { srcPrefix: src ?? mnemonic?.[0] ?? "a/", dstPrefix: dst ?? mnemonic?.[1] ?? "b/" };
  }

  /** The entries in the order of `-O<orderfile>` / `diff.orderFile` (diffcore_order) */
  private async ordered(entries: DiffEntry[]): Promise<DiffEntry[]> {
    const configured = this.config.value("diff.orderFile");
    const environment = (this.workingCopy.config as { environment?: GitHostEnvironment })
      ?.environment;
    // git reads the configuration first: a path it cannot expand fails even with -O
    const expanded = configured ? expandUserPath(configured, environment) : undefined;
    if (configured && expanded === undefined) {
      throw new Error(`failed to expand user dir in: '${configured}'`);
    }
    const orderFile = this.textOptions.orderFile ?? expanded;
    if (!orderFile || entries.length === 0) return entries;
    const content = await this.readOrderFile(orderFile, environment);
    if (!content) throw new Error(`failed to read orderfile '${orderFile}'`);
    // the path git orders a pair by: its second side's (`pair_pathtwo`)
    return orderByPatterns(entries, parseOrderFile(content), (e) => e.newPath ?? e.oldPath ?? "");
  }

  /**
   * An order file, read as git reads it from its current directory (the worktree's root;
   * the git directory without a worktree): an absolute path through the host; a relative
   * one in the worktree, or through the host from the worktree's (the git directory's) host
   * path when it leaves the worktree (`..`) or there is no worktree
   */
  private async readOrderFile(
    path: string,
    environment: GitHostEnvironment | undefined,
  ): Promise<Uint8Array | undefined> {
    if (path.startsWith("/")) return environment?.readFile(path);
    const worktree = this.worktreeAccess;
    if (!worktree || path.split("/").includes("..")) {
      const base = worktree
        ? (worktree as { hostPath?: string }).hostPath
        : (this.workingCopy.config as { hostGitDir?: string }).hostGitDir;
      if (!base) return worktree ? undefined : environment?.readFile(path);
      return environment?.readFile(resolveHostPath(base, path));
    }
    try {
      const entry = await worktree.getEntry(path);
      if (!entry || entry.isDirectory) return undefined;
      const chunks: Uint8Array[] = [];
      for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /** The output options: the setters', else the configuration's */
  private outputOptions(): DiffOutputOptions {
    const config = this.config;
    const get = (key: string) => config.value(key);
    const worktree = this.worktreeAccess;
    const filter = worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    const drivers = new Map<string, Promise<DiffDriver | undefined>>();
    const runner =
      (this.textOptions.textconv ?? true) ? textconvRunnerOf(this.workingCopy) : undefined;
    const withTextconv = (found: DiffDriver | undefined): DiffDriver | undefined => {
      const command = found?.textconvCommand;
      if (!found || !runner || command === undefined) return found;
      const name = found.name ?? "";
      const cache = found.cacheTextconv ?? false;
      return {
        ...found,
        textconv: (content, path) => runner({ driver: name, command, path, content, cache }),
      };
    };
    const driver = filter?.attributes
      ? (path: string) => {
          let found = drivers.get(path);
          if (!found) {
            found = (async () => {
              const attrs = await filter.attributes?.(path, ["diff"]);
              return withTextconv(diffDriverOf(attrs?.get("diff"), get));
            })();
            drivers.set(path, found);
          }
          return found;
        }
      : undefined;
    const {
      stat: _stat,
      renameCountLastSpan: _span,
      namesFromContents: _names,
      noPrefix: _noPrefix,
      defaultPrefix: _defaultPrefix,
      ignoreConfigNoPrefix: _ignoreConfigNoPrefix,
      orderFile: _orderFile,
      textconv: _textconv,
      abbrev: _abbrev,
      ...text
    } = this.textOptions;
    const abbrev = abbrevOption(this.textOptions.abbrev);
    return {
      context: intValue(get("diff.context")) ?? 3,
      interHunkContext: intValue(get("diff.interHunkContext")) ?? 0,
      quotePath: boolValue(get("core.quotePath")) ?? true,
      ...(intValue(get("core.bigFileThreshold")) !== undefined
        ? { bigFileThreshold: intValue(get("core.bigFileThreshold")) }
        : {}),
      ...text,
      ...(abbrev !== undefined ? { abbrev } : {}),
      algorithm: text.algorithm ?? algorithmValue(get("diff.algorithm")) ?? "myers",
      indentHeuristic: text.indentHeuristic ?? boolValue(get("diff.indentHeuristic")) ?? true,
      ...(driver ? { driver } : {}),
    };
  }

  /**
   * The changed paths (and renames, when asked), in git's order, and the conflicted paths
   * `git diff` shows as combined diffs (`patch`: the patch format, where a path with both
   * stage 2 and stage 3 is one; elsewhere it is listed as unmerged and as its stage 2
   * against the worktree, as `diff-files` does).
   */
  private async collect(
    renames: boolean | "copies",
    patch = false,
  ): Promise<{ entries: DiffEntry[]; combined: CombinedEntry[] }> {
    const worktree = this.worktreeAccess;
    let oldSide: Map<string, Side>;
    let newSide: Map<string, Side>;
    const unmerged = new Map<string, DiffEntry[]>();
    const combined: CombinedEntry[] = [];
    if (this.newTree) {
      [oldSide, newSide] = await this.treePairSides(
        this.oldTree ?? "HEAD",
        this.oldTree === undefined,
        this.newTree,
      );
    } else if (this.cached) {
      oldSide = await this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined);
      const index = await this.indexSide();
      newSide = index.sides;
      for (const path of index.unmerged.keys()) unmerged.set(path, []);
    } else if (worktree) {
      const run = async () => {
        if (this.oldTree) {
          // diff-index: a conflicted path is its worktree file, compared with the tree
          const old = await this.treeSide(this.oldTree);
          const wt = await this.worktreeSide(worktree, true);
          return [old, wt.sides] as const;
        }
        const index = await this.indexSide();
        const wt = await this.worktreeSide(worktree, false);
        for (const [path, stages] of wt.unmerged) {
          if (!this.matches(path)) continue;
          const ours = stages.get(2);
          const theirs = stages.get(3);
          if (patch && ours && theirs) {
            combined.push({ path, ours, theirs });
            continue;
          }
          unmerged.set(path, ours ? await this.againstStage(ours, wt.compare) : []);
        }
        return [index.sides, wt.sides] as const;
      };
      [oldSide, newSide] = worktree.batch ? await worktree.batch(run) : await run();
    } else {
      // no worktree: HEAD against HEAD (the old tree against HEAD)
      oldSide = await this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined);
      newSide = await this.treeSide("HEAD", true);
    }
    const entries = this.pairUp(oldSide, newSide, unmerged);
    if (renames) await this.detectRenames(entries, renames === "copies");
    return { entries, combined };
  }

  /** diff-files on a conflicted path's stage 2 (`--ours`): its entry against the worktree */
  private async againstStage(stage: StageEntry, compare: WorktreeCompare): Promise<DiffEntry[]> {
    const path = stage.path;
    const side = await compare(stage);
    if (!side) {
      return [
        {
          changeType: ChangeType.DELETE,
          oldPath: path,
          oldId: stage.objectId,
          oldMode: stage.mode as FileModeValue,
        },
      ];
    }
    if (side.id === stage.objectId && side.mode === stage.mode && !side.dirty) return [];
    return [
      {
        changeType: ChangeType.MODIFY,
        oldPath: path,
        newPath: path,
        oldId: stage.objectId,
        newId: side.id,
        oldMode: stage.mode as FileModeValue,
        newMode: side.mode as FileModeValue,
        ...(side.read ? { readNew: side.read } : {}),
        ...(side.dirty ? { newDirtySubmodule: true } : {}),
      },
    ];
  }

  private matches(path: string): boolean {
    if (this.pathFilter && !path.startsWith(this.pathFilter)) return false;
    return !this.pathspecItems || matchPathspec(this.pathspecItems, path, 0) > 0;
  }

  /**
   * The entries of both sides in path order; an unmerged path is listed as such, followed by
   * the entries `unmerged` holds for it
   */
  private pairUp(
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
    unmerged: Map<string, DiffEntry[]>,
  ): DiffEntry[] {
    const paths = new Set<string>([...oldSide.keys(), ...newSide.keys(), ...unmerged.keys()]);
    const sorted = [...paths].filter((p) => this.matches(p)).sort(compareBytes);
    const entries: DiffEntry[] = [];
    for (const path of sorted) {
      const extra = unmerged.get(path);
      if (extra) {
        entries.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          unmerged: true,
        });
        entries.push(...extra);
        continue;
      }
      const a = oldSide.get(path);
      const b = newSide.get(path);
      if (a && !b) {
        entries.push({
          changeType: ChangeType.DELETE,
          oldPath: path,
          oldId: a.id,
          oldMode: a.mode as FileModeValue,
        });
      } else if (!a && b) {
        entries.push({
          changeType: ChangeType.ADD,
          newPath: path,
          newId: b.id,
          newMode: b.mode as FileModeValue,
          ...(b.read ? { readNew: b.read } : {}),
          ...(b.dirty ? { newDirtySubmodule: true } : {}),
        });
      } else if (a && b && (a.id !== b.id || a.mode !== b.mode || b.dirty)) {
        entries.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          oldId: a.id,
          newId: b.id,
          oldMode: a.mode as FileModeValue,
          newMode: b.mode as FileModeValue,
          ...(b.read ? { readNew: b.read } : {}),
          ...(b.dirty ? { newDirtySubmodule: true } : {}),
        });
      }
    }
    return entries;
  }

  /**
   * git's `diffcore_rename` over the added and deleted paths; `copies` (DIFF_DETECT_COPY,
   * `diff.renames=copies`): the modified paths are sources too, which stay (copied only)
   */
  private async detectRenames(entries: DiffEntry[], copies = false): Promise<void> {
    const sources = entries.filter(
      (e) =>
        e.changeType === ChangeType.DELETE ||
        (copies && e.changeType === ChangeType.MODIFY && !e.unmerged),
    );
    const destinations = entries.filter((e) => e.changeType === ChangeType.ADD);
    if (sources.length === 0 || destinations.length === 0) return;
    const byPath = new Map<string, DiffEntry>();
    for (const e of sources) byPath.set(`s:${e.oldPath}`, e);
    for (const e of destinations) byPath.set(`d:${e.newPath}`, e);
    const readBlob = async (id: ObjectId) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of (await this.blobs.load(id)) ?? []) {
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
    };
    const limit =
      this.renameLimit ?? intValue(this.config.value("diff.renameLimit")) ?? DEFAULT_RENAME_LIMIT;
    const pairs = await detectRenames(
      sources.map((e) => ({
        path: e.oldPath ?? "",
        mode: e.oldMode ?? 0,
        id: e.oldId ?? "",
        ...(e.changeType === ChangeType.MODIFY ? { kept: true } : {}),
      })),
      destinations.map((e) => ({ path: e.newPath ?? "", mode: e.newMode ?? 0, id: e.newId ?? "" })),
      {
        renameLimit: limit,
        countLastSpan: this.textOptions.renameCountLastSpan,
        copies,
        size: async (c, role) => {
          const e = byPath.get(`${role === "source" ? "s" : "d"}:${c.path}`);
          if (role === "destination" && e?.readNew) return (await e.readNew()).length;
          try {
            return await this.blobs.size(c.id);
          } catch {
            return undefined;
          }
        },
        load: async (c, role) => {
          const e = byPath.get(`${role === "source" ? "s" : "d"}:${c.path}`);
          if (role === "destination" && e?.readNew) return e.readNew();
          return readBlob(c.id);
        },
      },
    );
    const drop = new Set<DiffEntry>();
    for (const pair of pairs) {
      const src = byPath.get(`s:${pair.from}`);
      const dst = byPath.get(`d:${pair.to}`);
      if (!src || !dst) continue;
      // a deleted source taken by a rename or copy is no deletion any more
      if (src.changeType === ChangeType.DELETE) drop.add(src);
      dst.changeType = pair.copy ? ChangeType.COPY : ChangeType.RENAME;
      dst.oldPath = src.oldPath;
      dst.oldId = src.oldId;
      dst.oldMode = src.oldMode;
      dst.score = scorePercent(pair.score);
    }
    if (drop.size > 0) {
      const kept = entries.filter((e) => !drop.has(e));
      entries.splice(0, entries.length, ...kept);
    }
  }

  /**
   * The blobs of a commit's (or tree's) tree, by path. `implicitHead`: HEAD taken by default
   * (`--cached`, no worktree), an unborn HEAD then being the empty tree as git takes it;
   * anything else that does not resolve throws (git's "bad revision", exit 128).
   */
  private async treeSide(refOrId: string, implicitHead = false): Promise<Map<string, Side>> {
    const out = new Map<string, Side>();
    // the empty tree (a root commit's parent side), which a store need not hold
    if (refOrId === EMPTY_TREE_ID) return out;
    let treeId: ObjectId;
    try {
      treeId = await this.resolveTreeId(refOrId);
    } catch (e) {
      if (implicitHead && e instanceof NoHeadError) return out;
      throw e;
    }
    await this.collectTreeEntries(treeId, "", out);
    return out;
  }

  /**
   * The entries of two trees that differ (diff_tree_oid): a subtree with the same id on both
   * sides, and a file the same on both, is left out without being read; what differs is
   * listed as {@link treeSide} lists it.
   */
  private async treePairSides(
    oldRef: string,
    implicitHead: boolean,
    newRef: string,
  ): Promise<[Map<string, Side>, Map<string, Side>]> {
    const oldSide = new Map<string, Side>();
    const newSide = new Map<string, Side>();
    const treeOf = async (ref: string, implicit: boolean): Promise<ObjectId | undefined> => {
      if (ref === EMPTY_TREE_ID) return undefined;
      // a tree's full id (as `git log -p` passes its commits' trees): read at once, its
      // entries kept for the comparison
      const trees = this.trees;
      if (/^[0-9a-f]{40}$/.test(ref)) {
        const known = trees.raw ? trees.raw(ref) : trees.entries?.(ref);
        if (known && (await known)) return ref;
      }
      try {
        return await this.resolveTreeId(ref);
      } catch (e) {
        if (implicit && e instanceof NoHeadError) return undefined;
        throw e;
      }
    };
    const a = await treeOf(oldRef, implicitHead);
    const b = await treeOf(newRef, false);
    await this.diffTreeSides(a, b, "", oldSide, newSide);
    return [oldSide, newSide];
  }

  /**
   * tree-diff.c's walk of two trees in their stored order (git's `base_name_compare`): an
   * entry the same on both sides is skipped, two subtrees of one name are compared in turn,
   * and anything else is listed on its side (a subtree as its blobs).
   */
  private async diffTreeSides(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    prefix: string,
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
  ): Promise<void> {
    if (a === b) return;
    if (this.trees.raw) return this.diffRawTrees(a, b, prefix, oldSide, newSide);
    const ea = a === undefined || a === EMPTY_TREE_ID ? [] : await this.treeEntries(a);
    const eb = b === undefined || b === EMPTY_TREE_ID ? [] : await this.treeEntries(b);
    let i = 0;
    let j = 0;
    while (i < ea.length || j < eb.length) {
      const x = ea[i];
      const y = eb[j];
      const order =
        x === undefined
          ? 1
          : y === undefined
            ? -1
            : compareEntryNames(x.name, isTreeMode(x.mode), y.name, isTreeMode(y.mode));
      if (order < 0) {
        const e = x as TreeEntry;
        await this.addSide(e, prefix ? `${prefix}/${e.name}` : e.name, oldSide);
        i++;
      } else if (order > 0) {
        const e = y as TreeEntry;
        await this.addSide(e, prefix ? `${prefix}/${e.name}` : e.name, newSide);
        j++;
      } else {
        const xe = x as TreeEntry;
        const ye = y as TreeEntry;
        i++;
        j++;
        // tree-diff.c compares the modes its walk reads: canonical (100664 is 100644)
        if (xe.id === ye.id && canonTreeMode(xe.mode) === canonTreeMode(ye.mode)) continue;
        const path = prefix ? `${prefix}/${xe.name}` : xe.name;
        if (isTreeMode(xe.mode) && isTreeMode(ye.mode)) {
          await this.diffTreeSides(xe.id, ye.id, path, oldSide, newSide);
          continue;
        }
        await this.addSide(xe, path, oldSide);
        await this.addSide(ye, path, newSide);
      }
    }
  }

  /**
   * {@link diffTreeSides} over the trees' stored bytes: an entry the same on both sides is
   * passed over without being decoded (a missing tree reads as empty, as `treeEntries` has it)
   */
  private async diffRawTrees(
    a: ObjectId | undefined,
    b: ObjectId | undefined,
    prefix: string,
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
  ): Promise<void> {
    if (a === b) return;
    const trees = this.trees;
    const read = async (id: ObjectId | undefined) =>
      id === undefined || id === EMPTY_TREE_ID ? NO_BYTES : ((await trees.raw?.(id)) ?? NO_BYTES);
    const x = new TreeEntryCursor(await read(a));
    const y = new TreeEntryCursor(await read(b));
    const pathOf = (name: string) => (prefix ? `${prefix}/${name}` : name);
    while (!x.done || !y.done) {
      const order = x.done ? 1 : y.done ? -1 : x.compare(y);
      if (order < 0) {
        await this.addRawSide(x, pathOf(x.name()), oldSide);
        x.next();
      } else if (order > 0) {
        await this.addRawSide(y, pathOf(y.name()), newSide);
        y.next();
      } else {
        if (!x.sameAs(y)) {
          const path = pathOf(x.name());
          if (x.isTree && y.isTree) await this.diffRawTrees(x.id(), y.id(), path, oldSide, newSide);
          else {
            await this.addRawSide(x, path, oldSide);
            await this.addRawSide(y, path, newSide);
          }
        }
        x.next();
        y.next();
      }
    }
  }

  /** The entry a cursor is on, on one side: a blob as itself, a subtree as its blobs */
  private async addRawSide(
    c: TreeEntryCursor,
    path: string,
    side: Map<string, Side>,
  ): Promise<void> {
    if (c.isTree) await this.collectTreeEntries(c.id(), path, side);
    else side.set(path, { mode: c.mode, id: c.id() });
  }

  /** A tree entry on one side: a blob as itself, a subtree as its blobs */
  private async addSide(e: TreeEntry, path: string, side: Map<string, Side>): Promise<void> {
    if (isTreeMode(e.mode)) await this.collectTreeEntries(e.id, path, side);
    else side.set(path, { mode: canonTreeMode(e.mode), id: e.id });
  }

  /**
   * The index's stage-0 entries (intent-to-add ones left out: not in the index yet), and the
   * stages of its conflicted paths
   */
  private async indexSide(): Promise<{
    sides: Map<string, Side>;
    unmerged: Map<string, Map<number, StageEntry>>;
  }> {
    const sides = new Map<string, Side>();
    const unmerged = new Map<string, Map<number, StageEntry>>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== 0) {
        let stages = unmerged.get(entry.path);
        if (!stages) {
          stages = new Map();
          unmerged.set(entry.path, stages);
        }
        stages.set(entry.stage, entry);
        continue;
      }
      if (entry.intentToAdd) continue;
      sides.set(entry.path, { mode: entry.mode, id: entry.objectId });
    }
    return { sides, unmerged };
  }

  /**
   * The worktree as `diff-files` and `diff-index` see it: each index entry's file, its
   * stat-clean entries taken from the index, changed ones read and hashed as `git add` would
   * store them; deleted files left out. A conflicted path's stages are handed back (and,
   * with `unmergedAsFiles`, its file is taken as diff-index takes it, against the lowest
   * stage); `compare` gives the worktree side of any entry.
   */
  private async worktreeSide(
    worktree: Worktree,
    unmergedAsFiles: boolean,
  ): Promise<{
    sides: Map<string, Side>;
    unmerged: Map<string, Map<number, StageEntry>>;
    compare: WorktreeCompare;
  }> {
    const sides = new Map<string, Side>();
    const unmerged = new Map<string, Map<number, StageEntry>>();
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    const ignore = submoduleIgnoreValue(this.config.value("diff.ignoreSubmodules"));
    const compare: WorktreeCompare = async (entry) => {
      const indexSide: Side = { mode: entry.mode, id: entry.objectId };
      if (entry.skipWorktree || entry.assumeValid) return indexSide;
      if (entry.mode === GITLINK && ignore === "all") return indexSide;
      const result = await compareWithWorktree(worktree, entry, { trust, indexTime });
      if (result.kind === "deleted") return undefined;
      const mode = result.worktreeMode ?? entry.mode;
      if (mode === GITLINK) {
        const id = result.hashedId ?? entry.objectId;
        // a populated submodule with changes of its own: "-dirty" (untracked files count
        // only with diff.ignoreSubmodules=none, as git's default ignores them)
        let dirty = false;
        if (entry.mode === GITLINK && ignore !== "dirty" && result.worktreeEntry?.isDirectory) {
          const dirt = await readSubmoduleDirt(worktree, entry.path, ignore !== "none");
          dirty = !!dirt.modified || (ignore === "none" && !!dirt.untracked);
        }
        if (!dirty) return result.kind ? { mode, id } : indexSide;
        const content = encoder.encode(`Subproject commit ${id}-dirty\n`);
        return { mode, id, dirty, read: async () => content };
      }
      if (!result.kind && !entry.intentToAdd) return indexSide;
      const path = entry.path;
      const id = result.hashedId ?? (await worktree.computeHash(path));
      if (!entry.intentToAdd && id === entry.objectId && mode === entry.mode) return indexSide;
      let content: Promise<Uint8Array> | undefined;
      const read = () => {
        content ??= readCleanContent(worktree, path);
        return content;
      };
      return { mode, id, read };
    };
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== 0) {
        let stages = unmerged.get(entry.path);
        if (!stages) {
          stages = new Map();
          unmerged.set(entry.path, stages);
        }
        stages.set(entry.stage, entry);
        continue;
      }
      if (!this.matches(entry.path)) continue;
      const side = await compare(entry);
      if (!side) continue;
      if (entry.intentToAdd && side.id === entry.objectId && !side.read) continue;
      sides.set(entry.path, side);
    }
    if (unmergedAsFiles) {
      for (const [path, stages] of unmerged) {
        if (!this.matches(path)) continue;
        const lowest = stages.get(1) ?? stages.get(2) ?? stages.get(3);
        if (!lowest) continue;
        // the stage's stat is no file's: the file is read and hashed
        const side = await compare(lowest);
        if (side) sides.set(path, side);
      }
    }
    return { sides, unmerged, compare };
  }

  /**
   * The tree of a commit-ish or a tree id; throws `NoHeadError` for an unborn HEAD and
   * `RefNotFoundError` for anything else that names no commit or tree.
   */
  private async resolveTreeId(refOrId: string): Promise<ObjectId> {
    // a full object id names that object, as get_oid takes it: no ref is looked up
    if (/^[0-9a-f]{40}$/.test(refOrId)) {
      const tree = await this.revisionResolver()
        .peelToType(refOrId, "tree")
        .catch(() => undefined);
      if (tree !== undefined) return tree;
    }
    let id: ObjectId;
    try {
      id = await this.resolveRevision(refOrId);
    } catch (e) {
      if (/^[0-9a-f]{40}$/.test(refOrId) && (await this.isTree(refOrId))) return refOrId;
      if (refOrId === "HEAD") throw new NoHeadError("HEAD cannot be resolved");
      if (e instanceof RefNotFoundError) {
        throw new RefNotFoundError(refOrId, `bad revision '${refOrId}'`);
      }
      throw e;
    }
    // a commit's tree, a tree, or a tag of either
    const tree = await this.revisionResolver().peelToType(id, "tree");
    if (tree !== undefined) return tree;
    throw new RefNotFoundError(refOrId, `bad revision '${refOrId}'`);
  }

  private async isTree(id: ObjectId): Promise<boolean> {
    try {
      return await this.trees.has(id);
    } catch {
      return false;
    }
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, Side>,
  ): Promise<void> {
    const TREE_MODE = 0o40000;
    for (const entry of await this.treeEntries(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((entry.mode & S_IFMT) === TREE_MODE) {
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        // the mode as git's tree walk reads it (canon_mode)
        entries.set(path, { mode: canonTreeMode(entry.mode), id: entry.id });
      }
    }
  }
}

/**
 * Format a DiffEntry for display.
 */
export function formatDiffEntry(entry: DiffEntry): string {
  switch (entry.changeType) {
    case ChangeType.ADD:
      return `A\t${entry.newPath}`;
    case ChangeType.DELETE:
      return `D\t${entry.oldPath}`;
    case ChangeType.MODIFY:
      return `M\t${entry.newPath}`;
    case ChangeType.RENAME:
      return `R${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
    case ChangeType.COPY:
      return `C${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
  }
}

/** `path` relative to the host directory `base`, its `.` and `..` segments resolved */
function resolveHostPath(base: string, path: string): string {
  const parts = base.replace(/\/+$/, "").split("/");
  for (const part of path.split("/")) {
    if (part === "..") {
      if (parts.length > 1) parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/") || "/";
}

/** The empty tree's content */
const NO_BYTES = new Uint8Array(0);

/** Whether a tree entry's mode is a subtree's */
function isTreeMode(mode: number): boolean {
  return (mode & S_IFMT) === 0o40000;
}

/**
 * git's `base_name_compare` over names as trees hold them (decoded as {@link decodeGitPath}
 * decodes them): byte order, a subtree's name compared as if it ended in `/`.
 */
function compareEntryNames(a: string, aTree: boolean, b: string, bTree: boolean): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let k = 0; k < n; k++) {
    if (a.charCodeAt(k) !== b.charCodeAt(k)) return compareGitPaths(a, b);
  }
  // past the common part: the next character's code orders as its first byte would
  const ca = a.length > n ? a.charCodeAt(n) : aTree ? 0x2f : 0;
  const cb = b.length > n ? b.charCodeAt(n) : bTree ? 0x2f : 0;
  return ca - cb;
}
