import {
  type FileModeValue,
  type ObjectId,
  type TreeEntry,
  TreeEntryCursor,
} from "@statewalker/vcs-core";
import {
  ByteSink,
  compilePosixRegex,
  isNullObjectId,
  type PosixRegex,
  parseGitBool,
  type XdiffAlgorithm,
} from "@statewalker/vcs-utils";
import { compareGitPaths, decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  type AttributesIndex,
  basicStatMatches,
  collectChunks,
  compareWithWorktree,
  expandUserPath,
  type GitHostEnvironment,
  readCleanContent,
  type Staging,
  smudgeContent,
  type Worktree,
  type WorktreeEntry,
  withWorktreeEntries,
} from "@statewalker/vcs-working-tree";

import {
  GitApiError,
  InvalidArgumentError,
  NoHeadError,
  RefNotFoundError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  type BreakScores,
  countChanges,
  DEFAULT_RENAME_LIMIT,
  detectRenames,
  findFollowSource,
  parseBreakRewrites,
  renameScoreOption,
  scorePercent,
  shouldBreak,
  spanCounts,
} from "../rename/index.js";
import { writeCombinedDiff } from "../results/combined-diff.js";
import { conflictMarkerSizeOf, writePairCheck } from "../results/diff-check.js";
import { MovedLineBuffer } from "../results/diff-color.js";
import {
  DEFAULT_DIRSTAT,
  type DirstatFile,
  type DirstatParams,
  formatDirstat,
  parseDirstatParams,
} from "../results/diff-dirstat.js";
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
  type DiffstatFile,
  type DiffstatOptions,
  diffDriverOf,
  formatNameOnly,
  formatNameStatus,
  formatNumstat,
  formatRawPair,
  formatShortstat,
  formatStat,
  formatSummary,
  writeHeaderOnlyPatch,
  writePairPatch,
} from "../results/diff-output.js";
import { DiffPickaxe } from "../results/diff-pickaxe.js";
import { quotePath } from "../results/quote-path.js";
import {
  parseWhitespaceRule,
  WS_DEFAULT_RULE,
  WS_INCOMPLETE_LINE,
  whitespaceRuleOf,
} from "../whitespace/index.js";
import { bareAttributesResolver } from "./attributes-source.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  type DiffColorOptions,
  type DiffColorSettings,
  readDiffColorSettings,
  whitespaceRuleError,
} from "./diff-color-config.js";
import { type TextconvRequest, type TextconvRunner, textconvRunnerOf } from "./diff-textconv.js";
import {
  DO_MATCH_DIRECTORY,
  DO_MATCH_LEADING_PATHSPEC,
  matchPathspec,
  type PathspecItem,
  parsePathspecItem,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import { readSubmoduleDirt, type SubmoduleDirt } from "./status-command.js";
import {
  isSubmoduleIgnoreMode,
  parseGitmodules,
  type SubmoduleIgnoreMode,
} from "./submodule-config.js";
import {
  openSubmoduleRepository,
  readDiffSubmoduleConfig,
  type SubmoduleDiffFormat,
  showSubmoduleDiffSummary,
  submoduleHeader,
} from "./submodule-summary.js";
import { TextconvCaches } from "./textconv-cache.js";

/** An index without in-tree attributes files: the attribute stack of a diff of two trees. */
const WITHOUT_INDEX_ATTRIBUTES: { direction: "checkin"; index: AttributesIndex } = {
  direction: "checkin",
  index: { attributesBlob: () => undefined },
};

/** The output formats of {@link DiffCommand.callText} */
/**
 * The outputs whose diff git prefetches (diffcore_std's `output_formats_to_prefetch`: the
 * diffstat kinds, the patch, `--dirstat`)
 */
const PREFETCH_FORMATS = new Set<string>(["patch", "stat", "numstat", "shortstat", "dirstat"]);

/**
 * The repository blobs of a diff's pairs (git's `diff_add_if_missing`: each side whose id is
 * known, no submodule), in queue order, old side first.
 */
function prefetchIds(entries: readonly DiffEntry[]): ObjectId[] {
  const out: ObjectId[] = [];
  const add = (id: ObjectId | undefined, mode: number | undefined) => {
    if (
      id &&
      !isNullObjectId(id) &&
      mode !== GITLINK &&
      mode !== undefined &&
      mode !== 0 &&
      (mode & 0o170000) !== 0o040000
    )
      out.push(id);
  };
  for (const e of entries) {
    if (e.unmerged) continue;
    if (!e.readOld) add(e.oldId, e.oldMode);
    if (!e.readNew && !e.newIdUnknown) add(e.newId, e.newMode);
  }
  return out;
}

export type DiffOutputFormat =
  /**
   * `--raw` (diff.c's `diff_flush_raw`): `:<old mode> <new mode> <old id> <new id> <status>`,
   * a tab and the path(s); ids abbreviated unless {@link DiffTextOptions.rawFullIds}
   */
  | "raw"
  | "patch"
  | "stat"
  | "numstat"
  | "shortstat"
  | "summary"
  | "name-only"
  | "name-status"
  /**
   * `--dirstat`: the share of the change each directory holds (see
   * {@link DiffTextOptions.dirstat}, `diff.dirstat`)
   */
  | "dirstat"
  /**
   * `--check`: the whitespace errors and leftover conflict markers the change adds (see
   * {@link writePairCheck}); it turns the other formats off, and {@link DiffCommand.exitCode}
   * gets 2 when it found any
   */
  | "check";

/** Options of the text output that `git diff` takes on its command line */
export interface DiffTextOptions
  extends Omit<
      DiffOutputOptions,
      | "driver"
      | "algorithm"
      | "indentHeuristic"
      | "ignoreRegex"
      | "colors"
      | "wsHighlight"
      | "whitespaceRule"
      | "defaultWordRegex"
      | "anchors"
    >,
    DiffColorOptions {
  /**
   * The builtin diff drivers (funcname and word regexes) of that git version (default 2.56):
   * 2.43 has no `ini`, `r` and `swift` drivers and older `bash`, `csharp` and `scheme` ones
   */
  driverCompatibility?: "2.43" | "2.56";
  /** `--diff-algorithm` (default `diff.algorithm`, else myers) */
  algorithm?: XdiffAlgorithm;
  /** `--indent-heuristic` / `--no-indent-heuristic` (default `diff.indentHeuristic`, true) */
  indentHeuristic?: boolean;
  /**
   * diff_options.stat_sep: text written after the blank line that separates a stat or
   * summary from the patch (format-patch's MIME part header with `--attach`/`--inline`)
   */
  statSep?: string;
  /**
   * `--abbrev=<n>`: the `index` lines' ids at least n digits, clamped as git clamps it (below
   * 4, 0 too, is 4; above 40 is 40); the combined diffs of conflicted paths ignore it, as
   * git's do
   */
  abbrev?: number;
  /** `--stat=...` widths (default width 80, as git without a terminal) */
  stat?: DiffstatOptions;
  /**
   * `-z`: the `raw`, `name-only`, `name-status` and `numstat` outputs end each field with a
   * NUL instead of a tab or a newline, paths unquoted; the separator before a patch is a NUL
   */
  nullTerminated?: boolean;
  /**
   * The `raw` output's ids in full, as the plumbing commands print them (`opt->abbrev = 0`)
   * unless `--abbrev` is given ({@link abbrev}); default false (`git diff --raw` abbreviates)
   */
  rawFullIds?: boolean;
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
   * `--submodule=<format>`: a submodule's change as a `Subproject commit` patch (`short`),
   * the commits between its two sides (`log`), or the diff of its content (`diff`); default
   * `diff.submodule`, else `short`
   */
  submoduleFormat?: SubmoduleDiffFormat;
  /**
   * Whether the diff configuration of the porcelain commands is read (`git_diff_ui_config`:
   * `diff.submodule`, its warnings and failures); default true. Plumbing (`diff-tree`) and
   * `format-patch` (whose `git_format_config` skips `diff.submodule`) read none.
   */
  uiConfig?: boolean;
  /**
   * `--textconv` / `--no-textconv`: run `diff.<driver>.textconv` on both sides of a patch
   * (default true, as `git diff`); it takes a runner registered with
   * `installTextconvRunner`, without one no textconv applies
   */
  textconv?: boolean;
  /**
   * `-R`: the two sides swapped (an addition shows as a deletion, the new side first), their
   * prefixes with them (`diff --git b/f a/f`). Combined diffs of conflicted paths are not swapped.
   */
  reverse?: boolean;
  /**
   * `--diff-filter=<letters>`: only the pairs of these statuses (`A`dded, `C`opied,
   * `D`eleted, `M`odified, `R`enamed, `T`ype changed, `U`nmerged, `X` unknown, `B`roken);
   * a lowercase letter leaves its status out instead, and `*` keeps every pair as long as one
   * of them matches (all or none). An unknown letter throws git's
   * `error: unknown change class '<c>' in --diff-filter=<letters>` (exit 129). The combined
   * diff (`diff --cc`) of a conflicted path is not filtered, as git's is not.
   */
  diffFilter?: string;
  /**
   * `--relative=<path>`: only the paths that start with `<path>` (a string prefix, as git's
   * `strncmp`: `sub` takes `subdir/` too), shown without it (and the `/` after it);
   * `--no-relative` is `false`. The commands run at the top of the worktree, so `true`
   * (`--relative` without a path, or `diff.relative`) shows every path as it is.
   */
  relative?: string | boolean;
  /**
   * `--rotate-to=<path>`: the output starts at this path, the ones before it moved to the end;
   * `git diff` throws `fatal: No such path '<path>' in the diff` when no pair has it, `git
   * log` starts at the first path after it
   */
  rotateTo?: string;
  /** `--skip-to=<path>`: as {@link rotateTo}, the paths before it left out */
  skipTo?: string;
  /**
   * `-I<regex>` (`--ignore-matching-lines`): changes whose lines all match one of these POSIX
   * extended regexes are not shown (xdiff's `xdl_mark_ignorable_regex`); an invalid one
   * throws git's `error: invalid regex given to -I: '<regex>'` (exit 129)
   */
  ignoreMatchingLines?: readonly string[];
  /**
   * `--quiet` still detects renames and copies (git 2.43; default false: git 2.5x's
   * diff_setup_done turns `detect_rename` off under `quick`, so `--quiet --diff-filter=R`
   * finds nothing there)
   */
  quietDetectsRenames?: boolean;
  /**
   * `--exit-code` and `--quiet` count only the pairs an output shows (default true, git 2.5x,
   * whose porcelain diff turns `diff_from_contents` on with an exit status: `--summary` alone
   * then exits 0, a pair whose patch shows nothing does not count); false counts every queued
   * pair unless a whitespace option or `-I` is given, as git 2.43
   */
  exitCodeFromContents?: boolean;
  /**
   * `-S<string>`: only the pairs whose two sides hold the string a different number of
   * times (diffcore-pickaxe.c), read through textconv unless `textconv: false`. An empty
   * string throws git's `error: -S requires a non-empty argument` (exit 129).
   */
  pickaxeString?: string;
  /**
   * `-G<regex>`: only the pairs whose added or removed lines match this POSIX extended
   * regex; binary pairs are passed over unless `text` (or textconv makes them text). An
   * empty one throws `error: -G requires a non-empty argument` (exit 129), an invalid one
   * `fatal: invalid regex: <message>` (exit 128).
   */
  pickaxeGrep?: string;
  /**
   * `--find-object=<object>` (each a revision naming an object): only the pairs with one of
   * them on either side; a diff of two trees also lists the subtrees that changed, so a tree
   * can be found too (`tree_in_recursive`). One that names nothing throws `error: unable to
   * resolve '<object>'` (exit 129).
   */
  findObjects?: readonly string[];
  /** `--pickaxe-regex`: `-S` takes a POSIX extended regex */
  pickaxeRegex?: boolean;
  /** `--pickaxe-all`: when one pair matches, every pair is kept; when none, none */
  pickaxeAll?: boolean;
  /** `-i` / `--regexp-ignore-case` of `-S`/`-G` (ASCII case folded) */
  pickaxeIgnoreCase?: boolean;
  /**
   * `-M[<n>]` / `--find-renames[=<n>]`: detect renames, at least this similar (git's
   * syntax: `90%`, `9` and `.9` alike; `true` the default 50%); `false` is `--no-renames`.
   * Wins over {@link DiffCommand.setRenames} and `diff.renames`. Trailing text throws git's
   * `error: invalid argument to find-renames` (exit 129).
   */
  findRenames?: boolean | string;
  /**
   * `-C[<n>]` / `--find-copies[=<n>]`: renames and copies, from the modified paths too (the
   * threshold as {@link findRenames}). With `diff.renames=copies` and nothing else asking,
   * git's second `-C` is found: copies are then found harder.
   */
  findCopies?: boolean | string;
  /** `--find-copies-harder` (or `-C -C`): unchanged paths are copy sources too */
  findCopiesHarder?: boolean;
  /**
   * `-B[<n>][/<m>]` / `--break-rewrites`: modifications that changed at least `<n>` (default
   * 50%) are broken into a deletion and a creation for rename detection, and merged back
   * unless they removed at least `<m>` (default 60%) of the old content, shown then as a
   * complete rewrite (`dissimilarity index`, `M<score>`)
   */
  breakRewrites?: boolean | string;
  /**
   * `--dirstat=<params>` for the `dirstat` format: comma-separated `changes`, `lines`,
   * `files`, `cumulative`, `noncumulative` and a cut-off percentage (default `diff.dirstat`,
   * else `changes,noncumulative,3`)
   */
  dirstat?: string;
  /**
   * `--anchored=<text>`: the patience diff, lines starting with one of these texts kept
   * unchanged where they are unique on both sides
   */
  anchored?: readonly string[];
}

/** Whether options ask for a pickaxe (git's `DIFF_PICKAXE_KINDS_MASK`) */
export function hasPickaxe(o: DiffTextOptions): boolean {
  return (
    o.pickaxeString !== undefined ||
    o.pickaxeGrep !== undefined ||
    (o.findObjects !== undefined && o.findObjects.length > 0)
  );
}

/**
 * diff.c's checks of the pickaxe options (the option callbacks' empty-argument errors, then
 * diff_setup_done's combinations), before anything is read
 */
export function checkPickaxeOptions(o: DiffTextOptions): void {
  if (o.pickaxeString === "") {
    throw new InvalidArgumentError(
      "pickaxeString",
      "",
      "error: -S requires a non-empty argument",
    ).withExitCode(129);
  }
  if (o.pickaxeGrep === "") {
    throw new InvalidArgumentError(
      "pickaxeGrep",
      "",
      "error: -G requires a non-empty argument",
    ).withExitCode(129);
  }
  const kinds =
    (o.pickaxeString !== undefined ? 1 : 0) +
    (o.pickaxeGrep !== undefined ? 1 : 0) +
    ((o.findObjects?.length ?? 0) > 0 ? 1 : 0);
  if (kinds > 1) {
    throw new GitApiError(
      "fatal: options '-G', '-S', and '--find-object' cannot be used together",
    ).withExitCode(128);
  }
  if (o.pickaxeGrep !== undefined && o.pickaxeRegex) {
    throw new GitApiError(
      "fatal: options '-G' and '--pickaxe-regex' cannot be used together, use '--pickaxe-regex' with '-S'",
    ).withExitCode(128);
  }
  if (o.pickaxeAll && (o.findObjects?.length ?? 0) > 0) {
    throw new GitApiError(
      "fatal: options '--pickaxe-all' and '--find-object' cannot be used together, use '--pickaxe-all' with '-G' and '-S'",
    ).withExitCode(128);
  }
}

/** git's status letters `--diff-filter` takes (`diff_status_letters`) */
const FILTER_LETTERS = "ACDMRTXU*B";

/** The bits of `--diff-filter=<letters>` (git's `filter`, `filter_not` folded in) */
function parseDiffFilter(spec: string): Set<string> {
  const on = new Set<string>();
  const off = new Set<string>();
  for (const c of spec) {
    const upper = c >= "a" && c <= "z" ? c.toUpperCase() : c;
    if (!FILTER_LETTERS.includes(upper) || upper.length !== 1) {
      throw new InvalidArgumentError(
        "diffFilter",
        spec,
        `error: unknown change class '${c}' in --diff-filter=${spec}`,
      ).withExitCode(129);
    }
    (upper === c ? on : off).add(upper);
  }
  // diff_setup_done: a negation alone starts from every bit but `*`
  if (off.size > 0 && on.size === 0) {
    for (const l of FILTER_LETTERS) if (l !== "*") on.add(l);
  }
  for (const l of off) on.delete(l);
  return on;
}

/** git's status letter of a queued entry */
function statusOf(entry: DiffEntry): string {
  if (entry.unmerged) return "U";
  switch (entry.changeType) {
    case ChangeType.ADD:
      return "A";
    case ChangeType.DELETE:
      return "D";
    case ChangeType.RENAME:
      return "R";
    case ChangeType.COPY:
      return "C";
    default:
      return entry.oldMode !== undefined &&
        entry.newMode !== undefined &&
        (entry.oldMode & S_IFMT) !== (entry.newMode & S_IFMT)
        ? "T"
        : "M";
  }
}

/** diffcore_apply_filter over the queue */
function applyDiffFilter(entries: DiffEntry[], filter: Set<string> | undefined): DiffEntry[] {
  if (!filter) return entries;
  // match_filter: a modification with a score is a broken pair (-B), filtered as `B`
  const matches = (e: DiffEntry) => {
    const status = statusOf(e);
    return status === "M" && e.score ? filter.has("B") : filter.has(status);
  };
  if (filter.has("*")) return entries.some(matches) ? entries : [];
  return entries.filter(matches);
}

/**
 * diffcore_rotate: the queue from the pair whose (new side's) path is `to`, the ones before
 * it after it (`skip`: dropped); `strict` (`git diff`) needs that exact path, else the first
 * path after it starts, and a path past every pair changes nothing.
 */
function rotateEntries(entries: DiffEntry[], to: string, skip: boolean, strict: boolean) {
  if (entries.length === 0) return entries;
  let at = 0;
  for (; at < entries.length; at++) {
    const e = entries[at] as DiffEntry;
    const cmp = compareGitPaths(to, e.newPath ?? e.oldPath ?? "");
    if (cmp === 0) break;
    if (!strict && cmp < 0) break;
  }
  if (at >= entries.length) {
    if (strict) throw new GitApiError(`fatal: No such path '${to}' in the diff`);
    return entries;
  }
  return skip ? entries.slice(at) : [...entries.slice(at), ...entries.slice(0, at)];
}

/** strip_prefix: the path without `prefix` and the `/` after it */
function stripPrefix(path: string, prefix: string): string {
  const rest = path.slice(prefix.length);
  return rest.startsWith("/") ? rest.slice(1) : rest;
}

/** An entry with its two sides swapped (`diff -R`). */
function reverseEntry(entry: DiffEntry): DiffEntry {
  if (entry.unmerged) return entry;
  const changeType =
    entry.changeType === ChangeType.ADD
      ? ChangeType.DELETE
      : entry.changeType === ChangeType.DELETE
        ? ChangeType.ADD
        : entry.changeType;
  const out: DiffEntry = { changeType };
  if (entry.newPath !== undefined) out.oldPath = entry.newPath;
  if (entry.oldPath !== undefined) out.newPath = entry.oldPath;
  if (entry.newId !== undefined) out.oldId = entry.newId;
  if (entry.oldId !== undefined) out.newId = entry.oldId;
  if (entry.newMode !== undefined) out.oldMode = entry.newMode;
  if (entry.oldMode !== undefined) out.newMode = entry.oldMode;
  if (entry.readNew) out.readOld = entry.readNew;
  if (entry.readOld) out.readNew = entry.readOld;
  if (entry.score !== undefined) out.score = entry.score;
  if (entry.lineRanges) out.lineRanges = entry.lineRanges;
  if (entry.newIdNull || entry.newIdUnknown) out.oldIdNull = true;
  if (entry.oldIdNull) out.newIdNull = true;
  return out;
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
  /** Which changes of its own such a submodule holds (for `--submodule=log`) */
  dirt?: SubmoduleDirt;
  /**
   * A worktree submodule at another commit than its index entry: git's diff-index (and
   * diff-files) gives such a side the null id, filled from the worktree only when a patch is
   * printed (`get_stat_data`, `diff_fill_oid_info`). The pair is reported whatever the other
   * side holds (`show_modified`), and no exact rename pairs with it.
   */
  unknownId?: boolean;
  /**
   * Plumbing (`diff-files`, `diff-index`): a file whose stat differs from its entry, which
   * git takes as changed without hashing it (`ie_match_stat`): its raw id is the null id
   */
  rawNull?: boolean;
}

/** What {@link DiffCommand.setQueue} runs over a queue given */
export interface PresetQueueOptions {
  /**
   * Run diffcore's rename and break detection over it as over a comparison's queue
   * (`diffcore_std`), with `-M`/`-C`/`-B` as the text options give them (no `diff.renames`)
   */
  diffcore?: boolean;
  /**
   * `--find-copies-harder`'s sources besides the queue's: every file of the old side (the
   * old tree, the index of `diff-files`)
   */
  copySources?: () => Promise<Map<string, { mode: number; id: ObjectId }>>;
}

/** diffcore's settings of one run (see `DiffCommand.diffcoreSettings`) */
interface DiffcoreSettings {
  detect: false | "renames" | "copies";
  /** The rename/copy threshold (git's `rename_score`), default 50% */
  score?: number;
  /** `--find-copies-harder` */
  harder: boolean;
  /** `-B` */
  breaks?: BreakScores;
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
const encoder = new TextEncoder();

/** The chunks as one array. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

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

/**
 * `diff.renames` as git_config_rename reads it: `copies`/`copy` detect copies too.
 *
 * @internal
 */
export function renamesValue(value: string | undefined): boolean | "copies" | undefined {
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
  /** revs->combine_merges: a conflicted path as its combined diff (`git diff`'s default) */
  private combineMerges = true;
  /**
   * diffopt.flags.dirty_submodules: a submodule at another commit checked for dirt too
   * (default: when a patch is printed, as `diff_setup_done` sets it; always for `call()`)
   */
  private dirtySubmodules?: boolean;
  /** `diff.submodule` (its last value git knows), read by the text outputs */
  private configuredSubmoduleFormat?: SubmoduleDiffFormat;
  /** The colors of the output, read with the diff configuration (or given by `git log`) */
  private colorSettings?: DiffColorSettings;

  /**
   * The colors already read (`readDiffColorSettings`): `git log` reads them once for all its
   * commits' diffs
   *
   * @internal
   */
  setColorSettings(settings: DiffColorSettings): this {
    this.checkCallable();
    this.colorSettings = settings;
    return this;
  }
  private readonly configWarnings: string[] = [];
  /** {@link dirtySubmodules} for the comparison being collected */
  private dirtyThisCall = true;
  /** The `ignore` setting of each submodule's path (see `submoduleIgnores`) */
  private submoduleIgnoreMap?: Promise<Map<string, "none" | "untracked" | "dirty" | "all">>;
  private pathFilter?: string;
  private pathspecItems?: PathspecItem[];
  private renames?: boolean;
  private renameLimit?: number;
  private textOptions: DiffTextOptions = {};
  /** `--ignore-submodules=<when>`: overrides the submodule configuration */
  private ignoreSubmodulesOverride?: SubmoduleIgnoreMode;
  /** The index read instead of the working copy's (see {@link setTemporaryIndex}) */
  private temporaryIndex?: Staging;
  /** Intent-to-add entries are in the index as empty files (plumbing's `diff-index --cached`) */
  private intentToAddVisible = false;
  /** The index stands for a tree (see {@link setIndexAsTree}) */
  private indexAsTree = false;
  /** `--exit-code` */
  private exitWithStatus = false;
  /** `--quiet` */
  private quiet = false;
  /** `--merge-base` */
  private mergeBase = false;
  /** Whether `--rotate-to`/`--skip-to` need their exact path (`git diff`; not `git log`) */
  private rotateStrict = true;
  /** git's `has_changes` of the last call */
  private changesFound = false;
  /** git's `check_failed`: `--check` found an error in the last call */
  private checkFailed = false;
  /** The revisions given resolved (ranges, `--merge-base`) */
  private sidesResolved = false;
  /** The compiled pickaxe (`-S`, `-G`, `--find-object`), once the options are checked */
  private pickaxe?: DiffPickaxe;
  /**
   * `--find-object`'s `tree_in_recursive`: the subtrees of a diff of two trees, by the side
   * map their blobs go to
   */
  private treeSides?: Map<Map<string, Side>, Map<string, Side>>;

  /**
   * `--exit-code`: {@link exitCode} is 1 when the diff found differences, as git's status
   * (`diff_result_code`). With whitespace options or `-I`, only pairs whose patch shows a
   * change count (git's `diff_from_contents`).
   */
  setExitCode(exitCode: boolean): this {
    this.checkCallable();
    this.exitWithStatus = exitCode;
    return this;
  }

  /**
   * `--quiet`: {@link callText} and {@link callBytes} print nothing and {@link exitCode} is
   * 1 when anything differs (`--exit-code`). As git's `quick` flag, the diff stops at its
   * first difference: no rename detection (git 2.5x; see
   * {@link DiffTextOptions.quietDetectsRenames}), no content read past the first pair that
   * shows a change.
   */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /**
   * `--merge-base`: diff from the merge base of the old tree and the new one (`git diff
   * --merge-base A B`), or of the old tree and HEAD against the index (`--cached`) or the
   * worktree (`git diff --merge-base A`). Both must be commits with exactly one merge base,
   * else git's `fatal: no merge base found` / `fatal: multiple merge bases found`; a range
   * throws `fatal: --merge-base does not work with ranges`.
   */
  setMergeBase(mergeBase: boolean): this {
    this.checkCallable();
    this.mergeBase = mergeBase;
    return this;
  }

  /**
   * `--rotate-to`/`--skip-to` take the first path after a missing one, as `git log` does,
   * instead of failing as `git diff` does.
   *
   * @internal
   */
  setRotateStrict(strict: boolean): this {
    this.checkCallable();
    this.rotateStrict = strict;
    return this;
  }

  /**
   * The exit status `git diff` ends with (`diff_result_code`): bit 1 when `--exit-code` or
   * `--quiet` is set and the last call found differences, bit 2 when its `--check` (the
   * `check` format) found errors.
   */
  get exitCode(): number {
    return (
      ((this.exitWithStatus || this.quiet) && this.changesFound ? 1 : 0) |
      (this.checkFailed ? 2 : 0)
    );
  }

  /** Whether the last call's `--check` found errors (git's `check_failed`) */
  get checkFoundErrors(): boolean {
    return this.checkFailed;
  }

  /** Whether the last call found differences (git's `has_changes`) */
  get hasChanges(): boolean {
    return this.changesFound;
  }

  /**
   * Show intent-to-add entries as the empty files they name, as plumbing's
   * `diff-index --cached` and `diff-files` do (porcelain `git diff` sets
   * `ita_invisible_in_index`): in a `--cached` comparison on the index side, against the
   * worktree as the old side (`git add -e`'s diff).
   *
   * @internal
   */
  setIntentToAddVisible(visible: boolean): this {
    this.checkCallable();
    this.intentToAddVisible = visible;
    return this;
  }

  /**
   * Set the old (base) tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set, defaults to HEAD (or the index, for the worktree diff). Without a new tree, a
   * range compares two commits as `git diff` does: `A..B` is `A B`, `A...B` diffs B from the
   * merge base of A and B (an empty side is HEAD).
   *
   * @param refOrId Commit-ish or tree ID, or a range
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
   * Whether a conflicted path is shown as its combined diff (`diff --cc` of stages 2 and 3
   * against the file, `git diff`'s default) or, as git's `diff-files -p` and the unstaged
   * diff of `git status -vv` show it, listed as unmerged (`* Unmerged path <path>`) and
   * diffed as its stage 2 against the file.
   *
   * @example
   * ```typescript
   * const text = await git.diff().setCombineMerges(false).callText("patch");
   * ```
   */
  setCombineMerges(combine: boolean): this {
    this.checkCallable();
    this.combineMerges = combine;
    return this;
  }

  /**
   * How a submodule's change is shown in the patch (`--submodule=<format>`): `short` (the
   * default, unless `diff.submodule` says otherwise) as a `Subproject commit` patch, `log`
   * as the commits between its two sides (`Submodule sub 1234567..89abcde:` and `  > subject`
   * lines, git's `show_submodule_diff_summary`), `diff` as the diff of the submodule's own
   * files, their paths under the submodule's (`show_submodule_inline_diff`).
   */
  setSubmoduleFormat(format: SubmoduleDiffFormat): this {
    this.checkCallable();
    this.textOptions = { ...this.textOptions, submoduleFormat: format };
    return this;
  }

  /**
   * `--ignore-submodules=<when>`: what of submodules to ignore, whatever
   * `diff.ignoreSubmodules` and `submodule.<name>.ignore` say (`all`: their changes; `dirty`:
   * their worktrees; `untracked`: untracked files in them; `none`: nothing).
   */
  setIgnoreSubmodules(mode: SubmoduleIgnoreMode): this {
    this.checkCallable();
    this.ignoreSubmodulesOverride = mode;
    return this;
  }

  /**
   * Whether a submodule whose worktree is at another commit than its entry is also checked
   * for changes of its own (`Subproject commit <id>-dirty`), as git's patch output does
   * (`diff_setup_done` sets `dirty_submodules` for it). `git status -v` diffs without it:
   * only a submodule at its entry's commit is shown dirty there.
   */
  setDirtySubmodules(dirty: boolean): this {
    this.checkCallable();
    this.dirtySubmodules = dirty;
    return this;
  }

  /**
   * What git prints on stderr reading its diff configuration, once a text output was made:
   * `warning: Unknown value for 'diff.submodule' config variable: '<value>'` for each value
   * of `diff.submodule` it does not know.
   */
  get warnings(): readonly string[] {
    return this.configWarnings;
  }

  /**
   * git_diff_ui_config, which `git diff` (and log, show) runs before any option is read:
   * `diff.submodule`, its warnings, and the failure of a variable without a value.
   */
  private readUiConfig(): void {
    this.colorSettings ??= readDiffColorSettings(
      this.workingCopy,
      this.textOptions,
      this.textOptions.uiConfig !== false,
    );
    if (this.textOptions.uiConfig === false) return;
    const { format, warnings } = readDiffSubmoduleConfig(this.workingCopy);
    this.configuredSubmoduleFormat = format;
    this.configWarnings.splice(0, this.configWarnings.length, ...warnings);
    // git_diff_ui_config: a diff.dirstat with errors is warned about, the rest applied
    const dirstat = this.config.value("diff.dirstat");
    this.configuredDirstat = { ...DEFAULT_DIRSTAT };
    if (dirstat !== undefined) {
      const errors = parseDirstatParams(dirstat, this.configuredDirstat);
      if (errors.length > 0) {
        this.configWarnings.push(
          `warning: Found errors in 'diff.dirstat' config variable:\n${errors.join("\n")}\n`,
        );
      }
    }
  }

  /** `diff.dirstat`'s parameters (git's defaults without it) */
  private configuredDirstat?: DirstatParams;

  /** The dirstat's parameters: `diff.dirstat`, then {@link DiffTextOptions.dirstat} */
  private dirstatParams(): DirstatParams {
    const params = { ...(this.configuredDirstat ?? DEFAULT_DIRSTAT) };
    const text = this.textOptions.dirstat;
    if (text !== undefined) {
      const errors = parseDirstatParams(text, params);
      if (errors.length > 0) {
        throw new GitApiError(
          `fatal: Failed to parse --dirstat/-X option parameter:\n${errors.join("\n")}\n`,
        ).withExitCode(128);
      }
    }
    return params;
  }

  /** show_dirstat (or show_dirstat_by_line): the dirstat of the pairs */
  private async writeDirstat(
    sink: ByteSink,
    pairs: DiffFilePair[],
    unmerged: Set<DiffFilePair>,
    options: DiffOutputOptions,
    params: DirstatParams,
  ): Promise<void> {
    const files: DirstatFile[] = [];
    if (params.byLine) {
      for (const pair of pairs) {
        if (unmerged.has(pair)) {
          files.push({ name: pair.new?.path ?? pair.old?.path ?? "", changed: 0 });
          continue;
        }
        for (const f of await computeDiffstat([pair], options)) {
          const damage = f.added + f.deleted;
          // binary files count bytes: 64 of them a line
          files.push({ name: f.name, changed: f.isBinary ? Math.ceil(damage / 64) : damage });
        }
      }
    } else {
      const countLastSpan = this.textOptions.renameCountLastSpan;
      for (const pair of pairs) {
        if (unmerged.has(pair)) continue;
        const { old: one, new: two } = pair;
        const name = two?.path ?? one?.path ?? "";
        let damage: number;
        if (one && two && one.idValid !== false && two.idValid !== false && one.id === two.id) {
          damage = 0;
        } else if (params.byFile) damage = 1;
        else {
          if (one && two) {
            const a = await one.read();
            const b = await two.read();
            const { copied, added } = countChanges(
              spanCounts(a, { countLastSpan }),
              spanCounts(b, { countLastSpan }),
            );
            damage = a.length - copied + added;
          } else if (one) damage = (await one.read()).length;
          else if (two) damage = (await two.read()).length;
          else continue;
          if (!damage) damage = 1;
        }
        files.push({ name, changed: damage });
      }
    }
    sink.text(formatDirstat(files, params));
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
   * Reads `index` instead of the working copy's index, as git run with `GIT_INDEX_FILE`
   * pointing at a temporary index (`stash -p`'s index of HEAD's tree). The diff only reads it.
   */
  setTemporaryIndex(index: Staging): this {
    this.checkCallable();
    this.temporaryIndex = index;
    return this;
  }

  protected override get staging(): Staging {
    return this.temporaryIndex ?? super.staging;
  }

  /**
   * Compares the old tree with `index` taken as a tree, as git's `do_diff_cache` of an index
   * built in memory (`stash show -u`'s worktree and untracked trees): `--cached` against
   * it, with the prefixes of two trees (no mnemonic `c/` and `i/`).
   *
   * @internal
   */
  setIndexAsTree(index: Staging): this {
    this.checkCallable();
    this.temporaryIndex = index;
    this.cached = true;
    this.indexAsTree = true;
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
    this.pathspecItems = paths.map((p) => parsePathspecItem(p, { attr: true }));
    if (this.pathspecItems.length > 0 && this.pathspecItems.every((i) => i.exclude)) {
      this.pathspecItems.push(parsePathspecItem("."));
    }
    return this;
  }

  /**
   * The queue {@link callFormats} prints instead of comparing the trees: pairs a caller found
   * itself (`git log -L` queues each commit's pairs with their line ranges, line-log.c's
   * `line_log_queue_pairs`). diffcore's later stages (pickaxe, order, `--diff-filter`) still
   * apply.
   *
   * @internal
   */
  setQueue(entries: DiffEntry[], options: PresetQueueOptions = {}): this {
    this.checkCallable();
    this.presetQueue = entries;
    this.presetQueueOptions = options;
    return this;
  }

  private presetQueue?: DiffEntry[];
  private presetQueueOptions: PresetQueueOptions = {};

  /**
   * How a comparison of trees walks them (tree-diff.c): `recursive` lists the blobs below the
   * subtrees that differ (`-r`, the porcelain's default), `flat` the differing entries of the
   * top tree, subtrees as entries of mode 040000 (plumbing's default without `-r`), and
   * `show-trees` the blobs and the subtrees on the way to them (`-t`)
   *
   * @internal
   */
  setTreeWalk(walk: "recursive" | "flat" | "show-trees"): this {
    this.checkCallable();
    this.treeWalk = walk;
    return this;
  }

  private treeWalk: "recursive" | "flat" | "show-trees" = "recursive";

  /**
   * Compare the worktree as the plumbing commands do (`diff-files`, `diff-index` without
   * `--cached`): no refresh, a file whose stat differs from its entry is a change even when
   * its content is the same, and its raw id is the null id (not hashed); an unmerged path's
   * raw line gives the worktree file's mode
   *
   * @internal
   */
  setPlumbingWorktree(plumbing: boolean): this {
    this.checkCallable();
    this.plumbingWorktree = plumbing;
    return this;
  }

  private plumbingWorktree = false;

  /** The sides an unmerged path's raw line shows (diff_unmerge's pair), by path */
  private readonly unmergedRaw = new Map<
    string,
    { oldMode?: number; oldId?: ObjectId; newMode?: number }
  >();

  /** {@link setQueue}'s diffcore run, when asked */
  private async presetDiffcore(entries: DiffEntry[]): Promise<DiffEntry[]> {
    const options = this.presetQueueOptions;
    if (!options.diffcore) return entries;
    const core = this.diffcoreSettings(false);
    if (this.textOptions.diffFilter !== undefined) parseDiffFilter(this.textOptions.diffFilter);
    if (!core.breaks && !core.detect) return entries;
    const queue = [...entries];
    const sources = options.copySources;
    await this.diffcore(queue, core, async () => {
      const out = new Map<string, Side>();
      if (sources) for (const [path, side] of await sources()) out.set(path, side);
      return out;
    });
    return queue;
  }

  /**
   * diffcore's filtering stages over a queue a caller found (the pickaxe, `-O`,
   * `--diff-filter`): git 2.43's `git log -L` runs them on the pairs it follows renames with
   *
   * @internal
   */
  async filterQueue(entries: DiffEntry[]): Promise<DiffEntry[]> {
    await this.preparePickaxe();
    return this.selected(entries);
  }

  /**
   * The diff driver of a path as a diff of two trees finds it (the worktree's attributes,
   * `diff.<driver>.*`, the builtin drivers): `git log -L :<funcname>:<file>` finds functions
   * by its funcname pattern (line-range.c's `userdiff_find_by_path`)
   *
   * @internal
   */
  async driverOf(path: string): Promise<DiffDriver | undefined> {
    return this.outputOptions().driver?.(path);
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

  /** diff.c's `additional_path_headers` (see {@link setAdditionalHeaders}) */
  private additionalHeaders?: Map<string, readonly string[]>;

  /**
   * diff.c's `additional_path_headers` (`--remerge-diff`'s `remerge CONFLICT` lines), by path:
   * the paths within the pathspec keep theirs (log-tree.c's setup_additional_headers). A
   * pair's headers follow its rename lines; a path with headers and no change is shown as a
   * `diff --git` line with its headers alone, unless a pickaxe or a `--diff-filter` without
   * `U` is given (`include_conflict_headers`).
   */
  setAdditionalHeaders(headers: ReadonlyMap<string, readonly string[]>): this {
    this.checkCallable();
    this.additionalHeaders = new Map(headers);
    return this;
  }

  /** The additional headers within the pathspec, undefined for none */
  private headersInPathspec(): Map<string, readonly string[]> | undefined {
    const all = this.additionalHeaders;
    if (!all || all.size === 0) return undefined;
    if (!this.pathspecItems) return all;
    const out = new Map<string, readonly string[]>();
    for (const [path, headers] of all) {
      if (matchPathspec(this.pathspecItems, path, 0) > 0) out.set(path, headers);
    }
    return out.size > 0 ? out : undefined;
  }

  /**
   * diff.c's `include_conflict_headers`: headers present, no pickaxe, and no `--diff-filter`
   * or one that keeps `U`
   */
  private includesConflictHeaders(headers: Map<string, readonly string[]> | undefined): boolean {
    if (!headers || hasPickaxe(this.textOptions)) return false;
    const filter = this.textOptions.diffFilter;
    if (filter === undefined) return true;
    // diff_opt_diff_filter: a lowercase letter starts from every status, each letter then
    // adds (uppercase) or removes (lowercase) its own
    let keepsU = /[a-z]/.test(filter);
    for (const c of filter) {
      if (c === "U") keepsU = true;
      else if (c === "u") keepsU = false;
    }
    return keepsU;
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
    this.dirtyThisCall = this.dirtySubmodules ?? true;
    const run = async () => {
      let entries: DiffEntry[];
      if (this.presetQueue) {
        await this.preparePickaxe();
        entries = await this.presetDiffcore(this.presetQueue);
      } else {
        entries = (await this.collect(this.renames ?? false, false, this.pickaxeReads)).entries;
      }
      // diffcore_pickaxe, diffcore_apply_filter (the entries stay in path order, unswapped)
      const picked = await this.picked(entries);
      const filter = this.textOptions.diffFilter;
      return applyDiffFilter(picked, filter !== undefined ? parseDiffFilter(filter) : undefined);
    };
    const out = hasPickaxe(this.textOptions) ? await this.inOneOperation(run) : await run();
    this.changesFound = out.length > 0;
    return out;
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
    this.dirtyThisCall = this.dirtySubmodules ?? (format === "patch" && !this.quiet);
    this.readUiConfig();
    return this.inOneOperation(async () => {
      if (this.quiet) {
        await this.quietCheck(renames);
        return new Uint8Array(0);
      }
      const collected = await this.collect(
        renames,
        format === "patch",
        PREFETCH_FORMATS.has(format) || this.pickaxeReads,
      );
      const sink = new ByteSink();
      await this.writeFormats(sink, [format], collected);
      return sink.bytes();
    });
  }

  /**
   * `--quiet` (git's `quick` flag, `DIFF_FORMAT_NO_OUTPUT`): whether anything differs, stopping
   * early. Without `--diff-filter` and content options the first queued pair answers
   * (diff_can_quit_early): no renames are detected and no content is read; with content
   * options (`-w`, `-I`, ...) pairs are diffed until one shows a change (diff_flush's
   * `diff_flush_patch_quietly` loop).
   */
  private async quietCheck(renames: boolean | "copies"): Promise<void> {
    const fromContents = this.fromContents;
    const early = this.textOptions.diffFilter === undefined && !fromContents;
    const detect = !early && (this.textOptions.quietDetectsRenames ?? false);
    const collected = await this.collect(
      detect ? renames : false,
      false,
      this.pickaxeReads,
      !early,
    );
    // diff_can_quit_early: the walk stopped at the first change, which a pickaxe (git 2.43,
    // whose quiet diff does not look at contents) may then drop
    const queue = early && this.pickaxe ? collected.entries.slice(0, 1) : collected.entries;
    const entries = await this.selected(queue);
    this.changesFound = entries.length > 0;
    if (!fromContents || entries.length === 0) return;
    this.changesFound = false;
    const options = this.outputOptions();
    Object.assign(options, this.prefixes());
    for (const entry of entries) {
      if (entry.unmerged) {
        this.changesFound = true;
        break;
      }
      const scratch = new ByteSink();
      await writePairPatch(scratch, diffEntryToPair(entry, this.blobs), options);
      if (scratch.length > 0) {
        this.changesFound = true;
        break;
      }
    }
  }

  /**
   * The diffstat of the comparison, one file per pair in git's order (`compute_diffstat` of
   * the diff queue, as a `DIFF_FORMAT_CALLBACK` consumer sees it): an unmerged path as a
   * file with `isUnmerged` and no counts, followed by what the diff holds for it besides.
   * No renames unless {@link setRenames} asks, no textconv.
   */
  async callDiffstat(): Promise<DiffstatFile[]> {
    this.checkCallable();
    this.setCallable(false);
    this.dirtyThisCall = this.dirtySubmodules ?? false;
    return this.inOneOperation(() => this.diffstatFiles());
  }

  /** {@link callDiffstat}'s files. */
  private async diffstatFiles(): Promise<DiffstatFile[]> {
    const collected = await this.collect(this.renames ?? false, false);
    const entries = await this.ordered(collected.entries);
    this.textOptions = { ...this.textOptions, textconv: false };
    const options = this.outputOptions();
    const files: DiffstatFile[] = [];
    for (const entry of entries) {
      if (entry.unmerged) {
        files.push({
          name: entry.oldPath ?? entry.newPath ?? "",
          isRenamed: false,
          isBinary: false,
          isUnmerged: true,
          added: 0,
          deleted: 0,
        });
      } else files.push(...(await computeDiffstat([diffEntryToPair(entry, this.blobs)], options)));
    }
    return files;
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
    this.dirtyThisCall = this.dirtySubmodules ?? formats.includes("patch");
    this.readUiConfig();
    return this.inOneOperation(async () => {
      let followPath = follow;
      let followChange: ChangeType.RENAME | ChangeType.COPY | undefined;
      let collected: { entries: DiffEntry[]; combined: CombinedEntry[] };
      if (this.presetQueue) {
        await this.preparePickaxe();
        collected = { entries: await this.presetDiffcore(this.presetQueue), combined: [] };
      } else if (follow !== undefined) {
        const spec = this.pathspecItems;
        this.pathspecItems = [parsePathspecItem(`:(literal)${follow}`)];
        collected = await this.collect(false, false, false, false);
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
      } else {
        collected = await this.collect(
          renames,
          formats.includes("patch"),
          formats.some((f) => PREFETCH_FORMATS.has(f)) || this.pickaxeReads,
        );
      }
      const followed = {
        ...(followPath !== undefined ? { followPath } : {}),
        ...(followChange !== undefined ? { followChange } : {}),
      };
      // diff_queue_is_empty: headers to include count as a change
      const headers = this.headersInPathspec();
      const withHeaders = this.includesConflictHeaders(headers);
      if (collected.entries.length === 0 && collected.combined.length === 0 && !withHeaders)
        return followed;
      const sink = new ByteSink();
      const queued = await this.writeFormats(sink, formats, collected, headers);
      // diffcore_std left nothing (`--diff-filter`, `--skip-to`): no diff, as an empty one
      if (queued === 0 && collected.combined.length === 0 && !withHeaders) return followed;
      return { bytes: sink.bytes(), ...followed };
    });
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
    headers?: Map<string, readonly string[]>,
  ): Promise<number> {
    const config = this.config;
    const { combined } = collected;
    const entries = await this.selected(collected.entries);
    // diffcore_std's has_changes; with diff_from_contents, what the outputs show (below)
    const fromContents = this.fromContents;
    this.changesFound = !fromContents && entries.length > 0;
    const options = this.outputOptions();
    Object.assign(options, this.prefixes());
    if (this.textOptions.reverse) {
      // diff -R swaps the prefixes with the sides (`diff --git b/f a/f`)
      [options.srcPrefix, options.dstPrefix] = [
        options.dstPrefix ?? "b/",
        options.srcPrefix ?? "a/",
      ];
    }
    const pairs: DiffFilePair[] = [];
    const unmerged = new Set<DiffFilePair>();
    /** The pairs with their full paths, for what git does not shorten (`--summary`) */
    const fullPairs = new Map<DiffFilePair, DiffFilePair>();
    /** The entry of each pair (an unmerged path's sides, for the raw output) */
    const entryOfPair = new Map<DiffFilePair, DiffEntry>();
    const prefix = this.relativePrefix;
    for (const entry of entries) {
      // an unmerged path: only its name is printed
      const pair: DiffFilePair = entry.unmerged
        ? {
            status: "M",
            old: contentSide(
              entry.oldPath ?? "",
              0,
              this.objectFormat.nullId,
              async () => new Uint8Array(0),
            ),
          }
        : this.withTextconvInputs(diffEntryToPair(entry, this.blobs), entry);
      // strip_prefix: names without the `--relative` prefix, attributes by the full path
      const shown: DiffFilePair =
        prefix === undefined
          ? pair
          : {
              ...pair,
              ...(pair.old
                ? {
                    old: {
                      ...pair.old,
                      path: stripPrefix(pair.old.path, prefix),
                      attrPath: pair.old.path,
                    },
                  }
                : {}),
              ...(pair.new
                ? {
                    new: {
                      ...pair.new,
                      path: stripPrefix(pair.new.path, prefix),
                      attrPath: pair.new.path,
                    },
                  }
                : {}),
            };
      fullPairs.set(shown, pair);
      entryOfPair.set(shown, entry);
      if (entry.unmerged) unmerged.add(shown);
      pairs.push(shown);
    }
    const full = (pair: DiffFilePair) => fullPairs.get(pair) ?? pair;
    const quote = options.quotePath;
    const z = this.textOptions.nullTerminated === true;
    const order: DiffOutputFormat[] = [
      "raw",
      "name-only",
      "name-status",
      "numstat",
      "stat",
      "shortstat",
      "dirstat",
      "summary",
      "patch",
    ];
    // run_diff_files prints the combined diff (`diff --cc`) of a conflicted path as it finds
    // it, before diff_flush prints any format of the rest
    if (combined.length > 0 && formats.includes("patch")) {
      // combine-diff.c's index lines take DEFAULT_ABBREV, whatever --abbrev says
      let combinedLengths: ReadonlyMap<string, number> | undefined;
      if (!options.fullIndex) {
        const ids = new Set<string>([this.objectFormat.nullId]);
        for (const c of combined) {
          ids.add(c.ours.objectId);
          ids.add(c.theirs.objectId);
        }
        combinedLengths = await this.idAbbreviator().lengths(ids);
      }
      for (const c of combined) await this.writeCombined(sink, c, options, combinedLengths);
    }
    // diff_flush of an empty queue prints nothing (unless headers are to be shown)
    if (pairs.length === 0 && !headers) return 0;
    if (headers) options.additionalHeaders = (name) => headers.get(name);
    // diff_setup_done: --check turns the other formats off
    if (formats.includes("check")) {
      const check = { conflictMarkerSize: this.conflictMarkerSizeOf() };
      for (const pair of pairs) {
        if (unmerged.has(pair)) continue;
        if (fromContents && this.namesFromContents) {
          // diff_flush_patch_quietly (git 2.50+): the changes are what the patch shows, and
          // a pair whose patch shows nothing is not checked
          const scratch = new ByteSink();
          await writePairPatch(scratch, pair, options);
          if (scratch.length === 0) continue;
          this.changesFound = true;
        } else if (fromContents) {
          // git 2.43 checks every pair, and each one checked counts as a change
          this.changesFound = true;
        }
        if (await writePairCheck(sink, pair, options, check)) this.checkFailed = true;
      }
      return pairs.length;
    }
    let separator = false;
    for (const format of order) {
      if (!formats.includes(format)) continue;
      if (format === "patch" && separator) {
        // DIFF_SYMBOL_SEPARATOR: the line termination (a NUL under -z)
        sink.text(z ? "\0" : "\n");
        // attach the patch instead of inlining it
        if (this.textOptions.statSep) sink.text(this.textOptions.statSep);
      }
      // diff_flush: an empty summary (is_summary_empty) prints nothing and asks no separator
      if (format === "summary") {
        // diff_summary names the paths in full, whatever `--relative` says
        const text = formatSummary(pairs.filter((p) => !unmerged.has(p)).map(full), quote);
        if (text) {
          sink.text(text);
          separator = true;
        }
        continue;
      }
      if (format === "dirstat") {
        const params = this.dirstatParams();
        await this.writeDirstat(sink, pairs, unmerged, options, params);
        // only the dirstat by lines comes with the diffstat's separator
        if (params.byLine) separator = true;
        continue;
      }
      separator = true;
      switch (format) {
        case "patch": {
          const submoduleFormat =
            this.textOptions.submoduleFormat ?? this.configuredSubmoduleFormat ?? "short";
          if (submoduleFormat !== "short") {
            options.submodulePatch = (out, pair, o) =>
              this.writeSubmodulePatch(out, pair, o, submoduleFormat);
          }
          // index lines abbreviate as git does (core.abbrev, the repository's size, uniqueness)
          if (!options.fullIndex) {
            const ids = new Set<string>();
            for (const pair of pairs) {
              if (unmerged.has(pair)) continue;
              ids.add(pair.old?.id ?? this.objectFormat.nullId);
              ids.add(pair.new?.id ?? this.objectFormat.nullId);
            }
            // `--abbrev=<n>`: at least n digits
            options.abbrevLengths = await this.idAbbreviator().lengths(ids, options.abbrev);
          }
          // diff_flush_patch_all_file_pairs: moved lines are looked for over every pair
          const moved = this.colorSettings;
          const out =
            moved?.colors && moved.colorMoved !== "no"
              ? new MovedLineBuffer(moved.colorMoved, moved.colorMovedWs)
              : sink;
          for (const pair of this.withHeaderOnlyPairs(pairs, full, headers)) {
            const before = out.length;
            if (typeof pair === "string") {
              if (this.includesConflictHeaders(headers)) {
                writeHeaderOnlyPatch(out, pair, headers?.get(pair) ?? [], options);
              }
            } else if (unmerged.has(pair)) {
              out.text(`* Unmerged path ${pair.new?.path ?? pair.old?.path}\n`);
            } else await writePairPatch(out, pair, options);
            // builtin_diff's found_changes: the pair showed something
            if (out.length > before) this.changesFound = true;
          }
          if (out instanceof MovedLineBuffer && moved?.colors) {
            out.flushTo(sink, { colors: moved.colors, wsErrorHighlight: moved.wsErrorHighlight });
          }
          break;
        }
        case "raw": {
          // flush_one_pair: --name-status wins over --raw (diff_flush_raw prints the
          // status alone), and --raw over --name-only
          // diff_setup_done: the name formats and --check turn --raw off
          if (formats.some((f) => f === "name-status" || f === "name-only" || f === "check")) {
            continue;
          }
          if (pairs.length > 0) this.changesFound = true;
          const abbreviate = await this.rawAbbreviator(pairs);
          const raw = {
            quotePath: quote,
            nullTerminated: z,
            abbreviate,
            nullId: this.objectFormat.nullId,
          };
          for (const pair of pairs) {
            const entry = entryOfPair.get(pair);
            if (unmerged.has(pair) && entry) {
              // diff_unmerge: the null ids, the sides' modes as the comparison knew them
              const path = entry.newPath ?? entry.oldPath ?? "";
              const side = (mode: number | undefined, id: string | undefined) =>
                contentSide(path, mode ?? 0, id ?? this.objectFormat.nullId, async () => NO_BYTES);
              const u: DiffFilePair = {
                status: "M",
                old: side(entry.oldMode, entry.oldId),
                new: side(entry.newMode, undefined),
              };
              sink.text(formatRawPair(u, raw, "U"));
            } else sink.text(formatRawPair(pair, raw));
          }
          break;
        }
        case "name-only": {
          const names = await this.shownNames(pairs, unmerged, options);
          // flush_one_pair: found_changes for each name listed
          if (names.length > 0) this.changesFound = true;
          if (z) {
            for (const p of names) sink.text(`${p.new?.path ?? p.old?.path ?? ""}\0`);
          } else sink.text(formatNameOnly(names, { quotePath: quote }));
          break;
        }
        case "name-status": {
          const names = await this.shownNames(pairs, unmerged, options);
          // flush_one_pair: found_changes for each name listed
          if (names.length > 0) this.changesFound = true;
          for (const pair of names) {
            if (z) {
              const raw = {
                nullTerminated: true,
                nameStatus: true,
                abbreviate: (id: string) => id,
                nullId: this.objectFormat.nullId,
              };
              sink.text(formatRawPair(pair, raw, unmerged.has(pair) ? "U" : undefined));
            } else if (unmerged.has(pair)) {
              sink.text(`U\t${quotePath(pair.new?.path ?? pair.old?.path ?? "", quote)}\n`);
            } else sink.text(formatNameStatus([pair], { quotePath: quote }));
          }
          break;
        }
        default: {
          const files = [];
          for (const pair of pairs) {
            if (unmerged.has(pair)) {
              // builtin_diffstat of an unmerged pair: its full path
              const name = full(pair).new?.path ?? full(pair).old?.path ?? "";
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
          // compute_diffstat: found_changes when the diffstat lists a file
          if (files.length > 0) this.changesFound = true;
          const statOptions: DiffstatOptions = {
            nameWidth: intValue(config.value("diff.statNameWidth")),
            graphWidth: intValue(config.value("diff.statGraphWidth")),
            ...this.textOptions.stat,
            quotePath: quote,
            ...(this.colorSettings?.colors ? { colors: this.colorSettings.colors } : {}),
          };
          if (format === "stat") sink.text(formatStat(files, statOptions));
          else if (format === "numstat") sink.text(formatNumstat(files, { quotePath: quote }));
          else sink.text(formatShortstat(files));
        }
      }
    }
    return pairs.length;
  }

  /**
   * The raw output's ids: full under {@link DiffTextOptions.rawFullIds} without `--abbrev`,
   * else each abbreviated as git's `diff_aligned_abbrev` (unique, at least `--abbrev` digits)
   */
  private async rawAbbreviator(pairs: DiffFilePair[]): Promise<(id: string) => string> {
    const o = this.textOptions;
    if (o.rawFullIds && o.abbrev === undefined) return (id) => id;
    const nullId = this.objectFormat.nullId;
    const ids = new Set<string>([nullId]);
    for (const p of pairs) {
      if (p.old && !p.old.rawNullId) ids.add(p.old.id);
      if (p.new && !p.new.rawNullId) ids.add(p.new.id);
    }
    const min = abbrevOption(o.abbrev);
    if (min !== undefined && min >= this.objectFormat.hexLength) return (id) => id;
    const lengths = await this.idAbbreviator().lengths(ids, min);
    return (id) => id.slice(0, lengths.get(id) ?? min ?? 7);
  }

  /**
   * create_filepairs_for_header_only_notifications: the pairs, and the paths with headers
   * none of them names first (as strings), sorted by first name (diffcore_fix_diff_index)
   */
  private withHeaderOnlyPairs(
    pairs: DiffFilePair[],
    full: (pair: DiffFilePair) => DiffFilePair,
    headers: Map<string, readonly string[]> | undefined,
  ): (DiffFilePair | string)[] {
    if (!headers) return pairs;
    const nameOf = (pair: DiffFilePair) => {
      const f = full(pair);
      return f.old?.path ?? f.new?.path ?? "";
    };
    const present = new Set(pairs.map(nameOf));
    const out: { name: string; item: DiffFilePair | string }[] = pairs.map((pair) => ({
      name: nameOf(pair),
      item: pair,
    }));
    for (const path of headers.keys()) {
      if (!present.has(path)) out.push({ name: path, item: path });
    }
    out.sort((a, b) => compareBytes(a.name, b.name));
    return out.map((e) => e.item);
  }

  /**
   * builtin_diff's submodule branch: `--submodule=log` (show_submodule_diff_summary) or
   * `--submodule=diff` (show_submodule_inline_diff) for a pair of submodules (or a submodule
   * and nothing).
   */
  private async writeSubmodulePatch(
    sink: ByteSink,
    pair: DiffFilePair,
    options: DiffOutputOptions,
    format: SubmoduleDiffFormat,
  ): Promise<void> {
    // `one->path`: the full path, whatever `--relative` shows
    const path = pair.old?.attrPath ?? pair.old?.path ?? pair.new?.attrPath ?? pair.new?.path ?? "";
    const one = pair.old?.id ?? this.objectFormat.nullId;
    const two = pair.new?.id ?? this.objectFormat.nullId;
    const dirt = pair.new?.submoduleDirt;
    // strbuf_add_unique_abbrev(..., DEFAULT_ABBREV): the superproject's abbreviation
    const abbreviate = (id: ObjectId) => this.idAbbreviator().abbreviate(id);
    const workingCopy = this.workingCopy;
    if (format === "log") {
      const text = await showSubmoduleDiffSummary({
        workingCopy,
        path,
        one,
        two,
        dirt,
        abbreviate,
      });
      const c = options.colors;
      if (!c) {
        sink.text(text);
        return;
      }
      // print_submodule_diff_summary: each commit as diff_emit_submodule_del/_add
      const lines = text.split("\n");
      lines.pop();
      lines.forEach((line, i) => {
        const kind = i > 0 ? /^ {2}([<>]) /.exec(line)?.[1] : undefined;
        if (kind) sink.text(`${kind === "<" ? c.old : c.new}${line}${c.reset}\n`);
        else sink.text(`${line}\n`);
      });
      return;
    }
    const sub = await openSubmoduleRepository(workingCopy, path);
    const header = await submoduleHeader({ path, one, two, dirt, sub, abbreviate });
    sink.text(header.text);
    // a valid left and right commit (or none on that side) to diff
    if (
      !(header.left || one === this.objectFormat.nullId) ||
      !(header.right || two === this.objectFormat.nullId)
    )
      return;
    if (!sub) return;
    const failed = "(diff failed)\n";
    // `git diff` runs in the submodule's directory: one that holds no repository of its own
    // runs it in the superproject, which lacks the submodule's commits
    if (!sub.populated && (await this.worktreeIfAny?.getEntry(path))?.isDirectory) {
      sink.text(failed);
      return;
    }
    const inner = new DiffCommand(sub.repository)
      .setOldTree(header.left ? one : this.objectFormat.emptyTreeId)
      .setSubmoduleFormat("diff")
      .setOptions({
        // the child `git diff --color=always|never` reads the submodule's own color slots
        color: options.colors !== undefined,
        srcPrefix: `${options.srcPrefix ?? "a/"}${path}/`,
        dstPrefix: `${options.dstPrefix ?? "b/"}${path}/`,
      });
    // modified content: the submodule's worktree is diffed, not its commit
    if (!dirt?.modified) inner.setNewTree(header.right ? two : this.objectFormat.emptyTreeId);
    try {
      sink.push(await inner.callBytes("patch"));
    } catch {
      sink.text(failed);
    }
  }

  /** The combined diff (`diff --cc`) of a conflicted path: stages 2 and 3 against the file */
  private async writeCombined(
    sink: ByteSink,
    c: CombinedEntry,
    options: DiffOutputOptions,
    lengths: ReadonlyMap<string, number> | undefined,
  ): Promise<void> {
    const worktree = this.worktreeIfAny;
    const driver = await options.driver?.(c.path);
    // combine-diff.c's grab_blob: a gitlink's or a deleted side's content is not converted
    const textconv = driver?.textconv;
    const stage = async (e: StageEntry) => {
      const side = blobSide(this.blobs, c.path, e.mode, e.objectId);
      const convert =
        textconv && (e.mode & S_IFMT) !== GITLINK && e.objectId !== this.objectFormat.nullId;
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
        content = encoder.encode(`Subproject commit ${this.objectFormat.nullId}\n`);
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
        result: { id: this.objectFormat.nullId, mode, content },
      },
      {
        ...options,
        ...(textconv
          ? { binary: false }
          : driver?.binary !== undefined
            ? { binary: driver.binary }
            : {}),
        abbreviate: (id) => id.slice(0, options.fullIndex ? id.length : (lengths?.get(id) ?? 7)),
      },
    );
  }

  /**
   * The textconv input of a pair's sides, as git's `prepare_temp_file` writes it: a blob
   * smudged as checkout would write it (`convert_to_working_tree`), a worktree file's bytes
   * as they are (the entry's `readNew`, which reads it cleaned)
   */
  private withTextconvInputs(pair: DiffFilePair, entry: DiffEntry): DiffFilePair {
    const worktree = this.worktreeIfAny;
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

  /**
   * diff.c's textconv_object, as `git show --textconv <rev>:<path>` runs it: the output of
   * the path's `diff.<driver>.textconv` over the blob as checkout writes it, or undefined
   * when no textconv applies (not a regular file, no driver, no command or no runner
   * installed, `textconv: false`). The attributes are the worktree's alone (git show reads
   * no index). With the blob's `id`, the driver's textconv cache applies
   * (`diff.<driver>.cachetextconv`). `worktreeFile`: `read` gives a file as it lies in the
   * worktree (blame's working-tree file, `--contents <file>`), converted as it is, never
   * smudged nor cached (git's prepare_temp_file reuses the file; its object id is unknown).
   */
  async textconvBlob(
    path: string,
    mode: number,
    read: () => Promise<Uint8Array>,
    id?: string,
    options: { worktreeFile?: boolean } = {},
  ): Promise<Uint8Array | undefined> {
    if ((mode & S_IFMT) !== 0o100000) return undefined;
    const runner =
      (this.textOptions.textconv ?? true) ? textconvRunnerOf(this.workingCopy) : undefined;
    const filter = this.worktreeIfAny?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            context?: { direction: "checkin"; index?: AttributesIndex },
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    if (!runner || !filter?.attributes) return undefined;
    const attrs = await filter.attributes(path, ["diff"], WITHOUT_INDEX_ATTRIBUTES);
    const driver = diffDriverOf(attrs?.get("diff"), (key) => this.config.value(key));
    const command = driver?.textconvCommand;
    if (!driver || command === undefined) return undefined;
    return this.runTextconv(
      runner,
      {
        driver: driver.name ?? "",
        command,
        path,
        content: options.worktreeFile ? await read() : await this.smudged(path, mode, read),
        cache: driver.cacheTextconv ?? false,
      },
      options.worktreeFile ? undefined : id,
    );
  }

  /** The textconv caches of this command (git's per-process caches) */
  private textconvCaches = new TextconvCaches(() => this.notesContext());

  /** diff.c's fill_textconv: the runner's output, through the driver's notes cache */
  private runTextconv(
    runner: TextconvRunner,
    request: TextconvRequest,
    id: string | undefined,
  ): Promise<Uint8Array> {
    return this.textconvCaches.run(runner, request, id);
  }

  /** A blob's content as checkout writes it to the worktree (the worktree's smudge filter) */
  private async smudged(
    path: string,
    mode: number,
    read: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    const content = await read();
    return collectChunks(
      await smudgeContent(this.worktreeIfAny?.contentFilter, path, content, mode),
    );
  }

  /** git 2.5x's names from contents (see {@link DiffTextOptions.namesFromContents}) */
  private get namesFromContents(): boolean {
    return this.textOptions.namesFromContents ?? true;
  }

  /** The pairs `--name-only` lists: with whitespace options or `-I`, those whose patch shows a change */
  private async shownNames(
    pairs: DiffFilePair[],
    unmerged: Set<DiffFilePair>,
    options: DiffOutputOptions,
  ): Promise<DiffFilePair[]> {
    const fromContents = this.namesFromContents && this.fromContents;
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
    if (this.newTree || this.indexAsTree) return "trees";
    if (this.cached) return "cached";
    if (!this.worktreeIfAny) return "trees";
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
    const worktree = this.worktreeIfAny;
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

  /**
   * The worktree, or none in a bare repository, whose working copy refuses it (asked
   * without touching it): a diff of trees reads the bare attributes there.
   */
  private get worktreeIfAny(): Worktree | undefined {
    return "worktree" in this.workingCopy ? this.worktreeAccess : undefined;
  }

  /** The output options: the setters', else the configuration's */
  private outputOptions(): DiffOutputOptions {
    const config = this.config;
    const get = (key: string) => config.value(key);
    const worktree = this.worktreeIfAny;
    const filter = worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            context?: { direction: "checkin"; index?: AttributesIndex },
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    // a diff of two trees reads no index (builtin/diff.c's builtin_diff_tree, `git log -p`,
    // `git show`): the in-tree attributes come from the worktree alone, never the index's
    const context = this.newTree !== undefined ? WITHOUT_INDEX_ATTRIBUTES : undefined;
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
        textconv: (content, path, id) =>
          this.runTextconv(runner, { driver: name, command, path, content, cache }, id),
      };
    };
    const driver = filter?.attributes
      ? (path: string) => {
          let found = drivers.get(path);
          if (!found) {
            found = (async () => {
              const attrs = await filter.attributes?.(path, ["diff"], context);
              return withTextconv(
                diffDriverOf(attrs?.get("diff"), get, this.textOptions.driverCompatibility),
              );
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
      diffFilter: _diffFilter,
      relative: _relative,
      rotateTo: _rotateTo,
      skipTo: _skipTo,
      ignoreMatchingLines: _ignoreMatchingLines,
      quietDetectsRenames: _quietDetectsRenames,
      exitCodeFromContents: _exitCodeFromContents,
      pickaxeString: _pickaxeString,
      pickaxeGrep: _pickaxeGrep,
      findObjects: _findObjects,
      pickaxeRegex: _pickaxeRegex,
      pickaxeAll: _pickaxeAll,
      pickaxeIgnoreCase: _pickaxeIgnoreCase,
      color: _color,
      colorMoved: _colorMoved,
      colorMovedWs: _colorMovedWs,
      wsErrorHighlight: _wsErrorHighlight,
      colorCompatibility: _colorCompatibility,
      driverCompatibility: _driverCompatibility,
      findRenames: _findRenames,
      findCopies: _findCopies,
      findCopiesHarder: _findCopiesHarder,
      breakRewrites: _breakRewrites,
      dirstat: _dirstat,
      anchored,
      ...text
    } = this.textOptions;
    const colorSettings = this.colorSettings;
    // git_default_core_config: a core.whitespace git cannot parse dies in every diff
    const whitespaceRule = this.whitespaceRuleOf(filter, context);
    const colors = colorSettings?.colors
      ? { colors: colorSettings.colors, wsHighlight: colorSettings.wsErrorHighlight }
      : {};
    const ignoreRegex = this.ignoreRegex();
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
      algorithm:
        anchored && anchored.length > 0
          ? "patience"
          : (text.algorithm ?? algorithmValue(get("diff.algorithm")) ?? "myers"),
      ...(anchored && anchored.length > 0
        ? { anchors: anchored.map((a) => encodeGitPath(a)) }
        : {}),
      indentHeuristic: text.indentHeuristic ?? boolValue(get("diff.indentHeuristic")) ?? true,
      ...(driver ? { driver } : {}),
      ...(ignoreRegex.length > 0 ? { ignoreRegex } : {}),
      ...colors,
      ...(get("diff.wordRegex") !== undefined
        ? { defaultWordRegex: get("diff.wordRegex") as string }
        : {}),
      whitespaceRule,
    };
  }

  /** `ll_merge_marker_size`: each path's `conflict-marker-size` attribute */
  private conflictMarkerSizeOf(): (path: string) => Promise<number> {
    const filter = this.worktreeIfAny?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            context?: { direction: "checkin"; index?: AttributesIndex },
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    const context = this.newTree !== undefined ? WITHOUT_INDEX_ATTRIBUTES : undefined;
    return async (path: string) => {
      const attrs = await filter?.attributes?.(path, ["conflict-marker-size"], context);
      return conflictMarkerSizeOf(attrs?.get("conflict-marker-size") ?? undefined, (m) =>
        this.configWarnings.push(`warning: ${m}`),
      );
    };
  }

  /**
   * ws.c's `whitespace_rule`: the `whitespace` attribute of a path over `core.whitespace`
   * (git 2.43 knows no `incomplete-line` rule)
   */
  private whitespaceRuleOf(
    filter:
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            context?: { direction: "checkin"; index?: AttributesIndex },
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined,
    context: { direction: "checkin"; index: AttributesIndex } | undefined,
  ): (path: string) => Promise<number> {
    const legacy = this.textOptions.colorCompatibility === "2.43";
    const mask = legacy ? ~WS_INCOMPLETE_LINE : ~0;
    const parse = (value: string) => {
      try {
        return parseWhitespaceRule(
          value,
          undefined,
          legacy ? { compatibility: "2.43" } : undefined,
        );
      } catch (e) {
        throw whitespaceRuleError((e as Error).message);
      }
    };
    const core = this.config.value("core.whitespace");
    const configRule = core === undefined ? WS_DEFAULT_RULE : parse(core);
    const rules = new Map<string, Promise<number>>();
    return (path: string) => {
      let found = rules.get(path);
      if (!found) {
        found = (async () => {
          const attrs = await filter?.attributes?.(path, ["whitespace"], context);
          const attr = attrs?.get("whitespace");
          if (typeof attr === "string") return parse(attr) & mask;
          return whitespaceRuleOf(attr ?? undefined, configRule) & mask;
        })();
        rules.set(path, found);
      }
      return found;
    };
  }

  /** `-I<regex>` compiled as git's `regcomp(REG_EXTENDED | REG_NEWLINE)` */
  private ignoreRegex(): PosixRegex[] {
    return (this.textOptions.ignoreMatchingLines ?? []).map((pattern) => {
      try {
        return compilePosixRegex(pattern, { extended: true, newline: true });
      } catch {
        throw new InvalidArgumentError(
          "ignoreMatchingLines",
          pattern,
          `error: invalid regex given to -I: '${pattern}'`,
        ).withExitCode(129);
      }
    });
  }

  /**
   * git's `diff_from_contents`: whitespace options and `-I` (and, in git 2.5x, an exit status
   * asked for) make a pair count as a change only when its output shows one
   */
  private get fromContents(): boolean {
    const o = this.textOptions;
    // diff_setup_done (git 2.5x): porcelain diff allows external diffs, so an exit status
    // asked for (`--exit-code`, `--quiet`) always looks at the contents
    if ((this.exitWithStatus || this.quiet) && (o.exitCodeFromContents ?? true)) return true;
    return !!(
      o.ignoreWhitespace ||
      o.ignoreWhitespaceChange ||
      o.ignoreWhitespaceAtEol ||
      o.ignoreCrAtEol ||
      (o.ignoreMatchingLines?.length ?? 0) > 0
    );
  }

  /**
   * The queue diffcore_std leaves of the collected entries: in `-O` order, swapped by `-R`,
   * rotated (`--rotate-to`, `--skip-to`), filtered (`--diff-filter`)
   */
  private async selected(entries: DiffEntry[]): Promise<DiffEntry[]> {
    const ordered = await this.ordered(await this.picked(entries));
    let out = this.textOptions.reverse ? ordered.map(reverseEntry) : ordered;
    const { rotateTo, skipTo } = this.textOptions;
    // diff_opt_rotate_to: the last of the two given wins
    if (skipTo !== undefined) out = rotateEntries(out, skipTo, true, this.rotateStrict);
    else if (rotateTo !== undefined) out = rotateEntries(out, rotateTo, false, this.rotateStrict);
    const filter = this.textOptions.diffFilter;
    return applyDiffFilter(out, filter !== undefined ? parseDiffFilter(filter) : undefined);
  }

  /**
   * diffcore_std's prefetch condition: any pickaxe kind (`DIFF_PICKAXE_KINDS_MASK`,
   * `--find-object` included) fetches a partial clone's absent blobs of the queue in one
   * batch before rename detection
   */
  private get pickaxeReads(): boolean {
    return hasPickaxe(this.textOptions);
  }

  /** diffcore_pickaxe over the queue (after rename detection, before `-O` and the filter) */
  private async picked(entries: DiffEntry[]): Promise<DiffEntry[]> {
    const pickaxe = this.pickaxe;
    if (!pickaxe) return entries;
    const options = this.outputOptions();
    return pickaxe.filter(
      entries,
      (e) => (e.unmerged ? undefined : this.withTextconvInputs(diffEntryToPair(e, this.blobs), e)),
      options,
    );
  }

  /**
   * The pickaxe of the options (checked, compiled, `--find-object`'s revisions resolved),
   * before anything else is read
   */
  private async preparePickaxe(): Promise<void> {
    const o = this.textOptions;
    if (this.pickaxe || !hasPickaxe(o)) return;
    checkPickaxeOptions(o);
    let objects: Set<string> | undefined;
    if (o.findObjects && o.findObjects.length > 0) {
      objects = new Set();
      for (const name of o.findObjects) {
        const id = this.isFullObjectId(name)
          ? name.toLowerCase()
          : await this.revisionResolver()
              .resolve(name)
              .catch(() => undefined);
        if (id === undefined) {
          throw new InvalidArgumentError(
            "findObjects",
            name,
            `error: unable to resolve '${name}'`,
          ).withExitCode(129);
        }
        objects.add(id);
      }
    }
    this.pickaxe = DiffPickaxe.compile({
      ...(o.pickaxeString !== undefined ? { string: o.pickaxeString } : {}),
      ...(o.pickaxeGrep !== undefined ? { grep: o.pickaxeGrep } : {}),
      ...(objects ? { objects } : {}),
      regex: o.pickaxeRegex ?? false,
      all: o.pickaxeAll ?? false,
      ignoreCase: o.pickaxeIgnoreCase ?? false,
    });
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
    prefetch = false,
    diffcore = true,
  ): Promise<{ entries: DiffEntry[]; combined: CombinedEntry[] }> {
    // option parsing fails before anything is read
    const core = diffcore
      ? this.diffcoreSettings(renames)
      : { detect: false as const, harder: false };
    if (this.textOptions.diffFilter !== undefined) parseDiffFilter(this.textOptions.diffFilter);
    this.ignoreRegex();
    await this.preparePickaxe();
    await this.resolveRevisions();
    // repo_read_index: in a sparse checkout, a skip-worktree entry whose file is present is
    // read as in the checkout (in memory: diff writes no index)
    await this.clearPresentSkipWorktree();
    // a bare repository's working copy refuses its worktree (and index): asked without
    // touching them
    const bare = !("worktree" in this.workingCopy);
    const worktree = this.worktreeIfAny;
    // `:(attr:...)`: the attributes of the index's paths (match_pathspec_attrs), the trees'
    // read once their sides are known
    // without a worktree (a bare repository's diff of trees): the bare attributes, as log
    // reads them
    const attributes = !this.pathspecItems
      ? undefined
      : worktree
        ? PathspecAttributes.forWorktree(this.pathspecItems, worktree)
        : PathspecAttributes.forResolver(
            this.pathspecItems,
            bareAttributesResolver({
              workingCopy: this.workingCopy,
              trees: this.trees,
              blobs: this.blobs,
              revisions: () => this.revisionResolver(),
            }),
          );
    if (attributes && !bare) {
      const paths: string[] = [];
      for await (const entry of this.staging.entries()) paths.push(entry.path);
      await attributes.load(paths);
    }
    let oldSide: Map<string, Side>;
    let newSide: Map<string, Side>;
    const unmerged = new Map<string, DiffEntry[]>();
    const combined: CombinedEntry[] = [];
    if (this.newTree) {
      if ((this.pickaxe && !this.pickaxe.readsContent) || this.treeWalk === "show-trees") {
        this.treeSides = new Map();
      }
      [oldSide, newSide] = await this.treePairSides(
        this.oldTree ?? "HEAD",
        this.oldTree === undefined,
        this.newTree,
      );
    } else if (this.cached) {
      oldSide = await this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined);
      const index = await this.indexSide();
      newSide = index.sides;
      for (const path of index.unmerged.keys()) {
        unmerged.set(path, []);
        // diff_unmerge's raw line: the tree's side, nothing for the index
        const side = oldSide.get(path);
        if (side) this.unmergedRaw.set(path, { oldMode: side.mode, oldId: side.id });
      }
    } else if (worktree) {
      const run = async () => {
        if (this.oldTree) {
          // diff-index: a conflicted path is its worktree file, compared with the tree
          const old = await this.treeSide(this.oldTree);
          const wt = await this.worktreeSide(worktree, true);
          return [old, wt.sides] as const;
        }
        // the index side of the entries whose files differ (or are gone), and their files
        const indexSides = new Map<string, Side>();
        const wt = await this.worktreeSide(worktree, false, indexSides);
        for (const [path, stages] of wt.unmerged) {
          if (!this.matches(path)) continue;
          const ours = stages.get(2);
          const theirs = stages.get(3);
          if (patch && this.combineMerges && ours && theirs) {
            combined.push({ path, ours, theirs });
            continue;
          }
          unmerged.set(path, ours ? await this.againstStage(ours, wt.compare) : []);
          if (this.plumbingWorktree) {
            // run_diff_files: the unmerged line gives the worktree file's mode
            const lowest = ours ?? stages.get(1) ?? stages.get(3);
            const file = lowest ? await wt.compare(lowest) : undefined;
            if (file) this.unmergedRaw.set(path, { newMode: file.mode });
          }
        }
        return [indexSides, wt.sides] as const;
      };
      [oldSide, newSide] = worktree.batch ? await worktree.batch(run) : await run();
    } else {
      // no worktree: HEAD against HEAD (the old tree against HEAD)
      oldSide = await this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined);
      newSide = await this.treeSide("HEAD", true);
    }
    // diff_change / diff_addremove: a submodule whose changes are ignored is left out (the
    // settings read only when a submodule changed: `git log -p` diffs once per commit)
    await attributes?.load([...oldSide.keys(), ...newSide.keys(), ...unmerged.keys()]);
    const paired = this.pairUp(oldSide, newSide, unmerged);
    const ignoreOf = paired.some((e) => e.oldMode === GITLINK || e.newMode === GITLINK)
      ? await this.submoduleIgnoreOf()
      : () => undefined;
    const entries = paired.filter((e) => {
      if (e.unmerged) return true;
      const oldLink = e.oldMode === GITLINK;
      const newLink = e.newMode === GITLINK;
      const gitlinkOnly =
        e.changeType === ChangeType.ADD
          ? newLink
          : e.changeType === ChangeType.DELETE
            ? oldLink
            : oldLink && newLink;
      return !gitlinkOnly || ignoreOf((e.newPath ?? e.oldPath) as string) !== "all";
    });
    // diffcore_std: an output that reads the blobs fetches a partial clone's absent ones in
    // one batch first (diff_queued_diff_prefetch), before rename detection
    if (prefetch) await this.blobs.prefetch?.(prefetchIds(entries));
    if (core.breaks || core.detect) {
      const oldFiles = async (): Promise<Map<string, Side>> => {
        if (this.newTree || this.cached || this.oldTree || !worktree) {
          return this.newTree
            ? this.treeSide(this.oldTree ?? "HEAD", this.oldTree === undefined)
            : oldSide;
        }
        // diff-files: the index's entries
        const out = new Map<string, Side>();
        for await (const entry of this.staging.entries()) {
          if (entry.stage === 0 && !entry.intentToAdd) {
            out.set(entry.path, { mode: entry.mode, id: entry.objectId });
          }
        }
        return out;
      };
      await this.diffcore(entries, core, oldFiles);
    }
    return { entries: this.withTreeEntries(entries, oldSide, newSide), combined };
  }

  /**
   * `--find-object`'s tree_in_recursive: the changed subtrees of a diff of two trees among
   * the blob pairs, each before what lies below it (the tree walk's order: `a/` sorts after
   * `a.txt`); they take no part in rename detection
   */
  private withTreeEntries(
    entries: DiffEntry[],
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
  ): DiffEntry[] {
    const sides = this.treeSides;
    if (!sides) return entries;
    this.treeSides = undefined;
    const trees = this.pairUp(
      sides.get(oldSide) ?? new Map(),
      sides.get(newSide) ?? new Map(),
      new Map(),
      this.treeWalk === "show-trees",
    );
    if (trees.length === 0) return entries;
    const keyOf = (e: DiffEntry) => e.newPath ?? e.oldPath ?? "";
    const treeKey = (e: DiffEntry) => `${e.newPath ?? e.oldPath ?? ""}/`;
    const out: DiffEntry[] = [];
    let t = 0;
    for (const e of entries) {
      const key = keyOf(e);
      while (t < trees.length && compareBytes(treeKey(trees[t] as DiffEntry), key) < 0) {
        out.push(trees[t++] as DiffEntry);
      }
      out.push(e);
    }
    while (t < trees.length) out.push(trees[t++] as DiffEntry);
    return out;
  }

  /**
   * builtin/diff.c's revision handling: `A..B` is `A B`, `A...B` the merge base of A and B
   * against B (symdiff_prepare: the first base, with git's warning when there are several),
   * `--merge-base` the merge base of the two sides (diff_get_merge_base); an empty side of a
   * range is HEAD.
   */
  private async resolveRevisions(): Promise<void> {
    if (this.sidesResolved) return;
    this.sidesResolved = true;
    const old = this.oldTree;
    const range =
      old !== undefined && this.newTree === undefined && !old.includes(":")
        ? /^(.*?)(\.\.\.?)(.*)$/s.exec(old)
        : null;
    if (range) {
      if (this.mergeBase) throw new GitApiError("fatal: --merge-base does not work with ranges");
      const left = range[1] || "HEAD";
      const right = range[3] || "HEAD";
      if (range[2] === "..") {
        this.oldTree = left;
        this.newTree = right;
        return;
      }
      const errors: string[] = [];
      const a = await this.commitOf(left, errors, old);
      const b = await this.commitOf(right, errors, old);
      if (a === undefined || b === undefined) {
        throw new GitApiError(
          [...errors, `fatal: Invalid symmetric difference expression ${old}`].join("\n"),
        );
      }
      const bases = await revisionMergeBases(this.commits, a, b);
      const base = bases[0];
      if (base === undefined) throw new GitApiError(`fatal: ${left}...${right}: no merge base`);
      if (bases.length > 1) {
        this.configWarnings.push(
          `warning: ${left}...${right}: multiple merge bases, using ${base}`,
        );
      }
      this.oldTree = base;
      this.newTree = b;
      return;
    }
    if (!this.mergeBase) return;
    // `git diff --cached --merge-base`: HEAD, the default of --cached
    if (old === undefined && this.cached) this.oldTree = "HEAD";
    if (this.oldTree === undefined) {
      throw new InvalidArgumentError(
        "mergeBase",
        true,
        "error: invalid option: --merge-base",
      ).withExitCode(129);
    }
    const errors: string[] = [];
    const a = await this.commitOf(this.oldTree, errors);
    let b: ObjectId | undefined;
    if (this.newTree !== undefined) b = await this.commitOf(this.newTree, errors);
    else {
      let head: ObjectId;
      try {
        head = await this.resolveRevision("HEAD");
      } catch {
        throw new GitApiError("fatal: unable to get HEAD");
      }
      b = await this.commitOf(head, errors);
    }
    const bases =
      a !== undefined && b !== undefined ? await revisionMergeBases(this.commits, a, b) : [];
    if (bases.length === 0) {
      throw new GitApiError([...errors, "fatal: no merge base found"].join("\n"));
    }
    if (bases.length > 1) throw new GitApiError("fatal: multiple merge bases found");
    this.oldTree = bases[0];
  }

  /**
   * lookup_commit_reference of a revision: the commit it names (tags peeled); for another
   * object git's `error: object <id> is a <type>, not a commit` goes to `errors`. A name that
   * resolves to nothing throws git's `ambiguous argument` (of the whole `argument`).
   */
  private async commitOf(
    name: string,
    errors: string[],
    argument = name,
  ): Promise<ObjectId | undefined> {
    let id: ObjectId;
    try {
      id = await this.resolveRevision(name);
    } catch (e) {
      if (e instanceof RefNotFoundError || e instanceof NoHeadError) {
        // setup_revisions: an argument that names no revision (nor a path)
        throw new RefNotFoundError(
          argument,
          `fatal: ambiguous argument '${argument}': unknown revision or path not in the working tree.`,
        );
      }
      throw e;
    }
    const peeled = await this.revisionResolver().peelTags(id);
    if (peeled.type === "commit") return peeled.id;
    if (peeled.type !== undefined) {
      errors.push(`error: object ${peeled.id} is a ${peeled.type}, not a commit`);
    }
    return undefined;
  }

  /**
   * What the submodule at a path ignores (git's `set_diffopt_flags_from_submodule_config`
   * over `diff.ignoreSubmodules`): its `submodule.<name>.ignore` (the configuration, else
   * `.gitmodules`), else `diff.ignoreSubmodules`; undefined when neither is set.
   */
  private async submoduleIgnoreOf(): Promise<
    (path: string) => "none" | "untracked" | "dirty" | "all" | undefined
  > {
    const override = this.ignoreSubmodulesOverride;
    if (override !== undefined) return () => override;
    const fallback = submoduleIgnoreValue(this.config.value("diff.ignoreSubmodules"));
    const own = await this.submoduleIgnores();
    return (path) => own.get(path) ?? fallback;
  }

  /** `submodule.<name>.ignore` of each submodule `.gitmodules` names (the worktree's, else the index's). */
  private submoduleIgnores(): Promise<Map<string, "none" | "untracked" | "dirty" | "all">> {
    this.submoduleIgnoreMap ??= (async () => {
      const out = new Map<string, "none" | "untracked" | "dirty" | "all">();
      let text: string | undefined;
      try {
        const worktree = this.worktreeIfAny;
        const entry = worktree ? await worktree.getEntry(".gitmodules") : undefined;
        if (worktree && entry && !entry.isDirectory && entry.mode !== 0o120000) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of worktree.readContent(".gitmodules")) chunks.push(chunk);
          text = new TextDecoder().decode(concatChunks(chunks));
        } else {
          const staged = await this.staging.getEntry(".gitmodules");
          if (staged && staged.mode !== 0o120000) {
            const chunks: Uint8Array[] = [];
            for await (const chunk of (await this.blobs.load(staged.objectId)) ?? []) {
              chunks.push(chunk);
            }
            text = new TextDecoder().decode(concatChunks(chunks));
          }
        }
      } catch {
        text = undefined;
      }
      if (!text) return out;
      for (const submodule of parseGitmodules(text)) {
        const configured = this.config.value(`submodule.${submodule.name}.ignore`)?.trim();
        const value = configured !== undefined ? configured : submodule.ignore?.trim();
        if (submodule.path && isSubmoduleIgnoreMode(value)) out.set(submodule.path, value);
      }
      return out;
    })();
    return this.submoduleIgnoreMap;
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
    const statDirty = side.rawNull && this.plumbingWorktree;
    if (side.id === stage.objectId && side.mode === stage.mode && !side.dirty && !statDirty) {
      return [];
    }
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
        ...(side.dirt ? { newSubmoduleDirt: side.dirt } : {}),
        ...(side.rawNull ? { newIdNull: true } : {}),
      },
    ];
  }

  /** The `--relative=<path>` prefix paths are limited to and shown without */
  private get relativePrefix(): string | undefined {
    const relative = this.textOptions.relative;
    return typeof relative === "string" && relative !== "" ? relative : undefined;
  }

  private matches(path: string, tree = false): boolean {
    if (this.pathFilter && !path.startsWith(this.pathFilter)) return false;
    // diff_queue_addremove / diff_change / diff_unmerge: outside the prefix, nothing is queued
    const prefix = this.relativePrefix;
    if (prefix !== undefined && !path.startsWith(prefix)) return false;
    // tree_entry_interesting: a subtree shown (`-t`, without `-r`) is one the pathspec
    // matches or leads to
    const flags = tree ? DO_MATCH_DIRECTORY | DO_MATCH_LEADING_PATHSPEC : 0;
    return !this.pathspecItems || matchPathspec(this.pathspecItems, path, flags) > 0;
  }

  /**
   * The entries of both sides in path order; an unmerged path is listed as such, followed by
   * the entries `unmerged` holds for it
   */
  private pairUp(
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
    unmerged: Map<string, DiffEntry[]>,
    trees = false,
  ): DiffEntry[] {
    const paths = new Set<string>([...oldSide.keys(), ...newSide.keys(), ...unmerged.keys()]);
    // a subtree listed as an entry (`flat`) is keyed `<path>/`: it sorts as tree-diff.c
    // walks it and pairs with no blob of its name
    const sorted = [...paths]
      .filter((p) =>
        p.endsWith("/") ? this.matches(p.slice(0, -1), true) : this.matches(p, trees),
      )
      .sort(compareBytes);
    const entries: DiffEntry[] = [];
    for (const key of sorted) {
      const path = key.endsWith("/") ? key.slice(0, -1) : key;
      const extra = unmerged.get(key);
      if (extra) {
        const raw = this.unmergedRaw.get(path);
        entries.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          unmerged: true,
          ...(raw?.oldMode !== undefined ? { oldMode: raw.oldMode as FileModeValue } : {}),
          ...(raw?.oldId !== undefined ? { oldId: raw.oldId } : {}),
          ...(raw?.newMode !== undefined ? { newMode: raw.newMode as FileModeValue } : {}),
        });
        entries.push(...extra);
        continue;
      }
      const a = oldSide.get(key);
      const b = newSide.get(key);
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
          ...(b.dirt ? { newSubmoduleDirt: b.dirt } : {}),
          ...(b.unknownId ? { newIdUnknown: true } : {}),
          ...(b.rawNull ? { newIdNull: true } : {}),
        });
      } else if (
        a &&
        b &&
        (a.id !== b.id ||
          a.mode !== b.mode ||
          b.dirty ||
          b.unknownId ||
          (b.rawNull && this.plumbingWorktree))
      ) {
        // show_modified: a side of the null id differs from any (`M sub` even where the
        // submodule is back at the tree's commit)
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
          ...(b.dirt ? { newSubmoduleDirt: b.dirt } : {}),
          ...(b.unknownId ? { newIdUnknown: true } : {}),
          ...(b.rawNull ? { newIdNull: true } : {}),
        });
      }
    }
    return entries;
  }

  /**
   * diffcore's settings of a run: rename or copy detection (`renames` as configured or set,
   * then `-M`/`-C`), its threshold, `--find-copies-harder`, `-B`; option errors are thrown here
   */
  private diffcoreSettings(renames: boolean | "copies"): DiffcoreSettings {
    const o = this.textOptions;
    let detect: DiffcoreSettings["detect"] =
      renames === "copies" ? "copies" : renames ? "renames" : false;
    let score: number | undefined;
    let harder = o.findCopiesHarder === true;
    if (o.findRenames !== undefined) {
      if (o.findRenames === false) detect = false;
      else {
        detect = "renames";
        score = renameScoreOption(o.findRenames, "find-renames");
      }
    }
    if (o.findCopies !== undefined && o.findCopies !== false) {
      // diff_opt_find_copies: a second -C (copies already on, from diff.renames) finds harder
      if (detect === "copies" && o.findRenames === undefined) harder = true;
      detect = "copies";
      score = renameScoreOption(o.findCopies, "find-copies") ?? score;
    }
    const breaks =
      o.breakRewrites !== undefined && o.breakRewrites !== false
        ? parseBreakRewrites(o.breakRewrites)
        : undefined;
    return {
      detect,
      harder: detect === "copies" && harder,
      ...(score !== undefined ? { score } : {}),
      ...(breaks ? { breaks } : {}),
    };
  }

  /**
   * diffcore_std's pair stages: `diffcore_break` (`-B`), `diffcore_rename` (renames, copies,
   * `--find-copies-harder`), `diffcore_merge_broken`, then `diff_resolve_rename_copy`. The
   * entries are changed in place, in git's queue order.
   */
  private async diffcore(
    entries: DiffEntry[],
    core: DiffcoreSettings,
    oldFiles: () => Promise<Map<string, Side>>,
  ): Promise<void> {
    const readBlob = async (id: ObjectId) => collectChunks((await this.blobs.load(id)) ?? []);
    const countLastSpan = this.textOptions.renameCountLastSpan;
    /** git's diff_filepair extras: a broken half's score, a renamed creation's source */
    const broken = new Map<DiffEntry, number>();
    const source = new Map<DiffEntry, { path: string; breakScore?: number }>();
    const uses = new Map<string, number>();

    if (core.breaks) {
      const { breakScore, mergeScore } = core.breaks;
      const out: DiffEntry[] = [];
      for (const e of entries) {
        const blobMode = (m: number | undefined) =>
          m !== undefined && m !== 0 && m !== GITLINK && (m & 0o170000) !== 0o040000;
        if (
          e.changeType !== ChangeType.MODIFY ||
          e.unmerged ||
          !blobMode(e.oldMode) ||
          !blobMode(e.newMode) ||
          e.oldId === undefined
        ) {
          out.push(e);
          continue;
        }
        const oldContent = () => (e.readOld ? e.readOld() : readBlob(e.oldId as ObjectId));
        const newContent = () => (e.readNew ? e.readNew() : readBlob(e.newId as ObjectId));
        const sideOf = async (mode: number, read: () => Promise<Uint8Array>) => {
          const content = await read();
          return {
            mode,
            size: content.length,
            spans: async () => spanCounts(content, { countLastSpan }),
          };
        };
        const same = !e.readOld && !e.readNew && !e.newIdUnknown && e.oldId === e.newId;
        const verdict = await shouldBreak(
          await sideOf(e.oldMode as number, oldContent),
          await sideOf(e.newMode as number, newContent),
          breakScore,
          same,
        );
        if (!verdict.broken) {
          out.push(e);
          continue;
        }
        const score = verdict.mergeScore < mergeScore ? 0 : verdict.mergeScore;
        const del: DiffEntry = {
          changeType: ChangeType.DELETE,
          oldPath: e.oldPath,
          oldId: e.oldId,
          oldMode: e.oldMode,
          ...(e.readOld ? { readOld: e.readOld } : {}),
        };
        const add: DiffEntry = {
          changeType: ChangeType.ADD,
          newPath: e.newPath,
          newId: e.newId,
          newMode: e.newMode,
          ...(e.readNew ? { readNew: e.readNew } : {}),
        };
        broken.set(del, score);
        broken.set(add, score);
        out.push(del, add);
      }
      entries.splice(0, entries.length, ...out);
    }

    if (core.detect) await this.detectRenames(entries, core, oldFiles, broken, source, uses);

    if (core.breaks) {
      // diffcore_merge_broken: halves that both survived are one modification again
      const onePath = (e: DiffEntry) =>
        source.get(e)?.path ?? (e.changeType === ChangeType.ADD ? e.newPath : e.oldPath);
      const twoPath = (e: DiffEntry) =>
        e.changeType === ChangeType.DELETE ? e.oldPath : e.newPath;
      const samePath = (e: DiffEntry) => broken.has(e) && onePath(e) === twoPath(e);
      const out: DiffEntry[] = [];
      const merged = new Set<DiffEntry>();
      for (let i = 0; i < entries.length; i++) {
        const p = entries[i] as DiffEntry;
        if (merged.has(p)) continue;
        if (samePath(p)) {
          let peer: DiffEntry | undefined;
          for (let j = i + 1; j < entries.length; j++) {
            const pp = entries[j] as DiffEntry;
            if (!merged.has(pp) && samePath(pp) && onePath(p) === twoPath(pp)) {
              peer = pp;
              break;
            }
          }
          if (peer) {
            merged.add(peer);
            const d = p.changeType === ChangeType.DELETE ? p : peer;
            const c = d === p ? peer : p;
            const score = broken.get(p) ?? 0;
            out.push({
              changeType: ChangeType.MODIFY,
              oldPath: d.oldPath,
              newPath: c.newPath,
              oldId: d.oldId,
              newId: c.newId,
              oldMode: d.oldMode,
              newMode: c.newMode,
              ...(d.readOld ? { readOld: d.readOld } : {}),
              ...(c.readNew ? { readNew: c.readNew } : {}),
              ...(score ? { score: scorePercent(score) } : {}),
            });
            const from = d.oldPath ?? "";
            uses.set(from, (uses.get(from) ?? 0) + 1);
            continue;
          }
        }
        out.push(p);
      }
      entries.splice(0, entries.length, ...out);
    }

    // diff_resolve_rename_copy: in queue order, each renamed pair takes one use of its source
    for (const e of entries) {
      const from = source.get(e);
      if (!from) continue;
      if (from.path === e.newPath) {
        // a rename joined a broken pair again: a modification (a rewrite with its score)
        e.changeType = ChangeType.MODIFY;
        if (from.breakScore) e.score = scorePercent(from.breakScore);
        else delete e.score;
        continue;
      }
      const left = (uses.get(from.path) ?? 0) - 1;
      uses.set(from.path, left);
      e.changeType = left > 0 ? ChangeType.COPY : ChangeType.RENAME;
    }
  }

  /**
   * git's `diffcore_rename` over the queue: deleted paths (broken deletions too) as sources,
   * with copies the modified paths (and, harder, the unmodified ones) as sources that stay,
   * created paths as destinations. A destination paired becomes a rename (resolved into a
   * copy or a rename by {@link diffcore}); a deletion its rename takes is dropped.
   */
  private async detectRenames(
    entries: DiffEntry[],
    core: DiffcoreSettings,
    oldFiles: () => Promise<Map<string, Side>>,
    broken: Map<DiffEntry, number>,
    source: Map<DiffEntry, { path: string; breakScore?: number }>,
    uses: Map<string, number>,
  ): Promise<void> {
    const copies = core.detect === "copies";
    const sources = entries.filter(
      (e) =>
        (e.changeType === ChangeType.DELETE && !e.unmerged) ||
        (copies && e.changeType === ChangeType.MODIFY && !e.unmerged),
    );
    // a submodule of git's null id (diff-index of a moved one) matches no source exactly,
    // and gitlinks pair only exactly
    const destinations = entries.filter((e) => e.changeType === ChangeType.ADD && !e.newIdUnknown);
    // --find-copies-harder: every unchanged path of the old side is a source too
    const unmodified: DiffEntry[] = [];
    if (copies && core.harder && destinations.length > 0) {
      const listed = new Set(entries.map((e) => e.oldPath ?? e.newPath));
      for (const [path, side] of await oldFiles()) {
        if (listed.has(path) || !this.matches(path)) continue;
        unmodified.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          oldId: side.id,
          newId: side.id,
          oldMode: side.mode as FileModeValue,
          newMode: side.mode as FileModeValue,
        });
      }
      sources.push(...unmodified);
    }
    for (const e of sources) {
      const kept = e.changeType === ChangeType.MODIFY || (broken.has(e) && !broken.get(e));
      uses.set(e.oldPath ?? "", kept ? 1 : 0);
    }
    if (sources.length === 0 || destinations.length === 0) return;
    const byPath = new Map<string, DiffEntry>();
    for (const e of sources) byPath.set(`s:${e.oldPath}`, e);
    for (const e of destinations) byPath.set(`d:${e.newPath}`, e);
    const unmodifiedSet = new Set(unmodified);
    const limit =
      this.renameLimit ?? intValue(this.config.value("diff.renameLimit")) ?? DEFAULT_RENAME_LIMIT;
    let needed = 0;
    let degraded = false;
    const pairs = await detectRenames(
      sources.map((e) => {
        const kept = e.changeType === ChangeType.MODIFY || (broken.has(e) && !broken.get(e));
        return {
          path: e.oldPath ?? "",
          mode: e.oldMode ?? 0,
          id: e.oldId ?? "",
          ...(kept ? { kept: true } : {}),
          ...(unmodifiedSet.has(e) ? { unmodified: true } : {}),
        };
      }),
      destinations.map((e) => ({ path: e.newPath ?? "", mode: e.newMode ?? 0, id: e.newId ?? "" })),
      {
        renameLimit: limit,
        countLastSpan: this.textOptions.renameCountLastSpan,
        copies,
        breakMode: sources.some((e) => broken.has(e)),
        ...(core.score !== undefined ? { minimumScore: core.score } : {}),
        onRenameLimit: (n) => {
          needed = n;
        },
        onDegraded: () => {
          degraded = true;
        },
        onUses: (counted) => {
          for (const [path, n] of counted) uses.set(path, n);
        },
        // a partial clone's absent blobs, fetched in one batch (a worktree file is no blob)
        prefetch: async (wanted) => {
          const ids: ObjectId[] = [];
          for (const { candidate: c, side } of wanted) {
            const e = byPath.get(`${side === "source" ? "s" : "d"}:${c.path}`);
            if (side === "destination" && e?.readNew) continue;
            if (c.mode !== GITLINK && c.id) ids.push(c.id);
          }
          await this.blobs.prefetch?.(ids);
        },
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
          return collectChunks((await this.blobs.load(c.id)) ?? []);
        },
      },
    );
    // diff_warn_rename_limit
    if (degraded) {
      this.configWarnings.push(
        "warning: only found copies from modified paths due to too many files.",
      );
    } else if (needed) {
      this.configWarnings.push(
        "warning: exhaustive rename detection was skipped due to too many files.",
      );
    }
    if (needed) {
      this.configWarnings.push(
        `warning: you may want to set your diff.renameLimit variable to at least ${needed} and retry the command.`,
      );
    }
    const renamedHalves = new Set<string>();
    for (const pair of pairs) {
      const src = byPath.get(`s:${pair.from}`);
      const dst = byPath.get(`d:${pair.to}`);
      if (!src || !dst) continue;
      const breakScore = broken.get(src);
      source.set(dst, {
        path: pair.from,
        ...(breakScore !== undefined ? { breakScore } : {}),
      });
      if (broken.has(dst)) renamedHalves.add(dst.newPath ?? "");
      dst.changeType = ChangeType.RENAME;
      dst.oldPath = src.oldPath;
      dst.oldId = src.oldId;
      dst.oldMode = src.oldMode;
      if (src.readOld) dst.readOld = src.readOld;
      dst.score = scorePercent(pair.from === pair.to ? (breakScore ?? 0) : pair.score);
    }
    // the deletions a rename or copy takes away: a broken one when its own creation was
    // paired, any other once used
    const kept = entries.filter((e) => {
      if (e.changeType !== ChangeType.DELETE || e.unmerged) return true;
      if (broken.has(e)) return !renamedHalves.has(e.oldPath ?? "");
      return !(uses.get(e.oldPath ?? "") ?? 0);
    });
    entries.splice(0, entries.length, ...kept);
  }

  /**
   * The blobs of a commit's (or tree's) tree, by path. `implicitHead`: HEAD taken by default
   * (`--cached`, no worktree), an unborn HEAD then being the empty tree as git takes it;
   * anything else that does not resolve throws (git's "bad revision", exit 128).
   */
  private async treeSide(refOrId: string, implicitHead = false): Promise<Map<string, Side>> {
    const out = new Map<string, Side>();
    // the empty tree (a root commit's parent side), which a store need not hold
    if (refOrId === this.objectFormat.emptyTreeId) return out;
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
      if (ref === this.objectFormat.emptyTreeId) return undefined;
      // a tree's full id (as `git log -p` passes its commits' trees): read at once, its
      // entries kept for the comparison
      const trees = this.trees;
      if (this.isFullObjectId(ref)) {
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
    const ea =
      a === undefined || a === this.objectFormat.emptyTreeId ? [] : await this.treeEntries(a);
    const eb =
      b === undefined || b === this.objectFormat.emptyTreeId ? [] : await this.treeEntries(b);
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
        // tree-diff.c compares the modes its walk reads: canonical, as the tree store reads
        // them (100664 is 100644)
        if (xe.id === ye.id && xe.mode === ye.mode) continue;
        const path = prefix ? `${prefix}/${xe.name}` : xe.name;
        if (isTreeMode(xe.mode) && isTreeMode(ye.mode) && this.treeWalk === "flat") {
          oldSide.set(`${path}/`, { mode: xe.mode, id: xe.id });
          newSide.set(`${path}/`, { mode: ye.mode, id: ye.id });
          continue;
        }
        if (isTreeMode(xe.mode) && isTreeMode(ye.mode)) {
          this.addTreeSide(path, xe.mode, xe.id, oldSide);
          this.addTreeSide(path, ye.mode, ye.id, newSide);
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
      id === undefined || id === this.objectFormat.emptyTreeId
        ? NO_BYTES
        : ((await trees.raw?.(id)) ?? NO_BYTES);
    const x = new TreeEntryCursor(await read(a), this.objectFormat.rawLength);
    const y = new TreeEntryCursor(await read(b), this.objectFormat.rawLength);
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
          if (x.isTree && y.isTree && this.treeWalk === "flat") {
            oldSide.set(`${path}/`, { mode: x.mode, id: x.id() });
            newSide.set(`${path}/`, { mode: y.mode, id: y.id() });
          } else if (x.isTree && y.isTree) {
            this.addTreeSide(path, x.mode, x.id(), oldSide);
            this.addTreeSide(path, y.mode, y.id(), newSide);
            await this.diffRawTrees(x.id(), y.id(), path, oldSide, newSide);
          } else {
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
    if (c.isTree && this.treeWalk === "flat") {
      side.set(`${path}/`, { mode: c.mode, id: c.id() });
    } else if (c.isTree) {
      this.addTreeSide(path, c.mode, c.id(), side);
      await this.collectTreeEntries(c.id(), path, side);
    } else side.set(path, { mode: c.mode, id: c.id() });
  }

  /** A tree entry on one side: a blob as itself, a subtree as its blobs */
  private async addSide(e: TreeEntry, path: string, side: Map<string, Side>): Promise<void> {
    if (isTreeMode(e.mode) && this.treeWalk === "flat") {
      side.set(`${path}/`, { mode: e.mode, id: e.id });
    } else if (isTreeMode(e.mode)) {
      this.addTreeSide(path, e.mode, e.id, side);
      await this.collectTreeEntries(e.id, path, side);
    } else side.set(path, { mode: e.mode, id: e.id });
  }

  /** A subtree on one side, kept for `--find-object` (see {@link withTreeEntries}) */
  private addTreeSide(path: string, mode: number, id: ObjectId, side: Map<string, Side>): void {
    const sides = this.treeSides;
    if (!sides) return;
    let trees = sides.get(side);
    if (!trees) {
      trees = new Map();
      sides.set(side, trees);
    }
    trees.set(path, { mode, id });
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
      if (entry.intentToAdd && !this.intentToAddVisible) continue;
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
    changedOnly?: Map<string, Side>,
  ): Promise<{
    sides: Map<string, Side>;
    unmerged: Map<string, Map<number, StageEntry>>;
    compare: WorktreeCompare;
  }> {
    const sides = new Map<string, Side>();
    const unmerged = new Map<string, Map<number, StageEntry>>();
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    const ignoreOf = await this.submoduleIgnoreOf();
    const compareWith = async (
      entry: StageEntry,
      current?: WorktreeEntry | null,
    ): Promise<Side | undefined> => {
      const indexSide: Side = { mode: entry.mode, id: entry.objectId };
      if (entry.skipWorktree || entry.assumeValid) return indexSide;
      const ignore = entry.mode === GITLINK ? ignoreOf(entry.path) : undefined;
      if (entry.mode === GITLINK && ignore === "all") return indexSide;
      const result = await compareWithWorktree(worktree, entry, { trust, indexTime }, current);
      if (result.kind === "deleted") return undefined;
      const mode = result.worktreeMode ?? entry.mode;
      if (mode === GITLINK) {
        const id = result.hashedId ?? entry.objectId;
        // a populated submodule with changes of its own: "-dirty" (untracked files count
        // only with diff.ignoreSubmodules=none, as git's default ignores them)
        let dirty = false;
        const dirt: SubmoduleDirt = {};
        // match_stat_with_submodule: one at another commit only with dirty_submodules
        if (
          entry.mode === GITLINK &&
          ignore !== "dirty" &&
          (this.dirtyThisCall || id === entry.objectId) &&
          result.worktreeEntry?.isDirectory
        ) {
          const found = await readSubmoduleDirt(worktree, entry.path, ignore !== "none");
          if (found.modified) dirt.modified = true;
          if (ignore === "none" && found.untracked) dirt.untracked = true;
          dirty = !!dirt.modified || !!dirt.untracked;
        }
        // ie_match_stat of a gitlink: another commit checked out than the entry's
        const moved = entry.mode === GITLINK && mode === GITLINK && id !== entry.objectId;
        if (!dirty) {
          if (!result.kind) return indexSide;
          if (!moved) return { mode, id };
          // its id is no stored object's to git (oid_valid unset): the diffstat compares
          // the "Subproject commit" lines, which may hold no change
          const content = encoder.encode(`Subproject commit ${id}\n`);
          return { mode, id, unknownId: true, read: async () => content };
        }
        const unknown = moved ? { unknownId: true } : {};
        const content = encoder.encode(`Subproject commit ${id}-dirty\n`);
        return { mode, id, dirty, dirt, ...unknown, read: async () => content };
      }
      const path = entry.path;
      // plumbing's ie_match_stat: a stat that differs is a change, the file not hashed
      // (a racily clean entry's content is compared)
      const statDirty =
        this.plumbingWorktree &&
        !entry.intentToAdd &&
        !result.kind &&
        result.hashedId !== undefined &&
        !!result.worktreeEntry &&
        !basicStatMatches(entry, result.worktreeEntry, trust);
      if (!result.kind && !entry.intentToAdd && !statDirty) return indexSide;
      const id = result.hashedId ?? (await worktree.computeHash(path));
      // run_diff_files / run_diff_index: the worktree side is not hashed (its raw id is the
      // null id), porcelain included; only the porcelain's intent-to-add entry, shown as a
      // new file, gets its content's id
      const rawNull = this.plumbingWorktree || !entry.intentToAdd;
      if (!entry.intentToAdd && id === entry.objectId && mode === entry.mode && !statDirty) {
        return indexSide;
      }
      let content: Promise<Uint8Array> | undefined;
      const read = () => {
        content ??= readCleanContent(worktree, path);
        return content;
      };
      return { mode, id, read, ...(rawNull ? { rawNull: true } : {}) };
    };
    const compare: WorktreeCompare = (entry) => compareWith(entry);
    // the stat pass: the files of the stage-0 entries compared, stat'ed a chunk at a time
    const stated = (entry: StageEntry) =>
      entry.stage === 0 &&
      !entry.skipWorktree &&
      !entry.assumeValid &&
      entry.mode !== GITLINK &&
      this.matches(entry.path);
    for await (const { item: entry, current } of withWorktreeEntries(
      worktree,
      this.staging.entries(),
      stated,
    )) {
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
      const side = await compareWith(entry, current);
      if (changedOnly && (!entry.intentToAdd || this.intentToAddVisible)) {
        // diff-files: an entry its file still holds is no change on either side, left out
        // of both (the index side is the entry, as `indexSide` gives it)
        if (
          side &&
          side.id === entry.objectId &&
          side.mode === entry.mode &&
          !side.dirty &&
          !(side.rawNull && this.plumbingWorktree)
        ) {
          continue;
        }
        changedOnly.set(entry.path, { mode: entry.mode, id: entry.objectId });
      }
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
    if (this.isFullObjectId(refOrId)) {
      const tree = await this.revisionResolver()
        .peelToType(refOrId, "tree")
        .catch(() => undefined);
      if (tree !== undefined) return tree;
    }
    let id: ObjectId;
    try {
      id = await this.resolveRevision(refOrId);
    } catch (e) {
      if (this.isFullObjectId(refOrId) && (await this.isTree(refOrId))) return refOrId;
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
        this.addTreeSide(path, entry.mode, entry.id, entries);
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        // the mode as git's tree walk reads it (canon_mode), as the tree store reads it
        entries.set(path, { mode: entry.mode, id: entry.id });
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
