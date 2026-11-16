/**
 * A port of xdiff's hunk emitter (`xdiff/xemit.c`, the hunk header of `xdiff/xutils.c`) and of
 * the parts of git's `xdi_diff` and `diff.c` around it, so that a unified diff body comes out
 * as `git diff` prints it, byte for byte.
 *
 * @example
 * ```ts
 * const body = unifiedDiff(before, after, { context: 3, algorithm: "myers", indentHeuristic: true });
 * // "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n" as bytes
 * ```
 *
 * The changes come from {@link xdiff}. Changes made only of blank lines are marked ignorable
 * for `--ignore-blank-lines` (`xdl_mark_ignorable_lines`); `xdl_get_hunk` then groups changes
 * into hunks with the context and inter-hunk context, leaving ignorable changes out where
 * git does. Each hunk header carries the nearest function line above the hunk: by default a
 * line that starts with a letter, `_` or `$` (`def_ff`), or what a diff driver's funcname
 * pattern matches (see {@link userdiffFindFunction}).
 *
 * @module
 */

import { ByteLines } from "./byte-lines.js";
import {
  diffScript,
  whitespaceFlags,
  XDF_WHITESPACE_FLAGS,
  type XdiffChange,
  type XdiffOptions,
  xdlIsSpace,
} from "./xdiff.js";

/**
 * Finds whether a line is a function line, for hunk headers (xdiff's `find_func`). It gets
 * the line without its terminator (LF, or CR LF) and returns the part of it to show, as
 * `[start, end)` offsets into `line`, or `undefined` for a line that is no function line.
 */
export type FindFunction = (line: Uint8Array) => [number, number] | undefined;

/** Options of {@link unifiedDiff} and {@link unifiedDiffHunks} */
export interface UnifiedDiffOptions extends XdiffOptions {
  /** Lines of context around changes (`-U`, default 3) */
  context?: number;
  /** Lines between hunks that still join them (`--inter-hunk-context`, default 0) */
  interHunkContext?: number;
  /** Show the whole function as context (`-W`, `--function-context`) */
  functionContext?: boolean;
  /** Ignore changes whose lines are all blank (`--ignore-blank-lines`) */
  ignoreBlankLines?: boolean;
  /**
   * The function line finder of hunk headers: a diff driver's (see
   * {@link userdiffFindFunction}), or by default xdiff's `def_ff`
   */
  findFunction?: FindFunction;
}

/** A change of a diff script with xdiff's `ignore` mark */
export interface XdiffEmitChange extends XdiffChange {
  /** Set by `--ignore-blank-lines` for a change made only of blank lines */
  ignore?: boolean;
}

/** One line of a hunk: context (shown from the new file), removed or added */
export interface EmittedLine {
  kind: " " | "-" | "+";
  /** Line index in the old file (`-`) or the new file (` ` and `+`) */
  index: number;
}

/** A hunk as xdiff emits it */
export interface EmittedHunk {
  /** Old start as printed: 1-based, or the line before for an empty range */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The function line of the header (empty when none) */
  func: Uint8Array;
  lines: EmittedLine[];
}

/** The two files of a diff after {@link unifiedDiffHunks}, and its hunks */
export interface UnifiedDiffResult {
  old: ByteLines;
  new: ByteLines;
  hunks: EmittedHunk[];
}

const FUNC_LINE_SIZE = 80;
const EMPTY = new Uint8Array(0);

/** xdiff's `xdl_blankline` */
function blankLine(lines: ByteLines, i: number, flags: number): boolean {
  const start = lines.start(i);
  const end = lines.start(i + 1);
  if (!(flags & XDF_WHITESPACE_FLAGS)) return end - start <= 1;
  const c = lines.content;
  let p = start;
  while (p < end && xdlIsSpace(c[p])) p++;
  return p === end;
}

/** xdiff's `xdl_mark_ignorable_lines` */
export function markIgnorableLines(
  script: XdiffEmitChange[],
  a: ByteLines,
  b: ByteLines,
  flags: number,
): void {
  for (const ch of script) {
    let ignore = true;
    for (let i = 0; i < ch.chg1 && ignore; i++) ignore = blankLine(a, ch.i1 + i, flags);
    for (let i = 0; i < ch.chg2 && ignore; i++) ignore = blankLine(b, ch.i2 + i, flags);
    ch.ignore = ignore;
  }
}

/**
 * xdiff's `xdl_get_hunk`: from change `start`, the index of the last change of its hunk.
 * Returns `[first, last]` (the first after the ignorable ones left out), or undefined when
 * only ignorable changes are left.
 */
function getHunk(
  script: XdiffEmitChange[],
  start: number,
  ctxlen: number,
  interhunkctxlen: number,
): [number, number] | undefined {
  const maxCommon = ctxlen + ctxlen + interhunkctxlen;
  const maxIgnorable = ctxlen;
  let first = start;
  // remove ignorable changes that are too far before other changes
  for (let p = start; p < script.length && script[p].ignore; p++) {
    const x = p + 1;
    if (x >= script.length || script[x].i1 - (script[p].i1 + script[p].chg1) >= maxIgnorable) {
      first = x;
    }
  }
  if (first >= script.length) return undefined;
  let last = first;
  let ignored = 0;
  for (let p = first, x = p + 1; x < script.length; p = x, x++) {
    const xch = script[x];
    const xchp = script[p];
    const distance = xch.i1 - (xchp.i1 + xchp.chg1);
    if (distance > maxCommon) break;
    const lx = script[last];
    if (distance < maxIgnorable && (!xch.ignore || last === p)) {
      last = x;
      ignored = 0;
    } else if (distance < maxIgnorable && xch.ignore) {
      ignored += xch.chg2;
    } else if (last !== p && xch.i1 + ignored - (lx.i1 + lx.chg1) > maxCommon) {
      break;
    } else if (!xch.ignore) {
      last = x;
      ignored = 0;
    } else {
      ignored += xch.chg2;
    }
  }
  return [first, last];
}

/** xdiff's `def_ff`: a line starting with a letter, `_` or `$` */
function defaultFindFunction(line: Uint8Array): [number, number] | undefined {
  if (line.length === 0) return undefined;
  const c = line[0];
  const alpha = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  return alpha || c === 0x5f || c === 0x24 ? [0, line.length] : undefined;
}

/**
 * xdiff's `match_func_rec` with git's `ff_regexp`/`def_ff`: the function text of line `i`
 * (at most 80 bytes, trailing whitespace dropped), or undefined.
 */
function matchFuncRec(
  lines: ByteLines,
  i: number,
  find: FindFunction | undefined,
): Uint8Array | undefined {
  const rec = lines.line(i);
  let start: number;
  let end: number;
  if (!find) {
    // def_ff sees the record with its terminator
    const found = defaultFindFunction(rec);
    if (!found) return undefined;
    [start, end] = found;
  } else {
    let len = rec.length;
    if (len > 0 && rec[len - 1] === 0x0a) {
      if (len > 1 && rec[len - 2] === 0x0d) len -= 2;
      else len--;
    }
    const found = find(rec.subarray(0, len));
    if (!found) return undefined;
    [start, end] = found;
  }
  if (end - start > FUNC_LINE_SIZE) end = start + FUNC_LINE_SIZE;
  while (end > start && xdlIsSpace(rec[end - 1])) end--;
  return rec.subarray(start, end);
}

function isEmptyRec(lines: ByteLines, i: number): boolean {
  const c = lines.content;
  const end = lines.start(i + 1);
  let p = lines.start(i);
  while (p < end && xdlIsSpace(c[p])) p++;
  return p === end;
}

/**
 * xdiff's `xdl_emit_diff`: the hunks of a diff script, with their context, function lines
 * and the changes `--ignore-blank-lines` leaves out.
 */
export function emitHunks(
  a: ByteLines,
  b: ByteLines,
  script: XdiffEmitChange[],
  options: Pick<
    UnifiedDiffOptions,
    "context" | "interHunkContext" | "functionContext" | "findFunction"
  > & { funcNames?: boolean } = {},
): EmittedHunk[] {
  const ctxlen = options.context ?? 3;
  const interhunk = options.interHunkContext ?? 0;
  const find = options.findFunction;
  const funcNames = options.funcNames ?? true;
  const funcContext = options.functionContext ?? false;
  const nrec1 = a.size();
  const nrec2 = b.size();
  const isFunc = (lines: ByteLines, i: number) => matchFuncRec(lines, i, find) !== undefined;
  /** get_func_line over the old file, from `start` towards `limit` (exclusive) */
  const getFuncLine = (start: number, limit: number): [number, Uint8Array] | undefined => {
    const step = start > limit ? -1 : 1;
    for (let l = start; l !== limit && l >= 0 && l < nrec1; l += step) {
      const found = matchFuncRec(a, l, find);
      if (found) return [l, found];
    }
    return undefined;
  };
  const hunks: EmittedHunk[] = [];
  let funclineprev = -1;
  let funcLine: Uint8Array = EMPTY;

  for (let xi = 0; xi < script.length; ) {
    let xchpIdx = xi;
    const got = getHunk(script, xi, ctxlen, interhunk);
    if (!got) break;
    let xchIdx = got[0];
    let xcheIdx = got[1];
    let s1 = 0;
    let s2 = 0;
    // pre-context
    for (;;) {
      const xch = script[xchIdx];
      s1 = Math.max(xch.i1 - ctxlen, 0);
      s2 = Math.max(xch.i2 - ctxlen, 0);
      if (!funcContext) break;
      let i1 = xch.i1;
      let skip = false;
      if (i1 >= nrec1) {
        let i2 = xch.i2;
        while (i2 < nrec2) {
          if (isFunc(b, i2)) {
            skip = true;
            break;
          }
          i2++;
        }
        if (skip) break;
        i1 = nrec1 - 1;
      }
      let fs1 = getFuncLine(i1, -1)?.[0] ?? -1;
      while (fs1 > 0 && !isEmptyRec(a, fs1 - 1) && !isFunc(a, fs1 - 1)) fs1--;
      if (fs1 < 0) fs1 = 0;
      if (fs1 < s1) {
        s2 = Math.max(s2 - (s1 - fs1), 0);
        s1 = fs1;
        while (
          xchpIdx !== xchIdx &&
          script[xchpIdx].i1 + script[xchpIdx].chg1 <= s1 &&
          script[xchpIdx].i2 + script[xchpIdx].chg2 <= s2
        ) {
          xchpIdx++;
        }
        if (xchpIdx !== xchIdx) {
          xchIdx = xchpIdx;
          continue;
        }
      }
      break;
    }
    // post-context
    let e1 = 0;
    let e2 = 0;
    for (;;) {
      const xche = script[xcheIdx];
      let lctx = ctxlen;
      lctx = Math.min(lctx, nrec1 - (xche.i1 + xche.chg1));
      lctx = Math.min(lctx, nrec2 - (xche.i2 + xche.chg2));
      e1 = xche.i1 + xche.chg1 + lctx;
      e2 = xche.i2 + xche.chg2 + lctx;
      if (!funcContext) break;
      let fe1 = getFuncLine(xche.i1 + xche.chg1, nrec1)?.[0] ?? -1;
      while (fe1 > 0 && isEmptyRec(a, fe1 - 1)) fe1--;
      if (fe1 < 0) fe1 = nrec1;
      if (fe1 > e1) {
        e2 = Math.min(e2 + (fe1 - e1), nrec2);
        e1 = fe1;
      }
      if (xcheIdx + 1 < script.length) {
        const l = Math.min(script[xcheIdx + 1].i1, nrec1 - 1);
        if (l - ctxlen <= e1 || getFuncLine(l, e1) === undefined) {
          xcheIdx++;
          continue;
        }
      }
      break;
    }

    if (funcNames) {
      const found = getFuncLine(s1 - 1, funclineprev);
      if (found) funcLine = found[1];
      funclineprev = s1 - 1;
    }
    const c1 = e1 - s1;
    const c2 = e2 - s2;
    const hunk: EmittedHunk = {
      oldStart: c1 ? s1 + 1 : s1,
      oldCount: c1,
      newStart: c2 ? s2 + 1 : s2,
      newCount: c2,
      func: funcLine,
      lines: [],
    };
    const out = hunk.lines;
    let xch = script[xchIdx];
    for (; s2 < xch.i2; s2++) out.push({ kind: " ", index: s2 });
    for (s1 = xch.i1, s2 = xch.i2; ; ) {
      for (; s1 < xch.i1 && s2 < xch.i2; s1++, s2++) out.push({ kind: " ", index: s2 });
      for (s1 = xch.i1; s1 < xch.i1 + xch.chg1; s1++) out.push({ kind: "-", index: s1 });
      for (s2 = xch.i2; s2 < xch.i2 + xch.chg2; s2++) out.push({ kind: "+", index: s2 });
      if (xchIdx === xcheIdx) break;
      s1 = xch.i1 + xch.chg1;
      s2 = xch.i2 + xch.chg2;
      xch = script[++xchIdx];
    }
    const xche = script[xcheIdx];
    for (s2 = xche.i2 + xche.chg2; s2 < e2; s2++) out.push({ kind: " ", index: s2 });
    hunks.push(hunk);
    xi = xcheIdx + 1;
  }
  return hunks;
}

/**
 * git's `trim_common_tail` (`xdi_diff` without context): the common tail, in 1 KiB blocks,
 * left out, back to the end of a line. Returns the new lengths of both buffers' views.
 */
export function trimCommonTail(a: Uint8Array, b: Uint8Array): number {
  const blk = 1024;
  let trimmed = 0;
  let recovered = 0;
  const smaller = Math.min(a.length, b.length);
  let ap = a.length;
  let bp = b.length;
  outer: while (blk + trimmed <= smaller) {
    for (let k = 0; k < blk; k++) if (a[ap - blk + k] !== b[bp - blk + k]) break outer;
    trimmed += blk;
    ap -= blk;
    bp -= blk;
  }
  while (recovered < trimmed) if (a[ap + recovered++] === 0x0a) break;
  return trimmed - recovered;
}

/**
 * The hunks of the unified diff of two files, as `git diff` finds them (`xdi_diff`:
 * the common tail trimmed without context, the xdiff script, blank-line changes marked
 * ignorable, `xdl_emit_diff`).
 */
export function unifiedDiffHunks(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  options: UnifiedDiffOptions = {},
): UnifiedDiffResult {
  let a = oldContent;
  let b = newContent;
  const context = options.context ?? 3;
  if (context === 0 && !options.functionContext) {
    const cut = trimCommonTail(a, b);
    a = a.subarray(0, a.length - cut);
    b = b.subarray(0, b.length - cut);
  }
  const la = new ByteLines(a);
  const lb = new ByteLines(b);
  const ws = whitespaceFlags(options);
  const script: XdiffEmitChange[] = diffScript(la, 0, la.size(), lb, 0, lb.size(), {
    algorithm: options.algorithm ?? "myers",
    indentHeuristic: options.indentHeuristic ?? false,
    histogramRediff: options.histogramRediff ?? true,
    legacyMinimal: options.legacyMinimal ?? false,
    whitespace: ws,
  });
  if (script.length > 0 && options.ignoreBlankLines) markIgnorableLines(script, la, lb, ws);
  const hunks = script.length > 0 ? emitHunks(la, lb, script, options) : [];
  return { old: la, new: lb, hunks };
}

/**
 * The changes `xdi_diff` hands to a hunk callback without context, as `git blame` gets
 * them: the common tail trimmed first (`trim_common_tail`), then one change per hunk.
 */
export function xdiffHunks(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  options: XdiffOptions = {},
): XdiffChange[] {
  const cut = trimCommonTail(oldContent, newContent);
  const la = new ByteLines(oldContent.subarray(0, oldContent.length - cut));
  const lb = new ByteLines(newContent.subarray(0, newContent.length - cut));
  return diffScript(la, 0, la.size(), lb, 0, lb.size(), {
    algorithm: options.algorithm ?? "myers",
    indentHeuristic: options.indentHeuristic ?? false,
    histogramRediff: options.histogramRediff ?? true,
    legacyMinimal: options.legacyMinimal ?? false,
    whitespace: whitespaceFlags(options),
  });
}

const encoder = new TextEncoder();
const NO_NEWLINE = encoder.encode("\n\\ No newline at end of file\n");

/** Length of the valid UTF-8 prefix of `bytes` as git's `sane_truncate_line` reads it */
export function saneUtf8Length(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let p = start;
  while (p < end) {
    const s0 = bytes[p];
    const rem = end - p;
    let incr = 0;
    if (s0 < 0x80) incr = 1;
    else if ((s0 & 0xe0) === 0xc0) {
      if (rem >= 2 && (bytes[p + 1] & 0xc0) === 0x80 && (s0 & 0xfe) !== 0xc0) incr = 2;
    } else if ((s0 & 0xf0) === 0xe0) {
      const s1 = bytes[p + 1];
      const s2 = bytes[p + 2];
      if (
        rem >= 3 &&
        (s1 & 0xc0) === 0x80 &&
        (s2 & 0xc0) === 0x80 &&
        !(s0 === 0xe0 && (s1 & 0xe0) === 0x80) &&
        !(s0 === 0xed && (s1 & 0xe0) === 0xa0) &&
        !(s0 === 0xef && s1 === 0xbf && (s2 & 0xfe) === 0xbe)
      ) {
        incr = 3;
      }
    } else if ((s0 & 0xf8) === 0xf0) {
      const s1 = bytes[p + 1];
      if (
        rem >= 4 &&
        (s1 & 0xc0) === 0x80 &&
        (bytes[p + 2] & 0xc0) === 0x80 &&
        (bytes[p + 3] & 0xc0) === 0x80 &&
        !(s0 === 0xf0 && (s1 & 0xf0) === 0x80) &&
        !(s0 === 0xf4 && s1 > 0x8f) &&
        s0 <= 0xf4
      ) {
        incr = 4;
      }
    }
    if (incr === 0) break;
    p += incr;
  }
  return p - start;
}

/** A growable byte buffer */
export class ByteSink {
  private chunks: Uint8Array[] = [];
  private size = 0;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.size += bytes.length;
  }

  text(s: string): void {
    this.push(encoder.encode(s));
  }

  get length(): number {
    return this.size;
  }

  bytes(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [out];
    return out;
  }
}

/**
 * The hunk header as git prints it (`xdl_format_hunk_hdr`, then `diff.c`'s
 * `sane_truncate_line`: the header cut at the first byte that is not valid UTF-8).
 */
export function formatHunkHeader(hunk: EmittedHunk): Uint8Array {
  const range = (start: number, count: number) => (count !== 1 ? `${start},${count}` : `${start}`);
  const head = encoder.encode(
    `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`,
  );
  const buf = new Uint8Array(128);
  buf.set(head);
  let nb = head.length;
  if (hunk.func.length > 0) {
    buf[nb++] = 0x20;
    let funclen = hunk.func.length;
    if (funclen > 128 - nb - 1) funclen = 128 - nb - 1;
    buf.set(hunk.func.subarray(0, funclen), nb);
    nb += funclen;
  }
  buf[nb++] = 0x0a;
  const valid = saneUtf8Length(buf, 0, nb);
  if (valid === nb) return buf.slice(0, nb);
  const out = new Uint8Array(valid + 1);
  out.set(buf.subarray(0, valid));
  out[valid] = 0x0a;
  return out;
}

/** Writes hunks as git prints them: headers, lines, and the "\ No newline" marker */
export function writeHunks(sink: ByteSink, result: UnifiedDiffResult): void {
  for (const hunk of result.hunks) {
    sink.push(formatHunkHeader(hunk));
    for (const line of hunk.lines) {
      const lines = line.kind === "-" ? result.old : result.new;
      const rec = lines.line(line.index);
      sink.push(line.kind === " " ? SPACE : line.kind === "-" ? MINUS : PLUS);
      sink.push(rec);
      if (rec.length > 0 && rec[rec.length - 1] !== 0x0a) sink.push(NO_NEWLINE);
    }
  }
}

const SPACE = encoder.encode(" ");
const MINUS = encoder.encode("-");
const PLUS = encoder.encode("+");

/**
 * The body of the unified diff of two files (hunk headers and lines, no file headers), as
 * `git diff` prints it.
 */
export function unifiedDiff(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  options: UnifiedDiffOptions = {},
): Uint8Array {
  const sink = new ByteSink();
  writeHunks(sink, unifiedDiffHunks(oldContent, newContent, options));
  return sink.bytes();
}

/**
 * Lines added and removed, as git's diffstat counts them: the `+` and `-` lines of the
 * diff with the same options (context matters only with `--ignore-blank-lines`).
 */
export function diffLineCounts(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  options: UnifiedDiffOptions = {},
): { added: number; deleted: number } {
  const { hunks } = unifiedDiffHunks(oldContent, newContent, {
    ...options,
    functionContext: false,
    findFunction: noFunc,
  });
  let added = 0;
  let deleted = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "+") added++;
      else if (l.kind === "-") deleted++;
    }
  }
  return { added, deleted };
}

const noFunc: FindFunction = () => undefined;
