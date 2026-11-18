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
import type { LineInterner } from "./line-interner.js";
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
  /**
   * Set aside lines with many matches before a minimal diff too, as git before 2.5x did
   * (default false: newer git keeps them, and finds the minimal diff)
   */
  legacyMinimal?: boolean;
  /** Ignore whitespace when comparing lines (`-w`, `XDF_IGNORE_WHITESPACE`) */
  ignoreWhitespace?: boolean;
  /** Ignore changes in amount of whitespace (`-b`, `XDF_IGNORE_WHITESPACE_CHANGE`) */
  ignoreWhitespaceChange?: boolean;
  /** Ignore whitespace at end of line (`--ignore-space-at-eol`) */
  ignoreWhitespaceAtEol?: boolean;
  /** Ignore a carriage return at the end of line (`--ignore-cr-at-eol`) */
  ignoreCrAtEol?: boolean;
  /**
   * Numbers lines across calls: lines interned once are sorted into classes without
   * comparing their bytes again (used when its whitespace flags are the diff's)
   */
  interner?: LineInterner;
}

/** xdiff's `XDF_IGNORE_WHITESPACE` */
export const XDF_IGNORE_WHITESPACE = 1 << 1;
/** xdiff's `XDF_IGNORE_WHITESPACE_CHANGE` */
export const XDF_IGNORE_WHITESPACE_CHANGE = 1 << 2;
/** xdiff's `XDF_IGNORE_WHITESPACE_AT_EOL` */
export const XDF_IGNORE_WHITESPACE_AT_EOL = 1 << 3;
/** xdiff's `XDF_IGNORE_CR_AT_EOL` */
export const XDF_IGNORE_CR_AT_EOL = 1 << 4;
/** xdiff's `XDF_WHITESPACE_FLAGS` */
export const XDF_WHITESPACE_FLAGS =
  XDF_IGNORE_WHITESPACE |
  XDF_IGNORE_WHITESPACE_CHANGE |
  XDF_IGNORE_WHITESPACE_AT_EOL |
  XDF_IGNORE_CR_AT_EOL;

/** The `XDF_*` whitespace bits of {@link XdiffOptions} */
export function whitespaceFlags(options: XdiffOptions): number {
  return (
    (options.ignoreWhitespace ? XDF_IGNORE_WHITESPACE : 0) |
    (options.ignoreWhitespaceChange ? XDF_IGNORE_WHITESPACE_CHANGE : 0) |
    (options.ignoreWhitespaceAtEol ? XDF_IGNORE_WHITESPACE_AT_EOL : 0) |
    (options.ignoreCrAtEol ? XDF_IGNORE_CR_AT_EOL : 0)
  );
}

/** The `isspace` of git (`sane_ctype`): space, TAB, LF and CR only */
export function xdlIsSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** xdiff's `ends_with_optional_cr`: only an optional CR left before the LF */
function endsWithOptionalCr(l: Uint8Array, s0: number, s: number, i: number): boolean {
  const complete = s > s0 && l[s - 1] === 0x0a;
  let end = s;
  if (complete) end--;
  if (end === i) return true;
  return complete && end === i + 1 && l[i] === 0x0d;
}

/**
 * xdiff's `xdl_recmatch`: whether bytes `[a0, a1)` of `l1` and `[b0, b1)` of `l2` are equal
 * lines under the whitespace `flags`.
 */
export function xdlRecmatch(
  l1: Uint8Array,
  a0: number,
  a1: number,
  l2: Uint8Array,
  b0: number,
  b1: number,
  flags: number,
): boolean {
  if (a1 - a0 === b1 - b0) {
    let k = 0;
    const n = a1 - a0;
    while (k < n && l1[a0 + k] === l2[b0 + k]) k++;
    if (k === n) return true;
  }
  if (!(flags & XDF_WHITESPACE_FLAGS)) return false;
  let i1 = a0;
  let i2 = b0;
  if (flags & XDF_IGNORE_WHITESPACE) {
    for (;;) {
      while (i1 < a1 && xdlIsSpace(l1[i1])) i1++;
      while (i2 < b1 && xdlIsSpace(l2[i2])) i2++;
      if (!(i1 < a1 && i2 < b1)) break;
      if (l1[i1++] !== l2[i2++]) return false;
    }
  } else if (flags & XDF_IGNORE_WHITESPACE_CHANGE) {
    while (i1 < a1 && i2 < b1) {
      if (xdlIsSpace(l1[i1]) && xdlIsSpace(l2[i2])) {
        while (i1 < a1 && xdlIsSpace(l1[i1])) i1++;
        while (i2 < b1 && xdlIsSpace(l2[i2])) i2++;
        continue;
      }
      if (l1[i1++] !== l2[i2++]) return false;
    }
  } else if (flags & XDF_IGNORE_WHITESPACE_AT_EOL) {
    while (i1 < a1 && i2 < b1 && l1[i1] === l2[i2]) {
      i1++;
      i2++;
    }
  } else if (flags & XDF_IGNORE_CR_AT_EOL) {
    while (i1 < a1 && i2 < b1 && l1[i1] === l2[i2]) {
      i1++;
      i2++;
    }
    return endsWithOptionalCr(l1, a0, a1, i1) && endsWithOptionalCr(l2, b0, b1, i2);
  }
  if (i1 < a1) {
    while (i1 < a1 && xdlIsSpace(l1[i1])) i1++;
    if (a1 !== i1) return false;
  }
  if (i2 < b1) {
    while (i2 < b1 && xdlIsSpace(l2[i2])) i2++;
    return b1 === i2;
  }
  return true;
}

/**
 * xdiff's `xdl_hash_record_with_whitespace` (32-bit): equal hashes for lines
 * {@link xdlRecmatch} finds equal under `flags`.
 */
export function xdlHashRecord(c: Uint8Array, start: number, top: number, flags: number): number {
  let ha = 5381;
  const crAtEolOnly = (flags & XDF_WHITESPACE_FLAGS) === XDF_IGNORE_CR_AT_EOL;
  for (let ptr = start; ptr < top && c[ptr] !== 0x0a; ptr++) {
    if (crAtEolOnly) {
      if (c[ptr] === 0x0d && ptr + 1 < top && c[ptr + 1] === 0x0a) continue;
    } else if (xdlIsSpace(c[ptr])) {
      const ptr2 = ptr;
      while (ptr + 1 < top && xdlIsSpace(c[ptr + 1]) && c[ptr + 1] !== 0x0a) ptr++;
      const atEol = top <= ptr + 1 || c[ptr + 1] === 0x0a;
      if (flags & XDF_IGNORE_WHITESPACE) {
        // already handled
      } else if (flags & XDF_IGNORE_WHITESPACE_CHANGE && !atEol) {
        ha = (Math.imul(ha, 33) ^ 0x20) | 0;
      } else if (flags & XDF_IGNORE_WHITESPACE_AT_EOL && !atEol) {
        for (let p = ptr2; p !== ptr + 1; p++) ha = (Math.imul(ha, 33) ^ c[p]) | 0;
      }
      continue;
    }
    ha = (Math.imul(ha, 33) ^ c[ptr]) | 0;
  }
  return ha;
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
  /** git before 2.5x: minimal also sets aside lines with many matches */
  legacyMinimal?: boolean;
  /** `XDF_*` whitespace bits: lines equal under them share a class */
  whitespace?: number;
  /** Line numbers shared across calls (see {@link XdiffOptions.interner}) */
  interner?: LineInterner;
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
  ws = 0,
  interner?: LineInterner,
): { ha1: Int32Array; ha2: Int32Array; len1: Int32Array; len2: Int32Array } {
  if (interner && interner.whitespace === ws) {
    return classifyInterned(interner, l1, from1, n1, l2, from2, n2);
  }
  const ha1 = new Int32Array(n1);
  const ha2 = new Int32Array(n2);
  // classes are numbered by first appearance, as xdiff numbers its records; a class is found
  // through an open-addressing table on the line hash (equal lines hash alike)
  const max = n1 + n2;
  let bits = 4;
  while (1 << bits < max * 2) bits++;
  const mask = (1 << bits) - 1;
  const table = new Int32Array(1 << bits).fill(-1);
  const clsHash = new Int32Array(max);
  const repFile = new Uint8Array(max);
  const repIdx = new Int32Array(max);
  const len1 = new Int32Array(max);
  const len2 = new Int32Array(max);
  // the lines the files share byte for byte at their start and end: a line of the second
  // file there has the class of its twin in the first, which is classified already (and no
  // class is new there, so the numbering is the one of a full scan)
  const { head, tail } = ws === 0 ? sharedEnds(l1, from1, n1, l2, from2, n2) : NO_SHARED;
  let classes = 0;
  const w1 = wordsOf(l1.content);
  const w2 = wordsOf(l2.content);
  for (let f = 0; f < 2; f++) {
    const lines = f === 0 ? l1 : l2;
    const wf = f === 0 ? w1 : w2;
    const from = f === 0 ? from1 : from2;
    const n = f === 0 ? n1 : n2;
    const ha = f === 0 ? ha1 : ha2;
    const counts = f === 0 ? len1 : len2;
    const bytes = lines.content;
    const starts = lines.lineStarts;
    // all of a file's hashes, kept with its lines for its next diff
    const hashes = ws ? undefined : lines.lineHashes;
    let i = 0;
    let to = n;
    if (f === 1) {
      for (; i < head; i++) {
        const c = ha1[i];
        counts[c]++;
        ha[i] = c;
      }
      to = n - tail;
      for (let k = to; k < n; k++) {
        const c = ha1[k - n + n1];
        counts[c]++;
        ha[k] = c;
      }
    }
    for (; i < to; i++) {
      const li = from + i;
      const b0 = starts[li];
      const b1 = starts[li + 1];
      let h: number;
      if (hashes) h = hashes[li];
      else h = xdlHashRecord(bytes, b0, b1, ws);
      let slot = Math.imul(h, 0x9e3779b1) >>> (32 - bits);
      let c = table[slot];
      while (c >= 0) {
        if (clsHash[c] === h) {
          const r = repFile[c] === 0 ? l1 : l2;
          const rs = r.lineStarts;
          const ri = repIdx[c];
          if (ws) {
            if (xdlRecmatch(r.content, rs[ri], rs[ri + 1], bytes, b0, b1, ws)) break;
          } else if (
            rs[ri + 1] - rs[ri] === b1 - b0 &&
            commonPrefix(r.content, repFile[c] === 0 ? w1 : w2, rs[ri], bytes, wf, b0, b1 - b0) ===
              b1 - b0
          ) {
            break;
          }
        }
        slot = (slot + 1) & mask;
        c = table[slot];
      }
      if (c < 0) {
        c = classes++;
        table[slot] = c;
        clsHash[c] = h;
        repFile[c] = f;
        repIdx[c] = li;
      }
      counts[c]++;
      ha[i] = c;
    }
  }
  return { ha1, ha2, len1, len2 };
}

const NO_SHARED = { head: 0, tail: 0 };

/** A buffer as 32-bit words (unaligned reads) */
function wordsOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * How many of the `max` bytes at `a[i..]` and `b[j..]` are the same, from the start; `da`
 * and `db` are the buffers' {@link wordsOf}.
 */
function commonPrefix(
  a: Uint8Array,
  da: DataView,
  i: number,
  b: Uint8Array,
  db: DataView,
  j: number,
  max: number,
): number {
  let p = 0;
  if (max >= 16) {
    // four bytes at a time
    while (p + 4 <= max && da.getInt32(i + p) === db.getInt32(j + p)) p += 4;
  }
  while (p < max && a[i + p] === b[j + p]) p++;
  return p;
}

/** How many of the `max` bytes before `a[end1]` and `b[end2]` are the same, from the end */
function commonSuffix(
  a: Uint8Array,
  da: DataView,
  end1: number,
  b: Uint8Array,
  db: DataView,
  end2: number,
  max: number,
): number {
  let q = 0;
  if (max >= 16) {
    while (q + 4 <= max && da.getInt32(end1 - q - 4) === db.getInt32(end2 - q - 4)) q += 4;
  }
  while (q < max && a[end1 - 1 - q] === b[end2 - 1 - q]) q++;
  return q;
}

/**
 * The lines two ranges share byte for byte at their start (`head`) and their end (`tail`),
 * each a whole line in both (an unterminated line only when it ends both ranges), the two
 * never overlapping in either range.
 */
function sharedEnds(
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
): { head: number; tail: number } {
  const s1 = l1.lineStarts;
  const s2 = l2.lineStarts;
  const c1 = l1.content;
  const c2 = l2.content;
  const a0 = s1[from1];
  const b0 = s2[from2];
  const len1 = s1[from1 + n1] - a0;
  const len2 = s2[from2 + n2] - b0;
  const min = len1 < len2 ? len1 : len2;
  const w1 = wordsOf(c1);
  const w2 = wordsOf(c2);
  const p = commonPrefix(c1, w1, a0, c2, w2, b0, min);
  // a line within the common bytes, ending in LF there, starts and ends alike in both
  let head = 0;
  while (head < n1 && head < n2) {
    const end = s1[from1 + head + 1] - a0;
    if (end > p || c1[a0 + end - 1] !== 0x0a) break;
    head++;
  }
  const headBytes = s1[from1 + head] - a0;
  const limit = min - headBytes;
  const q = commonSuffix(c1, w1, a0 + len1, c2, w2, b0 + len2, limit);
  // a line starting within the common bytes (its LF before it common too, or at the start
  // of the second range)
  let tail = 0;
  while (tail < n1 - head && tail < n2 - head) {
    const start = s1[from1 + n1 - 1 - tail] - a0;
    const other = start - len1 + len2;
    if (start < len1 - q) break;
    if (start === len1 - q && other > 0 && c2[b0 + other - 1] !== 0x0a) break;
    tail++;
  }
  return { head, tail };
}

/** {@link classify} by interned line ids: the same classes, numbered alike */
function classifyInterned(
  interner: LineInterner,
  l1: ByteLines,
  from1: number,
  n1: number,
  l2: ByteLines,
  from2: number,
  n2: number,
): { ha1: Int32Array; ha2: Int32Array; len1: Int32Array; len2: Int32Array } {
  const ids1 = interner.ids(l1);
  const ids2 = interner.ids(l2);
  const ha1 = new Int32Array(n1);
  const ha2 = new Int32Array(n2);
  const len1 = new Int32Array(n1 + n2);
  const len2 = new Int32Array(n1 + n2);
  const { stamps, local, generation } = interner.scratch();
  let classes = 0;
  for (let i = 0; i < n1; i++) {
    const id = ids1[from1 + i];
    let c: number;
    if (stamps[id] === generation) c = local[id];
    else {
      c = classes++;
      stamps[id] = generation;
      local[id] = c;
    }
    len1[c]++;
    ha1[i] = c;
  }
  for (let i = 0; i < n2; i++) {
    const id = ids2[from2 + i];
    let c: number;
    if (stamps[id] === generation) c = local[id];
    else {
      c = classes++;
      stamps[id] = generation;
      local[id] = c;
    }
    len2[c]++;
    ha2[i] = c;
  }
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
  len1c: Int32Array,
  len2c: Int32Array,
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
  const { ha1, ha2, len1, len2 } = classify(
    l1,
    from1,
    n1,
    l2,
    from2,
    n2,
    flags.whitespace ?? 0,
    flags.interner,
  );
  const xdf1 = newFile(l1, from1, n1, ha1);
  const xdf2 = newFile(l2, from2, n2, ha2);
  if (flags.algorithm !== "patience" && flags.algorithm !== "histogram") {
    trimEnds(xdf1, xdf2);
    cleanupRecords(xdf1, xdf2, len1, len2, flags.algorithm === "minimal" && !flags.legacyMinimal);
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
    whitespace: flags.whitespace,
    interner: flags.interner,
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
          whitespace: flags.whitespace,
          interner: flags.interner,
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
    legacyMinimal: options.legacyMinimal ?? false,
    whitespace: whitespaceFlags(options),
    interner: options.interner,
  });
}
