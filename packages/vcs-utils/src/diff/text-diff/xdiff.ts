/**
 * A port of git's xdiff line diff (`xdiff/xprepare.c`, `xdiff/xdiffi.c`), so that a diff, and a
 * merge built on it, finds the same changes as git does, line for line.
 *
 * @example
 * ```ts
 * const changes = xdiff(new ByteLines(before), new ByteLines(after), { algorithm: "histogram" });
 * // [{ i1: 3, chg1: 1, i2: 3, chg2: 2 }]: line 3 of `before` became lines 3 and 4 of `after`
 * ```
 *
 * The parts follow xdiff closely. Lines are first classified: equal lines (byte for byte, the
 * terminator included) share a class number, numbered in order of first appearance. For Myers,
 * the common head and tail are trimmed, and lines of one side with no match on the other are
 * set aside as changed before the search, as are lines with many matches that sit in a run of
 * unmatched ones (`xdl_cleanup_records`). The search is Myers' O(ND) middle-snake bisection with
 * xdiff's cost cutoff (`xdl_split`): once the edit cost passes the square root of the input
 * size, the furthest reaching path is taken, which keeps big inputs near linear. Histogram and
 * patience run on all lines and fall back to Myers for regions they cannot anchor. The changed
 * groups are finally slid as `xdl_change_compact` slides them (with the indent heuristic when
 * asked), which is where equal answers of different shapes become git's answer.
 *
 * @module
 */

import type { ByteLines } from "./byte-lines.js";
import { histogramDiff } from "./xdiff-histogram.js";
import { patienceDiff } from "./xdiff-patience.js";

/** git's diff algorithms (`diff.algorithm`, `--diff-algorithm`) */
export type XdiffAlgorithm = "myers" | "minimal" | "patience" | "histogram";

/** Options of {@link xdiff}. */
export interface XdiffOptions {
  /** Diff algorithm (default `myers`, as `git diff`) */
  algorithm?: XdiffAlgorithm;
  /** Slide changes to the place the indentation suggests (`diff.indentHeuristic`, default off) */
  indentHeuristic?: boolean;
  /**
   * Diff a histogram change group again after sliding joined it with another, as git 2.54
   * and later do (default true; false gives the diff of older git)
   */
  histogramRediff?: boolean;
}

/**
 * One change, as xdiff's `xdchange_t`: lines `[i1, i1 + chg1)` of the first file were replaced
 * by lines `[i2, i2 + chg2)` of the second.
 */
export interface XdiffChange {
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

/**
 * Lines `[from, from + nrec)` of a file as xdiff prepares them (`xdfile_t`). Record `i` is
 * line `from + i`. `changed[i + 1]` marks record `i` as changed, with a false sentinel on
 * both ends.
 */
export interface XdFile {
  lines: ByteLines;
  from: number;
  nrec: number;
  /** Class of each record: equal lines, equal classes */
  ha: Int32Array;
  changed: Uint8Array;
  /** The records Myers compares, after the discarding */
  rindex: Int32Array;
  nreff: number;
  dstart: number;
  dend: number;
}

/** Two prepared files (`xdfenv_t`) */
export interface XdEnv {
  xdf1: XdFile;
  xdf2: XdFile;
}

/** Internal flags: the algorithm and the indent heuristic */
export interface XdFlags {
  algorithm: XdiffAlgorithm;
  indentHeuristic: boolean;
  /** git >= 2.54: a histogram group joined while sliding is diffed again */
  histogramRediff?: boolean;
}

const XDL_KPDIS_RUN = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;
const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_LINE_MAX = 0x7fffffff;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;

const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

/** xdiff's `xdl_bogosqrt`: a power of two near the square root */
export function xdlBogosqrt(n: number): number {
  let i = 1;
  for (let v = n; v > 0; v = Math.floor(v / 4)) i *= 2;
  return i;
}

/** xdiff's `xdl_classify_record` over two files: each line's class, and counts per class */
function classify(
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
): { ha1: Int32Array; ha2: Int32Array; len1: number[]; len2: number[] } {
  const ha1 = new Int32Array(n1);
  const ha2 = new Int32Array(n2);
  const heads = new Map<number, number>();
  const repLines: ByteLines[] = [];
  const repIdx: number[] = [];
  const next: number[] = [];
  const len1: number[] = [];
  const len2: number[] = [];
  const pass = (lines: ByteLines, from: number, n: number, ha: Int32Array, first: boolean) => {
    for (let i = 0; i < n; i++) {
      const li = from + i;
      const h = lines.hash(li);
      const head = heads.get(h);
      let c = head ?? -1;
      while (c >= 0 && !repLines[c].lineEquals(repIdx[c], lines, li)) c = next[c];
      if (c < 0) {
        c = repLines.length;
        repLines.push(lines);
        repIdx.push(li);
        next.push(head ?? -1);
        len1.push(0);
        len2.push(0);
        heads.set(h, c);
      }
      if (first) len1[c]++;
      else len2[c]++;
      ha[i] = c;
    }
  };
  pass(l1, from1, n1, ha1, true);
  pass(l2, from2, n2, ha2, false);
  return { ha1, ha2, len1, len2 };
}

function newFile(lines: ByteLines, from: number, nrec: number, ha: Int32Array): XdFile {
  return {
    lines,
    from,
    nrec,
    ha,
    changed: new Uint8Array(nrec + 2),
    rindex: new Int32Array(0),
    nreff: 0,
    dstart: 0,
    dend: nrec - 1,
  };
}

/** xdiff's `xdl_clean_mmatch`: whether a many-match line sits in a run of unmatched lines */
function cleanMmatch(action: Uint8Array, i: number, len: number): boolean {
  let s = 0;
  let e = len - 1;
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW;
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW;
  let rdis0 = 0;
  let rpdis0 = 1;
  for (let r = 1; i - r >= s; r++) {
    const a = action[i - r];
    if (a === DISCARD) rdis0++;
    else if (a === INVESTIGATE) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (let r = 1; i + r <= e; r++) {
    const a = action[i + r];
    if (a === DISCARD) rdis1++;
    else if (a === INVESTIGATE) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;
  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1;
}

/** xdiff's `xdl_cleanup_records`: lines with no match, and some with many, set aside */
function cleanupRecords(
  xdf1: XdFile,
  xdf2: XdFile,
  len1c: number[],
  len2c: number[],
  needMin: boolean,
): void {
  const off = xdf1.dstart;
  const len1 = Math.max(0, xdf1.dend - off + 1);
  const len2 = Math.max(0, xdf2.dend - off + 1);
  const action1 = new Uint8Array(len1);
  const action2 = new Uint8Array(len2);
  let mlim1 = Number.MAX_SAFE_INTEGER;
  let mlim2 = Number.MAX_SAFE_INTEGER;
  if (!needMin) {
    mlim1 = Math.min(xdlBogosqrt(xdf1.nrec), XDL_MAX_EQLIMIT);
    mlim2 = Math.min(xdlBogosqrt(xdf2.nrec), XDL_MAX_EQLIMIT);
  }
  for (let i = 0; i < len1; i++) {
    const nm = len2c[xdf1.ha[i + off]];
    action1[i] = nm === 0 ? DISCARD : nm < mlim1 ? KEEP : INVESTIGATE;
  }
  for (let i = 0; i < len2; i++) {
    const nm = len1c[xdf2.ha[i + off]];
    action2[i] = nm === 0 ? DISCARD : nm < mlim2 ? KEEP : INVESTIGATE;
  }
  const keep = (xdf: XdFile, action: Uint8Array, len: number) => {
    const rindex = new Int32Array(len);
    let nreff = 0;
    for (let i = 0; i < len; i++) {
      let a = action[i];
      if (a === INVESTIGATE) a = cleanMmatch(action, i, len) ? DISCARD : KEEP;
      if (a === KEEP) rindex[nreff++] = i + off;
      else xdf.changed[i + off + 1] = 1;
    }
    xdf.rindex = rindex;
    xdf.nreff = nreff;
  };
  keep(xdf1, action1, len1);
  keep(xdf2, action2, len2);
}

/** xdiff's `xdl_trim_ends`: the common head and tail left out of the search */
function trimEnds(xdf1: XdFile, xdf2: XdFile): void {
  const lim = Math.min(xdf1.nrec, xdf2.nrec);
  let i = 0;
  while (i < lim && xdf1.ha[i] === xdf2.ha[i]) i++;
  xdf1.dstart = xdf2.dstart = i;
  const rest = lim - i;
  let j = 0;
  while (j < rest && xdf1.ha[xdf1.nrec - 1 - j] === xdf2.ha[xdf2.nrec - 1 - j]) j++;
  xdf1.dend = xdf1.nrec - j - 1;
  xdf2.dend = xdf2.nrec - j - 1;
}

/** xdiff's `xdl_prepare_env` over line ranges of two files */
export function prepareEnv(
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
  flags: XdFlags,
): XdEnv {
  const { ha1, ha2, len1, len2 } = classify(l1, from1, n1, l2, from2, n2);
  const xdf1 = newFile(l1, from1, n1, ha1);
  const xdf2 = newFile(l2, from2, n2, ha2);
  if (flags.algorithm !== "patience" && flags.algorithm !== "histogram") {
    trimEnds(xdf1, xdf2);
    cleanupRecords(xdf1, xdf2, len1, len2, flags.algorithm === "minimal");
  }
  return { xdf1, xdf2 };
}

interface Split {
  i1: number;
  i2: number;
  minLo: boolean;
  minHi: boolean;
}

/** xdiff's `xdl_split`: the middle snake of a box, or a good enough point past the cost limit */
function split(
  h1: Int32Array,
  off1: number,
  lim1: number,
  h2: Int32Array,
  off2: number,
  lim2: number,
  kv: Int32Array,
  fb: number,
  bb: number,
  needMin: boolean,
  mxcost: number,
  spl: Split,
): void {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = (fmid - bmid) & 1;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;
  let i1: number;
  let i2: number;
  kv[fb + fmid] = off1;
  kv[bb + bmid] = lim1;
  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    if (fmin > dmin) kv[fb + --fmin - 1] = -1;
    else ++fmin;
    if (fmax < dmax) kv[fb + ++fmax + 1] = -1;
    else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      if (kv[fb + d - 1] >= kv[fb + d + 1]) i1 = kv[fb + d - 1] + 1;
      else i1 = kv[fb + d + 1];
      const prev1 = i1;
      i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && h1[i1] === h2[i2]; i1++, i2++);
      if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = true;
      kv[fb + d] = i1;
      if (odd && bmin <= d && d <= bmax && kv[bb + d] <= i1) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }
    if (bmin > dmin) kv[bb + --bmin - 1] = XDL_LINE_MAX;
    else ++bmin;
    if (bmax < dmax) kv[bb + ++bmax + 1] = XDL_LINE_MAX;
    else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      if (kv[bb + d - 1] < kv[bb + d + 1]) i1 = kv[bb + d - 1];
      else i1 = kv[bb + d + 1] - 1;
      const prev1 = i1;
      i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && h1[i1 - 1] === h2[i2 - 1]; i1--, i2--);
      if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = true;
      kv[bb + d] = i1;
      if (!odd && fmin <= d && d <= fmax && i1 <= kv[fb + d]) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }
    if (needMin) continue;

    if (gotSnake && ec > XDL_HEUR_MIN_COST) {
      let best = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        i1 = kv[fb + d];
        i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 + XDL_SNAKE_CNT <= i1 &&
          i1 < lim1 &&
          off2 + XDL_SNAKE_CNT <= i2 &&
          i2 < lim2
        ) {
          for (let k = 1; h1[i1 - k] === h2[i2 - k]; k++) {
            if (k === XDL_SNAKE_CNT) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = true;
        spl.minHi = false;
        return;
      }
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        i1 = kv[bb + d];
        i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 < i1 &&
          i1 <= lim1 - XDL_SNAKE_CNT &&
          off2 < i2 &&
          i2 <= lim2 - XDL_SNAKE_CNT
        ) {
          for (let k = 0; h1[i1 + k] === h2[i2 + k]; k++) {
            if (k === XDL_SNAKE_CNT - 1) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = false;
        spl.minHi = true;
        return;
      }
    }

    if (ec >= mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        i1 = Math.min(kv[fb + d], lim1);
        i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }
      let bbest = XDL_LINE_MAX;
      let bbest1 = XDL_LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        i1 = Math.max(off1, kv[bb + d]);
        i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        spl.i1 = fbest1;
        spl.i2 = fbest - fbest1;
        spl.minLo = true;
        spl.minHi = false;
      } else {
        spl.i1 = bbest1;
        spl.i2 = bbest - bbest1;
        spl.minLo = false;
        spl.minHi = true;
      }
      return;
    }
  }
}

/** xdiff's Myers part of `xdl_do_diff`: `xdl_recs_cmp` over the kept records */
function myersDiff(env: XdEnv, needMinimal: boolean): void {
  const { xdf1, xdf2 } = env;
  const n1 = xdf1.nreff;
  const n2 = xdf2.nreff;
  const h1 = new Int32Array(n1);
  const h2 = new Int32Array(n2);
  for (let i = 0; i < n1; i++) h1[i] = xdf1.ha[xdf1.rindex[i]];
  for (let i = 0; i < n2; i++) h2[i] = xdf2.ha[xdf2.rindex[i]];
  const ndiags = n1 + n2 + 3;
  const kv = new Int32Array(2 * ndiags + 2);
  const fb = n2 + 1;
  const bb = ndiags + n2 + 1;
  const mxcost = Math.max(xdlBogosqrt(ndiags), XDL_MAX_COST_MIN);
  const spl: Split = { i1: 0, i2: 0, minLo: false, minHi: false };
  // xdl_recs_cmp, its recursion on a stack: [off1, lim1, off2, lim2, needMin]
  const stack: number[] = [0, n1, 0, n2, needMinimal ? 1 : 0];
  while (stack.length > 0) {
    const needMin = stack.pop() === 1;
    let lim2 = stack.pop() as number;
    let off2 = stack.pop() as number;
    let lim1 = stack.pop() as number;
    let off1 = stack.pop() as number;
    for (; off1 < lim1 && off2 < lim2 && h1[off1] === h2[off2]; off1++, off2++);
    for (; off1 < lim1 && off2 < lim2 && h1[lim1 - 1] === h2[lim2 - 1]; lim1--, lim2--);
    if (off1 === lim1) {
      for (; off2 < lim2; off2++) xdf2.changed[xdf2.rindex[off2] + 1] = 1;
    } else if (off2 === lim2) {
      for (; off1 < lim1; off1++) xdf1.changed[xdf1.rindex[off1] + 1] = 1;
    } else {
      spl.i1 = spl.i2 = 0;
      split(h1, off1, lim1, h2, off2, lim2, kv, fb, bb, needMin, mxcost, spl);
      const { i1, i2, minLo, minHi } = spl;
      stack.push(i1, lim1, i2, lim2, minHi ? 1 : 0);
      stack.push(off1, i1, off2, i2, minLo ? 1 : 0);
    }
  }
}

/**
 * xdiff's `xdl_fall_back_diff`: Myers over lines `[line1, line1 + count1)` of `a` and
 * `[line2, line2 + count2)` of `b` (1-based record numbers), as files of their own.
 */
export function fallBackDiff(
  a: XdFile,
  line1: number,
  count1: number,
  b: XdFile,
  line2: number,
  count2: number,
  flags: XdFlags,
): void {
  const sub = doDiff(a.lines, a.from + line1 - 1, count1, b.lines, b.from + line2 - 1, count2, {
    algorithm: "myers",
    indentHeuristic: flags.indentHeuristic,
  });
  a.changed.set(sub.xdf1.changed.subarray(1, 1 + count1), line1);
  b.changed.set(sub.xdf2.changed.subarray(1, 1 + count2), line2);
}

/** xdiff's `xdl_do_diff` over line ranges of two files: the changed lines marked */
export function doDiff(
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
  flags: XdFlags,
): XdEnv {
  const env = prepareEnv(l1, from1, n1, l2, from2, n2, flags);
  if (flags.algorithm === "patience") patienceDiff(env, flags, fallBackDiff);
  else if (flags.algorithm === "histogram") histogramDiff(env, flags, fallBackDiff);
  else myersDiff(env, flags.algorithm === "minimal");
  return env;
}

// --- xdl_change_compact -------------------------------------------------------------------

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

/** xdiff's `get_indent`: TAB counts to the next multiple of 8; -1 for a blank line */
function getIndent(xdf: XdFile, rec: number): number {
  const lines = xdf.lines;
  const li = xdf.from + rec;
  const c = lines.content;
  let ret = 0;
  for (let p = lines.start(li), end = lines.start(li + 1); p < end; p++) {
    const ch = c[p];
    // git's isspace: space, TAB, LF, CR
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) return ret;
    if (ch === 0x20) ret += 1;
    else if (ch === 0x09) ret += 8 - (ret % 8);
    if (ret >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

interface SplitMeasurement {
  endOfFile: boolean;
  indent: number;
  preBlank: number;
  preIndent: number;
  postBlank: number;
  postIndent: number;
}

function measureSplit(xdf: XdFile, at: number): SplitMeasurement {
  const m: SplitMeasurement = {
    endOfFile: at >= xdf.nrec,
    indent: at >= xdf.nrec ? -1 : getIndent(xdf, at),
    preBlank: 0,
    preIndent: -1,
    postBlank: 0,
    postIndent: -1,
  };
  for (let i = at - 1; i >= 0; i--) {
    m.preIndent = getIndent(xdf, i);
    if (m.preIndent !== -1) break;
    m.preBlank += 1;
    if (m.preBlank === MAX_BLANKS) {
      m.preIndent = 0;
      break;
    }
  }
  for (let i = at + 1; i < xdf.nrec; i++) {
    m.postIndent = getIndent(xdf, i);
    if (m.postIndent !== -1) break;
    m.postBlank += 1;
    if (m.postBlank === MAX_BLANKS) {
      m.postIndent = 0;
      break;
    }
  }
  return m;
}

function scoreAddSplit(m: SplitMeasurement, s: { effectiveIndent: number; penalty: number }): void {
  if (m.preIndent === -1 && m.preBlank === 0) s.penalty += START_OF_FILE_PENALTY;
  if (m.endOfFile) s.penalty += END_OF_FILE_PENALTY;
  const postBlank = m.indent === -1 ? 1 + m.postBlank : 0;
  const totalBlank = m.preBlank + postBlank;
  s.penalty += TOTAL_BLANK_WEIGHT * totalBlank;
  s.penalty += POST_BLANK_WEIGHT * postBlank;
  const indent = m.indent !== -1 ? m.indent : m.postIndent;
  const anyBlanks = totalBlank !== 0;
  s.effectiveIndent += indent;
  if (indent === -1 || m.preIndent === -1) {
    // no adjustment
  } else if (indent > m.preIndent) {
    s.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
  } else if (indent === m.preIndent) {
    // no adjustment
  } else if (m.postIndent !== -1 && m.postIndent > indent) {
    s.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
  } else {
    s.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
  }
}

function scoreCmp(
  s1: { effectiveIndent: number; penalty: number },
  s2: { effectiveIndent: number; penalty: number },
): number {
  const cmpIndents =
    (s1.effectiveIndent > s2.effectiveIndent ? 1 : 0) -
    (s1.effectiveIndent < s2.effectiveIndent ? 1 : 0);
  return INDENT_WEIGHT * cmpIndents + (s1.penalty - s2.penalty);
}

/** A group of changed lines `[start, end)` (`struct xdlgroup`) */
interface Group {
  start: number;
  end: number;
}

// `changed[i + 1]` is record i: the helpers below read `ch(i)` as xdiff reads `changed[i]`

function groupInit(xdf: XdFile, g: Group): void {
  g.start = g.end = 0;
  while (xdf.changed[g.end + 1]) g.end++;
}

function groupNext(xdf: XdFile, g: Group): boolean {
  if (g.end === xdf.nrec) return false;
  g.start = g.end + 1;
  for (g.end = g.start; xdf.changed[g.end + 1]; g.end++);
  return true;
}

function groupPrevious(xdf: XdFile, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; xdf.changed[g.start]; g.start--);
  return true;
}

function groupSlideDown(xdf: XdFile, g: Group): boolean {
  if (g.end < xdf.nrec && xdf.ha[g.start] === xdf.ha[g.end]) {
    xdf.changed[g.start++ + 1] = 0;
    xdf.changed[g.end++ + 1] = 1;
    while (xdf.changed[g.end + 1]) g.end++;
    return true;
  }
  return false;
}

function groupSlideUp(xdf: XdFile, g: Group): boolean {
  if (g.start > 0 && xdf.ha[g.start - 1] === xdf.ha[g.end - 1]) {
    xdf.changed[--g.start + 1] = 1;
    xdf.changed[--g.end + 1] = 0;
    while (xdf.changed[g.start]) g.start--;
    return true;
  }
  return false;
}

function bug(what: string): never {
  throw new Error(`xdiff: ${what}`);
}

/** xdiff's `xdl_change_compact`: changed groups slid up and down to git's place */
export function changeCompact(xdf: XdFile, xdfo: XdFile, flags: XdFlags): void {
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  groupInit(xdf, g);
  groupInit(xdfo, go);
  for (;;) {
    if (g.end !== g.start) {
      const origStart = g.start;
      const origEnd = g.end;
      let groupsize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;
        while (groupSlideUp(xdf, g)) {
          if (!groupPrevious(xdfo, go)) bug("group sync broken sliding up");
        }
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!groupSlideDown(xdf, g)) break;
          if (!groupNext(xdfo, go)) bug("group sync broken sliding down");
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== g.end - g.start);

      if (g.end === earliestEnd) {
        // no shifting was possible
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(xdf, g)) bug("match disappeared");
          if (!groupPrevious(xdfo, go)) bug("group sync broken sliding to match");
        }
      } else if (flags.indentHeuristic) {
        let shift = earliestEnd;
        if (g.end - groupsize - 1 > shift) shift = g.end - groupsize - 1;
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) {
          shift = g.end - INDENT_HEURISTIC_MAX_SLIDING;
        }
        let bestShift = -1;
        const bestScore = { effectiveIndent: 0, penalty: 0 };
        for (; shift <= g.end; shift++) {
          const score = { effectiveIndent: 0, penalty: 0 };
          scoreAddSplit(measureSplit(xdf, shift), score);
          scoreAddSplit(measureSplit(xdf, shift - groupsize), score);
          if (bestShift === -1 || scoreCmp(score, bestScore) <= 0) {
            bestScore.effectiveIndent = score.effectiveIndent;
            bestScore.penalty = score.penalty;
            bestShift = shift;
          }
        }
        while (g.end > bestShift) {
          if (!groupSlideUp(xdf, g)) bug("best shift unreached");
          if (!groupPrevious(xdfo, go)) bug("group sync broken sliding to blank line");
        }
      }

      // git >= 2.54: a group joined while sliding is diffed again with Myers
      if (
        go.end !== go.start &&
        flags.algorithm === "histogram" &&
        flags.histogramRediff !== false &&
        (g.start !== origStart || g.end !== origEnd)
      ) {
        fallBackDiff(xdf, g.start + 1, g.end - g.start, xdfo, go.start + 1, go.end - go.start, {
          algorithm: "myers",
          indentHeuristic: flags.indentHeuristic,
        });
      }
    }
    if (!groupNext(xdf, g)) break;
    if (!groupNext(xdfo, go)) bug("group sync broken moving to next group");
  }
  if (groupNext(xdfo, go)) bug("group sync broken at end of file");
}

/** xdiff's `xdl_build_script`: the changed lines as changes, in order */
export function buildScript(env: XdEnv): XdiffChange[] {
  const c1 = env.xdf1.changed;
  const c2 = env.xdf2.changed;
  const out: XdiffChange[] = [];
  // c[i] is xdiff's changed[i - 1]
  for (let i1 = env.xdf1.nrec, i2 = env.xdf2.nrec; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (c1[i1] || c2[i2]) {
      const l1 = i1;
      const l2 = i2;
      for (; c1[i1]; i1--);
      for (; c2[i2]; i2--);
      out.push({ i1, chg1: l1 - i1, i2, chg2: l2 - i2 });
    }
  }
  return out.reverse();
}

/** `xdl_do_diff`, both `xdl_change_compact` passes and `xdl_build_script` */
export function diffScript(
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
  flags: XdFlags,
): XdiffChange[] {
  const env = doDiff(l1, from1, n1, l2, from2, n2, flags);
  changeCompact(env.xdf1, env.xdf2, flags);
  changeCompact(env.xdf2, env.xdf1, flags);
  return buildScript(env);
}

/**
 * The changes between two files, line by line, as git's xdiff finds them.
 */
export function xdiff(a: ByteLines, b: ByteLines, options: XdiffOptions = {}): XdiffChange[] {
  return diffScript(a, 0, a.size(), b, 0, b.size(), {
    algorithm: options.algorithm ?? "myers",
    indentHeuristic: options.indentHeuristic ?? false,
    histogramRediff: options.histogramRediff ?? true,
  });
}
