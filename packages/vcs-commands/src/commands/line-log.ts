/**
 * `git log -L`: line ranges of files followed back through history (git's line-log.c and
 * line-range.c).
 *
 * @example
 * ```ts
 * // git log -L 4,12:a.c -L :main:a.c
 * await git.log().addLineRange("4,12:a.c").addLineRange(":main:a.c").callText();
 * ```
 *
 * The ranges are parsed against the one commit the log starts from ({@link parseLineRanges}:
 * line numbers, `+N`/`-N` offsets, `/regex/` and `^/regex/` searches, `:funcname` found by
 * the path's diff driver). The walk then hands each commit, children before parents, to a
 * {@link LineLogWalk}: the commit is diffed with its parent at the tracked paths (renames
 * followed, the parent's path taking over), the ranges are mapped across that diff to the
 * parent, and the commit is shown when a change of the diff touches them. A merge whose diff
 * with one parent touches nothing passes its ranges to that parent alone and is not shown.
 * What a shown commit prints is its pairs with the ranges they touched: through the diff
 * pipeline cut to the ranges in git 2.5x ({@link LineLogWalk.queuedPairs}), line-log's own
 * diff in 2.43 ({@link LineLogWalk.hackyDiff}).
 *
 * @module
 */

import type { ObjectId } from "@statewalker/vcs-core";
import {
  compilePosixRegex,
  type FindFunction,
  OrderedMap,
  type PosixRegex,
  PosixRegexError,
  xdiffHunks,
} from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../errors/index.js";
import { ChangeType, type DiffEntry, type LineRange } from "../results/diff-entry.js";

/** The git version whose line-log is followed: 2.43's range arithmetic and diff, or 2.5x's */
export type LineLogCompatibility = "2.43" | "2.56";

/** A blob of a tracked file, as a pair side */
export interface LineLogSide {
  path: string;
  id: ObjectId;
  mode: number;
}

/** A file pair of a commit's diff (a diff_filepair) */
export interface LineLogPair {
  /** The parent's side; absent for a file the commit adds */
  one?: LineLogSide;
  two: LineLogSide;
  /** A rename's similarity, 0..100 */
  score?: number;
}

/** The hunks of a diff, by side (line-log.c's `struct diff_ranges`) */
interface DiffRanges {
  parent: LineRange[];
  target: LineRange[];
}

/** One tracked file of a commit (line-log.c's `struct line_log_data`) */
interface LineLogData {
  path: string;
  ranges: LineRange[];
  /** The pair that touched the ranges, and the hunks it touched them with */
  pair?: LineLogPair;
  diff?: DiffRanges;
}

const fatal = (message: string) => new GitApiError(`fatal: ${message}`).withExitCode(128);

// --- range sets ---------------------------------------------------------------------------

/** range_set_append (its assertion included: git 2.43 aborts on some overlapping ranges) */
function append(rs: LineRange[], start: number, end: number): void {
  const last = rs[rs.length - 1];
  if (start > end || (last && last.end > start)) {
    throw new Error("line-log.c: range_set_append: Assertion failed");
  }
  rs.push({ start, end });
}

/** sort_and_merge_range_set */
function sortAndMerge(rs: LineRange[]): LineRange[] {
  const sorted = [...rs].sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of sorted) {
    if (r.start === r.end) continue;
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      if (last.end < r.end) last.end = r.end;
    } else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** range_set_union: empty ranges dropped, touching and overlapping ones joined */
function union(a: readonly LineRange[], b: readonly LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let next: LineRange;
    if (i < a.length && j < b.length) {
      const ra = a[i] as LineRange;
      const rb = b[j] as LineRange;
      if (ra.start < rb.start) next = a[i++] as LineRange;
      else if (ra.start > rb.start) next = b[j++] as LineRange;
      else if (ra.end < rb.end) next = a[i++] as LineRange;
      else next = b[j++] as LineRange;
    } else if (i < a.length) next = a[i++] as LineRange;
    else next = b[j++] as LineRange;
    if (next.start === next.end) continue;
    const last = out[out.length - 1];
    if (!last || last.end < next.start) out.push({ start: next.start, end: next.end });
    else if (last.end < next.end) last.end = next.end;
  }
  return out;
}

/** range_set_difference: `a` without `b` (2.43 keeps a range ending where one of `b` starts) */
function difference(
  a: readonly LineRange[],
  b: readonly LineRange[],
  compatibility: LineLogCompatibility,
): LineRange[] {
  const out: LineRange[] = [];
  let j = 0;
  for (const range of a) {
    let start = range.start;
    const end = range.end;
    while (start < end) {
      while (j < b.length && start >= (b[j] as LineRange).end) j++;
      const bj = b[j];
      if (
        !bj ||
        (compatibility === "2.43" ? end < bj.start : end <= bj.start) ||
        // 2.43 loops forever on a range ending where `bj` starts; it ends here as 2.5x
        (end === bj.start && start < bj.start)
      ) {
        append(out, start, end);
        break;
      }
      if (start >= bj.start) start = bj.end;
      else if (end > bj.start) {
        append(out, start, bj.start);
        start = bj.end;
      }
    }
  }
  return out;
}

/** diff_ranges_filter_touched: the hunks whose target side overlaps a range */
function filterTouched(
  diff: DiffRanges,
  rs: readonly LineRange[],
  compatibility: LineLogCompatibility,
): DiffRanges {
  const out: DiffRanges = { parent: [], target: [] };
  let j = 0;
  for (let i = 0; i < diff.target.length; i++) {
    const t = diff.target[i] as LineRange;
    while (
      compatibility === "2.43"
        ? t.start > (rs[j] as LineRange).end
        : t.start >= (rs[j] as LineRange).end
    ) {
      j++;
      if (j === rs.length) return out;
    }
    const r = rs[j] as LineRange;
    if (!(t.end <= r.start || r.end <= t.start)) {
      const p = diff.parent[i] as LineRange;
      append(out.parent, p.start, p.end);
      append(out.target, t.start, t.end);
    }
  }
  return out;
}

/** range_set_shift_diff: ranges moved by the lines the hunks before them add or remove */
function shiftDiff(rs: readonly LineRange[], diff: DiffRanges): LineRange[] {
  const out: LineRange[] = [];
  let j = 0;
  let offset = 0;
  for (const r of rs) {
    while (j < diff.target.length && r.start >= (diff.target[j] as LineRange).start) {
      const p = diff.parent[j] as LineRange;
      const t = diff.target[j] as LineRange;
      offset += p.end - p.start - (t.end - t.start);
      j++;
    }
    append(out, r.start + offset, r.end + offset);
  }
  return out;
}

/** range_set_map_across_diff: the ranges in the parent, and the hunks that touched them */
function mapAcrossDiff(
  rs: readonly LineRange[],
  diff: DiffRanges,
  compatibility: LineLogCompatibility,
): { ranges: LineRange[]; touched: DiffRanges } {
  const touched = filterTouched(diff, rs, compatibility);
  const rest = difference(rs, touched.target, compatibility);
  return { ranges: union(shiftDiff(rest, diff), touched.parent), touched };
}

/** collect_diff: the hunks of a diff without context (xdiff's defaults: Myers, no heuristic) */
function collectDiff(parent: Uint8Array, target: Uint8Array): DiffRanges {
  const out: DiffRanges = { parent: [], target: [] };
  for (const c of xdiffHunks(parent, target)) {
    append(out.parent, c.i1, c.i1 + c.chg1);
    append(out.target, c.i2, c.i2 + c.chg2);
  }
  return out;
}

/** strcmp of two paths (their bytes) */
function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

// --- parsing --------------------------------------------------------------------------------

/** A file's lines as line-log.c's fill_line_ends sees them */
class FileLines {
  /** ends[0] = 0, then the offset of each line's newline (or of the last byte) */
  private readonly ends: number[] = [0];
  readonly lines: number;
  /** Where the data stops for regexec (its first NUL: a C string) */
  readonly cEnd: number;

  constructor(readonly data: Uint8Array) {
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0a || i === data.length - 1) this.ends.push(i);
    }
    this.lines = this.ends.length - 1;
    const nul = data.indexOf(0);
    this.cEnd = nul < 0 ? data.length : nul;
  }

  /** nth_line: where (0-based) line `n` starts */
  nth(n: number): number {
    return n === 0 ? 0 : (this.ends[n] as number) + 1;
  }
}

/** strtol: the number at `at` (whitespace and a sign allowed) and where it ends */
function strtol(s: string, at: number): { num: number; term: number } {
  let i = at;
  while (i < s.length && " \t\n\v\f\r".includes(s[i] as string)) i++;
  let sign = 1;
  if (s[i] === "+" || s[i] === "-") {
    if (s[i] === "-") sign = -1;
    i++;
  }
  const digits = i;
  let num = 0;
  while (i < s.length && s[i] !== undefined && s[i] >= "0" && s[i] <= "9") {
    num = num * 10 + (s.charCodeAt(i) - 48);
    i++;
  }
  if (i === digits) return { num: 0, term: at };
  return { num: sign * num, term: i };
}

/** regcomp of a `-L` pattern (basic syntax, `REG_NEWLINE`) */
function compileRangeRegex(pattern: string): PosixRegex | PosixRegexError {
  try {
    return compilePosixRegex(pattern, { newline: true });
  } catch (e) {
    if (e instanceof PosixRegexError) return e;
    throw e;
  }
}

/** What a range is parsed against: the file's lines and its function finder */
interface RangeFile {
  file: FileLines;
  findFunction?: FindFunction;
}

/**
 * line-range.c's parse_loc: one end of `-L A,B` at `at`; `begin` is the negated anchor for
 * A, the line after A for B. Without `file` it only finds where the end stops.
 */
function parseLoc(
  spec: string,
  at: number,
  begin: number,
  f?: RangeFile,
): { at: number; value?: number } {
  const c = spec[at];
  if (begin >= 1 && (c === "+" || c === "-")) {
    const { num, term } = strtol(spec, at + 1);
    if (term !== at + 1) {
      if (!f) return { at: term };
      if (num === 0) throw fatal("-L invalid empty range");
      const n = c === "-" ? -num : num;
      const value = n > 0 ? begin + n - 2 : begin + n > 0 ? begin + n : 1;
      return { at: term, value };
    }
    return { at };
  }
  const { num, term } = strtol(spec, at);
  if (term !== at) {
    if (f && num <= 0) throw fatal(`-L invalid line number: ${num}`);
    return f ? { at: term, value: num } : { at: term };
  }
  let start = at;
  if (begin < 0) {
    if (spec[start] !== "^") begin = -begin;
    else {
      begin = 1;
      start++;
    }
  }
  if (spec[start] !== "/") return { at: start };
  let term2 = start + 1;
  while (term2 < spec.length && spec[term2] !== "/") {
    if (spec[term2] === "\\") term2++;
    term2++;
  }
  if (term2 >= spec.length || spec[term2] !== "/") return { at: start };
  if (!f) return { at: term2 + 1 };
  const pattern = spec.slice(start + 1, term2);
  begin--;
  const { file } = f;
  let line = file.nth(begin);
  const re = compileRangeRegex(pattern);
  const m =
    re instanceof PosixRegexError ? undefined : re.exec(file.data.subarray(line, file.cEnd));
  if (re instanceof PosixRegexError || !m) {
    const message = re instanceof PosixRegexError ? re.message : "No match";
    throw fatal(`-L parameter '${pattern}' starting at line ${begin + 1}: ${message}`);
  }
  const cp = line + m.start;
  for (;;) {
    const more = begin < file.lines;
    begin++;
    if (!more) break;
    const next = file.nth(begin);
    if (line <= cp && cp < next) break;
    line = next;
  }
  return { at: term2 + 1, value: begin };
}

/** line-range.c's match_funcname: a line (with its newline) that starts a function */
function matchFuncname(f: RangeFile, bol: number, eol: number): boolean {
  const data = f.file.data;
  if (f.findFunction) {
    let end = eol;
    if (end > bol && data[end - 1] === 0x0a) {
      end--;
      if (end > bol && data[end - 1] === 0x0d) end--;
    }
    return f.findFunction(data.subarray(bol, end)) !== undefined;
  }
  if (bol === eol) return false;
  const c = data[bol] as number;
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;
}

/** find_funcname_matching_regexp: the start of the first function line the regex matches */
function findFuncnameMatching(f: RangeFile, start: number, re: PosixRegex): number {
  const { data, cEnd } = f.file;
  let pos = start;
  while (pos < cEnd) {
    const m = re.exec(data.subarray(pos, cEnd));
    if (!m) return -1;
    let bol = pos + m.start;
    let eol = pos + m.end;
    while (bol > pos) {
      bol--;
      if (data[bol] === 0x0a) break;
    }
    if (data[bol] === 0x0a) bol++;
    while (eol < cEnd && data[eol] !== 0x0a) eol++;
    if (eol < cEnd && data[eol] === 0x0a) eol++;
    if (matchFuncname(f, bol, eol)) return bol;
    pos = eol;
  }
  return -1;
}

/** parse_range_funcname: `:<regex>` (after an optional `^`) at `at` */
function parseRangeFuncname(
  spec: string,
  at: number,
  anchor: number,
  f?: RangeFile,
): { at: number; begin?: number; end?: number } | undefined {
  let i = at;
  if (spec[i] === "^") {
    anchor = 1;
    i++;
  }
  let term = i + 1;
  while (term < spec.length && spec[term] !== ":") {
    if (spec[term] === "\\" && term + 1 < spec.length) term++;
    term++;
  }
  if (term === i + 1) return undefined;
  if (!f) return { at: term };
  const pattern = spec.slice(i + 1, term);
  anchor--;
  const re = compileRangeRegex(pattern);
  if (re instanceof PosixRegexError) throw fatal(`-L parameter '${pattern}': ${re.message}`);
  const p = findFuncnameMatching(f, f.file.nth(anchor), re);
  if (p < 0) throw fatal(`-L parameter '${pattern}' starting at line ${anchor + 1}: no match`);
  let begin = 0;
  while (p > f.file.nth(begin)) begin++;
  if (begin >= f.file.lines) throw fatal(`-L parameter '${pattern}' matches at EOF`);
  let end = begin + 1;
  while (end < f.file.lines) {
    if (matchFuncname(f, f.file.nth(end), f.file.nth(end + 1))) break;
    end++;
  }
  return { at: term, begin: begin + 1, end };
}

/** skip_range_arg: where the range part of `-L <range>:<file>` stops, undefined for none */
function skipRangeArg(arg: string): number | undefined {
  if (arg[0] === ":" || (arg[0] === "^" && arg[1] === ":")) {
    return parseRangeFuncname(arg, 0, 0)?.at;
  }
  let at = parseLoc(arg, 0, -1).at;
  if (arg[at] === ",") at = parseLoc(arg, at + 1, 0).at;
  return at;
}

/** parse_range_arg: `[begin, end]` (1-based; 0 when not given), undefined when malformed */
function parseRangeArg(
  arg: string,
  f: RangeFile,
  anchorIn: number,
): { begin: number; end: number } | undefined {
  const lines = f.file.lines;
  let anchor = anchorIn < 1 ? 1 : anchorIn;
  if (anchor > lines) anchor = lines + 1;
  if (arg[0] === ":" || (arg[0] === "^" && arg[1] === ":")) {
    const r = parseRangeFuncname(arg, 0, anchor, f);
    if (!r || r.at !== arg.length) return undefined;
    return { begin: r.begin ?? 0, end: r.end ?? 0 };
  }
  const first = parseLoc(arg, 0, -anchor, f);
  let begin = first.value ?? 0;
  let end = 0;
  let at = first.at;
  if (arg[at] === ",") {
    const second = parseLoc(arg, at + 1, begin + 1, f);
    end = second.value ?? 0;
    at = second.at;
  }
  if (at !== arg.length) return undefined;
  if (begin && end && end < begin) [begin, end] = [end, begin];
  return { begin, end };
}

/** What {@link parseLineRanges} reads in the commit the log starts from */
export interface LineRangeSource {
  /** The blob at a path of the commit, undefined when it has none */
  blob(path: string): Promise<{ id: ObjectId; mode: number; data: Uint8Array } | undefined>;
  /** The funcname pattern of the path's diff driver, if any */
  findFunction(path: string): Promise<FindFunction | undefined>;
}

/** prefix_path at the top of the worktree: `.` and empty components dropped */
function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((p) => p !== "" && p !== ".")
    .join("/");
}

/**
 * line-log.c's parse_lines: each `-L` argument as a file's 0-based ranges, the files in path
 * order, each file's ranges sorted and merged. Throws git's deaths (`fatal:`, exit 128).
 */
export async function parseLineRanges(
  args: readonly string[],
  source: LineRangeSource,
): Promise<LineLogData[]> {
  const list: LineLogData[] = [];
  for (const item of args) {
    const nameAt = skipRangeArg(item);
    if (nameAt === undefined || item[nameAt] !== ":" || nameAt + 1 >= item.length) {
      throw fatal(`-L argument not 'start,end:file' or ':funcname:file': ${item}`);
    }
    const rangePart = item.slice(0, nameAt);
    const name = item.slice(nameAt + 1);
    const fullName = normalizePath(name);
    const blob = await source.blob(fullName);
    if (!blob) throw fatal(`There is no path ${fullName} in the commit`);
    const findFunction = await source.findFunction(fullName);
    const f: RangeFile = {
      file: new FileLines(blob.data),
      ...(findFunction ? { findFunction } : {}),
    };
    const lines = f.file.lines;
    const known = list.find((p) => p.path === fullName);
    const lastRange = known?.ranges[known.ranges.length - 1];
    const anchor = lastRange ? lastRange.end + 1 : 1;
    const parsed = parseRangeArg(rangePart, f, anchor);
    if (!parsed) throw fatal(`malformed -L argument '${rangePart}'`);
    let { begin, end } = parsed;
    if ((!lines && (begin || end)) || lines < begin) {
      throw fatal(`file ${name} has only ${lines} lines`);
    }
    if (begin < 1) begin = 1;
    if (end < 1 || lines < end) end = lines;
    begin--;
    if (known) known.ranges.push({ start: begin, end });
    else {
      // line_log_data_insert: after the last file whose path sorts before
      let at = 0;
      list.forEach((p, k) => {
        if (comparePaths(p.path, fullName) < 0) at = k + 1;
      });
      list.splice(at, 0, { path: fullName, ranges: [{ start: begin, end }] });
    }
  }
  for (const p of list) p.ranges = sortAndMerge(p.ranges);
  return list;
}

// --- the walk ---------------------------------------------------------------------------------

/** What a {@link LineLogWalk} reads of the repository */
export interface LineLogHost {
  /** The tree of a commit */
  treeOf(commit: ObjectId): Promise<ObjectId>;
  /** The entry at a path of a tree (a blob, a link, a submodule), undefined when none */
  entry(tree: ObjectId, path: string): Promise<{ id: ObjectId; mode: number } | undefined>;
  /** A blob's content */
  blob(id: ObjectId): Promise<Uint8Array>;
  /**
   * With rename detection on (`diff.renames`, `-M`): the renames of the created files
   * `created` from the files `parentTree` has and `tree` lacks (diffcore_rename), as
   * `[source, destination path, score 0..100]`; undefined when renames are off
   */
  renames?(
    parentTree: ObjectId,
    tree: ObjectId,
    created: LineLogSide[],
  ): Promise<{ from: LineLogSide; to: string; score: number }[]>;
  /**
   * git 2.43: the pairs as its `diffcore_std` leaves them when it follows renames with the
   * log's own options (the pickaxe and `--diff-filter` drop pairs there)
   */
  diffcore?(pairs: LineLogPair[]): Promise<LineLogPair[]>;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFGITLINK = 0o160000;

/** A submodule's content in a diff: `Subproject commit <id>` and a newline */
export function gitlinkText(id: ObjectId): Uint8Array {
  return encodeGitPath(`Subproject commit ${id}\n`);
}

/** The line ranges each commit tracks, filled from the children down (line-log.c's walk) */
export class LineLogWalk {
  private readonly ranges = new Map<ObjectId, LineLogData[]>();
  /** Merges whose ranges one parent took whole: that parent alone */
  private readonly narrowed = new Map<ObjectId, ObjectId[]>();
  /** Commits processed whose diff touched no range (git's TREESAME) */
  private readonly treesame = new Set<ObjectId>();
  private readonly blobs = new OrderedMap<ObjectId, Promise<Uint8Array>>();

  constructor(
    private readonly host: LineLogHost,
    private readonly compatibility: LineLogCompatibility,
    private readonly firstParentOnly: boolean,
  ) {}

  /** line_log_init: the parsed ranges on the commit the log starts from */
  start(commit: ObjectId, ranges: LineLogData[]): void {
    this.addRange(commit, ranges);
  }

  /** The parents a merge keeps after one of them took its ranges (undefined: unchanged) */
  parentsOf(commit: ObjectId): ObjectId[] | undefined {
    return this.narrowed.get(commit);
  }

  /** Whether the commit was processed and its diff touched no range */
  isTreesame(commit: ObjectId): boolean {
    return this.treesame.has(commit);
  }

  /**
   * line_log_process_ranges_arbitrary_commit: maps the commit's ranges to its parents; true
   * when its diff touched them (the commit is shown)
   */
  async process(commit: ObjectId, parents: readonly ObjectId[]): Promise<boolean> {
    const range = this.ranges.get(commit);
    let changed = false;
    if (range) {
      if (parents.length > 1) changed = await this.processMerge(commit, parents, range);
      else changed = await this.processOrdinary(commit, parents[0], range);
    }
    if (!changed) this.treesame.add(commit);
    return changed;
  }

  private async processOrdinary(
    commit: ObjectId,
    parent: ObjectId | undefined,
    range: LineLogData[],
  ): Promise<boolean> {
    const queue = await this.queueDiffs(range, commit, parent);
    const { out, changed } = await this.processAllFiles(range, queue);
    if (parent) this.addRange(parent, out);
    return changed > 0;
  }

  private async processMerge(
    commit: ObjectId,
    parents: readonly ObjectId[],
    range: LineLogData[],
  ): Promise<boolean> {
    const n = this.firstParentOnly ? 1 : parents.length;
    const candidates: LineLogData[][] = [];
    for (let i = 0; i < n; i++) {
      const parent = parents[i] as ObjectId;
      const queue = await this.queueDiffs(range, commit, parent);
      const { out, changed } = await this.processAllFiles(range, queue);
      candidates.push(out);
      if (!changed) {
        // this parent takes all the blame: no other line of history is followed
        this.addRange(parent, out);
        this.narrowed.set(commit, [parent]);
        this.ranges.delete(commit);
        return false;
      }
    }
    for (let i = 0; i < n; i++)
      this.addRange(parents[i] as ObjectId, candidates[i] as LineLogData[]);
    this.ranges.delete(commit);
    return true;
  }

  /** add_line_range: merged into what the commit tracks already */
  private addRange(commit: ObjectId, range: LineLogData[]): void {
    const old = this.ranges.get(commit);
    this.ranges.set(commit, old ? mergeData(old, range) : copyData(range));
  }

  /** queue_diffs: the pairs of the tracked paths, creations paired with renames */
  private async queueDiffs(
    range: readonly LineLogData[],
    commit: ObjectId,
    parent: ObjectId | undefined,
  ): Promise<LineLogPair[]> {
    const tree = await this.host.treeOf(commit);
    const parentTree = parent ? await this.host.treeOf(parent) : undefined;
    const pairs: LineLogPair[] = [];
    const paths = [...new Set(range.map((r) => r.path))].sort(comparePaths);
    for (const path of paths) {
      const two = await this.fileAt(tree, path);
      if (!two) continue;
      const one = parentTree ? await this.fileAt(parentTree, path) : undefined;
      if (one && one.id === two.id && one.mode === two.mode) continue;
      pairs.push({ ...(one ? { one } : {}), two });
    }
    const created = pairs.filter((p) => !p.one);
    if (created.length === 0 || !this.host.renames) return pairs;
    if (parentTree) {
      const found = await this.host.renames(
        parentTree,
        tree,
        created.map((p) => p.two),
      );
      for (const r of found) {
        const pair = created.find((p) => p.two.path === r.to);
        if (!pair) continue;
        pair.one = r.from;
        pair.score = r.score;
      }
    }
    if (this.compatibility === "2.43" && this.host.diffcore) return this.host.diffcore(pairs);
    return pairs;
  }

  private async fileAt(tree: ObjectId, path: string): Promise<LineLogSide | undefined> {
    const e = await this.host.entry(tree, path);
    if (!e || (e.mode & S_IFMT) === S_IFDIR) return undefined;
    return { path, id: e.id, mode: e.mode };
  }

  /** A side's content as diff_populate_filespec reads it (a submodule: its commit line) */
  private blob(side: LineLogSide): Promise<Uint8Array> {
    const id = side.id;
    let found = this.blobs.get(id);
    if (!found) {
      found =
        (side.mode & S_IFMT) === S_IFGITLINK
          ? Promise.resolve(gitlinkText(id))
          : this.host.blob(id);
      this.blobs.set(id, found);
      if (this.blobs.size > 256) this.blobs.deleteOldest();
    }
    return found;
  }

  /**
   * process_all_files: the ranges mapped to the parent; each pair that touched them stored
   * on the commit's own ranges (with the hunks), for its output
   */
  private async processAllFiles(
    range: LineLogData[],
    queue: readonly LineLogPair[],
  ): Promise<{ out: LineLogData[]; changed: number }> {
    const out = copyData(range);
    let changed = 0;
    for (const pair of queue) {
      const touched = await this.processPair(pair, out);
      if (!touched) continue;
      changed++;
      const rg = range.find((r) => r.path === pair.two.path);
      if (!rg) continue;
      rg.pair = pair;
      rg.diff = touched;
    }
    return { out, changed };
  }

  /** process_diff_filepair: the file's ranges moved to the parent's side of the pair */
  private async processPair(
    pair: LineLogPair,
    range: LineLogData[],
  ): Promise<DiffRanges | undefined> {
    const rg = range.find((r) => r.path === pair.two.path);
    if (!rg || rg.ranges.length === 0) return undefined;
    const target = await this.blob(pair.two);
    const parent = pair.one ? await this.blob(pair.one) : new Uint8Array(0);
    const diff = collectDiff(parent, target);
    rg.path = pair.one?.path ?? pair.two.path;
    const { ranges, touched } = mapAcrossDiff(rg.ranges, diff, this.compatibility);
    rg.ranges = ranges;
    return touched.parent.length > 0 ? touched : undefined;
  }

  /**
   * line_log_queue_pairs: the pairs a shown commit prints, each cut to the commit's ranges of
   * its file (git 2.5x)
   */
  queuedPairs(commit: ObjectId): DiffEntry[] {
    const out: DiffEntry[] = [];
    for (const r of this.ranges.get(commit) ?? []) {
      const pair = r.pair;
      if (!pair) continue;
      // diff_filepair_dup keeps only the two sides: a renamed pair prints as a modification
      // between two paths (no rename lines, `M` with the old path, no score)
      const { one, two } = pair;
      out.push({
        changeType: one ? ChangeType.MODIFY : ChangeType.ADD,
        ...(one
          ? { oldPath: one.path, oldId: one.id, oldMode: one.mode as DiffEntry["oldMode"] }
          : {}),
        newPath: two.path,
        newId: two.id,
        newMode: two.mode as DiffEntry["newMode"],
        lineRanges: r.ranges.map((x) => ({ ...x })),
      });
    }
    return out;
  }

  /**
   * line-log.c's dump_diff_hacky of git 2.43: a blank line, then each touched file's ranges as
   * hunks of the diff that touched them, every line after `prefix` (the graph's padding)
   */
  async hackyDiff(
    commit: ObjectId,
    prefix: string,
    colors?: {
      meta: string;
      frag: string;
      old: string;
      new: string;
      context: string;
      reset: string;
    },
  ): Promise<Uint8Array> {
    const out: Uint8Array[] = [];
    const text = (s: string) => out.push(encodeGitPath(s));
    text(`${prefix}\n`);
    const c = colors ?? { meta: "", frag: "", old: "", new: "", context: "", reset: "" };
    for (const range of this.ranges.get(commit) ?? []) {
      const { pair, diff } = range;
      if (!pair || !diff) continue;
      const parentFile = pair.one ? new FileLines(await this.blob(pair.one)) : undefined;
      const targetFile = new FileLines(await this.blob(pair.two));
      const printLine = (first: string, line: number, file: FileLines, color: string) => {
        const begin = file.nth(line);
        let end = file.nth(line + 1);
        let hadNl = false;
        if (end > begin && file.data[end - 1] === 0x0a) {
          end--;
          hadNl = true;
        }
        text(`${prefix}${color}${first}`);
        out.push(file.data.subarray(begin, end));
        text(`${c.reset}\n`);
        if (!hadNl) text("\\ No newline at end of file\n");
      };
      const onePath = pair.one?.path ?? pair.two.path;
      text(`${prefix}${c.meta}diff --git a/${onePath} b/${pair.two.path}${c.reset}\n`);
      text(`${prefix}${c.meta}--- ${pair.one ? `a/${onePath}` : "/dev/null"}${c.reset}\n`);
      text(`${prefix}${c.meta}+++ b/${pair.two.path}${c.reset}\n`);
      const target = diff.target;
      const parent = diff.parent;
      let j = 0;
      for (const r of range.ranges) {
        const tStart = r.start;
        const tEnd = r.end;
        let tCur = tStart;
        while (j < target.length && (target[j] as LineRange).end < tStart) j++;
        if (j === target.length || (target[j] as LineRange).start > tEnd) continue;
        let jLast = j;
        while (jLast < target.length && (target[jLast] as LineRange).start < tEnd) jLast++;
        if (jLast > j) jLast--;
        const tj = target[j] as LineRange;
        const tl = target[jLast] as LineRange;
        let pStart =
          tStart < tj.start
            ? (parent[j] as LineRange).start - (tj.start - tStart)
            : (parent[j] as LineRange).start;
        let pEnd =
          tEnd > tl.end
            ? (parent[jLast] as LineRange).end + (tEnd - tl.end)
            : (parent[jLast] as LineRange).end;
        if (!pStart && !pEnd) {
          pStart = -1;
          pEnd = -1;
        }
        text(
          `${prefix}${c.frag}@@ -${pStart + 1},${pEnd - pStart} +${tStart + 1},${tEnd - tStart} @@${c.reset}\n`,
        );
        while (j < target.length && (target[j] as LineRange).start < tEnd) {
          const t = target[j] as LineRange;
          const p = parent[j] as LineRange;
          for (; tCur < t.start; tCur++) printLine(" ", tCur, targetFile, c.context);
          for (let k = p.start; k < p.end; k++) {
            printLine("-", k, parentFile as FileLines, c.old);
          }
          for (; tCur < t.end && tCur < tEnd; tCur++) printLine("+", tCur, targetFile, c.new);
          j++;
        }
        for (; tCur < tEnd; tCur++) printLine(" ", tCur, targetFile, c.context);
      }
    }
    let size = 0;
    for (const b of out) size += b.length;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const b of out) {
      bytes.set(b, at);
      at += b.length;
    }
    return bytes;
  }
}

/** A pair as git 2.43's diffcore_std sees it while following renames (renames as `R`) */
export function lineLogEntry(pair: LineLogPair): DiffEntry {
  const { one, two } = pair;
  const renamed = one !== undefined && one.path !== two.path;
  return {
    changeType: !one ? ChangeType.ADD : renamed ? ChangeType.RENAME : ChangeType.MODIFY,
    ...(one ? { oldPath: one.path, oldId: one.id, oldMode: one.mode as DiffEntry["oldMode"] } : {}),
    newPath: two.path,
    newId: two.id,
    newMode: two.mode as DiffEntry["newMode"],
    ...(renamed && pair.score !== undefined ? { score: pair.score } : {}),
  };
}

/** line_log_data_copy: paths and ranges, without the pairs */
function copyData(range: readonly LineLogData[]): LineLogData[] {
  return range.map((r) => ({ path: r.path, ranges: r.ranges.map((x) => ({ ...x })) }));
}

/** line_log_data_merge: two path-ordered lists merged, the ranges of one path united */
function mergeData(a: readonly LineLogData[], b: readonly LineLogData[]): LineLogData[] {
  const out: LineLogData[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    const cmp = !x ? 1 : !y ? -1 : comparePaths(x.path, y.path);
    if (cmp < 0) {
      out.push({
        path: (x as LineLogData).path,
        ranges: (x as LineLogData).ranges.map((r) => ({ ...r })),
      });
      i++;
    } else if (cmp === 0) {
      out.push({
        path: (x as LineLogData).path,
        ranges: union((x as LineLogData).ranges, (y as LineLogData).ranges),
      });
      i++;
      j++;
    } else {
      out.push({
        path: (y as LineLogData).path,
        ranges: (y as LineLogData).ranges.map((r) => ({ ...r })),
      });
      j++;
    }
  }
  return out;
}

export type { LineLogData };
