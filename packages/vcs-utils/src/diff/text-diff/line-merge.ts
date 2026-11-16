/**
 * A byte-preserving three-way line merge, as git's `xdl_merge` does it for a text file.
 *
 * Lines are split on LF only and keep their terminators, so CRLF files, a missing final newline
 * and any encoding (UTF-8 or not) come out byte for byte. Nothing is decoded. Changes that touch
 * or overlap in the base conflict unless both sides made the same change, and a conflict is
 * written with git's markers and labels, in the line ending the file uses.
 *
 * The conflicts are then refined as git's default (`XDL_MERGE_ZEALOUS`) merge refines them:
 * lines both sides share inside a conflict move out of it, and conflicts at most three lines
 * apart are joined. With the `diff3` style nothing is refined (git's `XDL_MERGE_EAGER`); with
 * `zdiff3` only the lines both sides share at the start and the end of a conflict move out.
 *
 * @module
 */

import { DEFAULT_ALGORITHM, getAlgorithm, type SupportedAlgorithm } from "./diff-algorithm.js";
import type { Edit } from "./edit.js";
import { Sequence, type SequenceComparator } from "./sequence.js";

/** The lines of a byte buffer: split after each LF, the terminator kept with its line. */
export class ByteLines extends Sequence {
  /** Start offsets of the lines, plus the content length as the last entry */
  private readonly starts: number[];

  constructor(readonly content: Uint8Array) {
    super();
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === 0x0a && i + 1 < content.length) starts.push(i + 1);
    }
    if (content.length === 0) starts.length = 0;
    starts.push(content.length);
    this.starts = starts;
  }

  size(): number {
    return this.starts.length - 1;
  }

  /** Line `i` with its terminator (a view of the content) */
  line(i: number): Uint8Array {
    return this.content.subarray(this.starts[i], this.starts[i + 1]);
  }

  /** Lines `[from, to)` with their terminators (a view of the content) */
  range(from: number, to: number): Uint8Array {
    return this.content.subarray(this.starts[from], this.starts[to]);
  }
}

/** Compares whole lines, terminators included: `a` and `a\n`, `a\n` and `a\r\n` differ. */
export const BYTE_LINES_COMPARATOR: SequenceComparator<ByteLines> = {
  equals(a, ai, b, bi) {
    return bytesEqual(a.line(ai), b.line(bi));
  },
  hash(seq, index) {
    const raw = seq.line(index);
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw[i]) | 0;
    return h;
  },
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * How a conflict is written (git's `merge.conflictStyle`): `merge` (ours and theirs),
 * `diff3` (the base too, unrefined) or `zdiff3` (the base too, shared lines moved out).
 */
export type ConflictStyle = "merge" | "diff3" | "zdiff3";

/** Options of {@link mergeLines}. */
export interface LineMergeOptions {
  /** Label after `<<<<<<<` (default `ours`) */
  oursLabel?: string;
  /** Label after `>>>>>>>` (default `theirs`) */
  theirsLabel?: string;
  /** Label after `|||||||` with the diff3 styles (none: the marker alone) */
  baseLabel?: string;
  /** Conflict style (default `merge`) */
  style?: ConflictStyle;
  /** Resolve each conflict to a side, as git's `-X ours`, `-X theirs` or `merge=union` */
  favor?: "ours" | "theirs" | "union";
  /** Length of the conflict markers (git's `conflict-marker-size`, default 7) */
  markerSize?: number;
  /** Diff algorithm (default: histogram) */
  algorithm?: SupportedAlgorithm;
}

/** What {@link mergeLines} produced. */
export interface LineMergeResult {
  /** The merged bytes: conflicts hold both sides between git's markers */
  content: Uint8Array;
  /** Number of conflicting regions (0: a clean merge) */
  conflicts: number;
}

/**
 * One region of the merge, as xdiff's `xdmerge_t`: lines `[i0, i0 + chg0)` of the base,
 * `[i1, i1 + chg1)` of ours, `[i2, i2 + chg2)` of theirs. Mode 0 is a conflict, 1 takes
 * ours, 2 theirs, 3 both (union), 4 both sides made the same change.
 */
interface Hunk {
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

/** xdiff's `xdl_append_merge`: a region that overlaps the last one joins it. */
function appendHunk(list: Hunk[], h: Hunk): void {
  const m = list[list.length - 1];
  if (m && (h.i1 <= m.i1 + m.chg1 || h.i2 <= m.i2 + m.chg2)) {
    if (h.mode !== m.mode) m.mode = 0;
    m.chg0 = h.i0 + h.chg0 - m.i0;
    m.chg1 = h.i1 + h.chg1 - m.i1;
    m.chg2 = h.i2 + h.chg2 - m.i2;
  } else {
    list.push({ ...h });
  }
}

function sameLines(a: ByteLines, ai: number, b: ByteLines, bi: number, count: number): boolean {
  for (let k = 0; k < count; k++) if (!bytesEqual(a.line(ai + k), b.line(bi + k))) return false;
  return true;
}

/** xdiff's `xdl_do_merge` loop: both sides' edits of the base grouped into regions. */
function mergeHunks(b: ByteLines, o: ByteLines, t: ByteLines, e1: Edit[], e2: Edit[]): Hunk[] {
  const out: Hunk[] = [];
  let a = 0;
  let c = 0;
  while (a < e1.length && c < e2.length) {
    const x1 = e1[a];
    const x2 = e2[c];
    const [x1i1, x1chg1, x1i2, x1chg2] = [
      x1.beginA,
      x1.endA - x1.beginA,
      x1.beginB,
      x1.endB - x1.beginB,
    ];
    const [x2i1, x2chg1, x2i2, x2chg2] = [
      x2.beginA,
      x2.endA - x2.beginA,
      x2.beginB,
      x2.endB - x2.beginB,
    ];
    if (x1i1 + x1chg1 < x2i1) {
      appendHunk(out, {
        mode: 1,
        i0: x1i1,
        chg0: x1chg1,
        i1: x1i2,
        chg1: x1chg2,
        i2: x2i2 - x2i1 + x1i1,
        chg2: x1chg1,
      });
      a++;
      continue;
    }
    if (x2i1 + x2chg1 < x1i1) {
      appendHunk(out, {
        mode: 2,
        i0: x2i1,
        chg0: x2chg1,
        i1: x1i2 - x1i1 + x2i1,
        chg1: x2chg1,
        i2: x2i2,
        chg2: x2chg2,
      });
      c++;
      continue;
    }
    if (
      x1i1 !== x2i1 ||
      x1chg1 !== x2chg1 ||
      x1chg2 !== x2chg2 ||
      !sameLines(o, x1i2, t, x2i2, x1chg2)
    ) {
      const off = x1i1 - x2i1;
      const ffo = off + x1chg1 - x2chg1;
      let i0 = x1i1;
      let i1 = x1i2;
      let i2 = x2i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else {
        i2 += off;
      }
      let chg0 = x1i1 + x1chg1 - i0;
      let chg1 = x1i2 + x1chg2 - i1;
      let chg2 = x2i2 + x2chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else {
        chg2 += ffo;
      }
      appendHunk(out, { mode: 0, i0, chg0, i1, chg1, i2, chg2 });
    }
    const end1 = x1i1 + x1chg1;
    const end2 = x2i1 + x2chg1;
    if (end1 >= end2) c++;
    if (end2 >= end1) a++;
  }
  for (; a < e1.length; a++) {
    const x = e1[a];
    appendHunk(out, {
      mode: 1,
      i0: x.beginA,
      chg0: x.endA - x.beginA,
      i1: x.beginB,
      chg1: x.endB - x.beginB,
      i2: x.beginA + t.size() - b.size(),
      chg2: x.endA - x.beginA,
    });
  }
  for (; c < e2.length; c++) {
    const x = e2[c];
    appendHunk(out, {
      mode: 2,
      i0: x.beginA,
      chg0: x.endA - x.beginA,
      i1: x.beginA + o.size() - b.size(),
      chg1: x.endA - x.beginA,
      i2: x.beginB,
      chg2: x.endB - x.beginB,
    });
  }
  return out;
}

/** xdiff's `xdl_refine_conflicts`: a conflict split where ours and theirs agree. */
function refineConflicts(
  hunks: Hunk[],
  o: ByteLines,
  t: ByteLines,
  diff: ReturnType<typeof getAlgorithm>,
): Hunk[] {
  const out: Hunk[] = [];
  for (const m of hunks) {
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) {
      out.push(m);
      continue;
    }
    const left = new ByteLines(o.range(m.i1, m.i1 + m.chg1));
    const right = new ByteLines(t.range(m.i2, m.i2 + m.chg2));
    const edits = diff(BYTE_LINES_COMPARATOR, left, right);
    if (edits.length === 0) {
      out.push({ ...m, mode: 4 });
      continue;
    }
    for (const e of edits) {
      out.push({
        mode: 0,
        i0: m.i0,
        chg0: m.chg0,
        i1: m.i1 + e.beginA,
        chg1: e.endA - e.beginA,
        i2: m.i2 + e.beginB,
        chg2: e.endB - e.beginB,
      });
    }
  }
  return out;
}

/** xdiff's `xdl_simplify_non_conflicts`: conflicts at most three lines apart are joined. */
function simplifyNonConflicts(hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const m = out[out.length - 1];
    if (m && m.mode === 0 && h.mode === 0 && h.i1 - (m.i1 + m.chg1) <= 3) {
      m.chg1 = h.i1 + h.chg1 - m.i1;
      m.chg2 = h.i2 + h.chg2 - m.i2;
      continue;
    }
    out.push({ ...h });
  }
  return out;
}

/** xdiff's `xdl_refine_zdiff3_conflicts`: shared leading and trailing lines move out. */
function refineZdiff3(hunks: Hunk[], o: ByteLines, t: ByteLines): void {
  for (const m of hunks) {
    if (m.mode !== 0) continue;
    while (m.chg1 && m.chg2 && bytesEqual(o.line(m.i1), t.line(m.i2))) {
      m.chg1--;
      m.chg2--;
      m.i1++;
      m.i2++;
    }
    while (m.chg1 && m.chg2 && bytesEqual(o.line(m.i1 + m.chg1 - 1), t.line(m.i2 + m.chg2 - 1))) {
      m.chg1--;
      m.chg2--;
    }
  }
}

/**
 * xdiff's `is_eol_crlf`: whether line `i` ends in CRLF (1), LF (0), or cannot tell (-1).
 */
function isEolCrlf(file: ByteLines, i: number): number {
  const n = file.size();
  const crlf = (line: Uint8Array) =>
    line.length > 1 && line[line.length - 2] === 0x0d && line[line.length - 1] === 0x0a ? 1 : 0;
  if (i < n - 1) return crlf(file.line(i));
  if (n === 0) return -1;
  const last = file.line(i);
  if (last.length > 0 && last[last.length - 1] === 0x0a) return crlf(last);
  if (i === 0) return -1;
  return crlf(file.line(i - 1));
}

/** xdiff's `is_cr_needed`: the markers' line ending, from the lines around the conflict. */
function isCrNeeded(b: ByteLines, o: ByteLines, t: ByteLines, m: Hunk): boolean {
  let needs = isEolCrlf(o, m.i1 ? m.i1 - 1 : 0);
  if (needs) needs = isEolCrlf(t, m.i2 ? m.i2 - 1 : 0);
  if (needs) needs = isEolCrlf(b, 0);
  return needs > 0;
}

const LF = new Uint8Array([0x0a]);
const CRLF = new Uint8Array([0x0d, 0x0a]);

/**
 * Merges `ours` and `theirs` against `base`, line by line, byte for byte.
 *
 * @example
 * ```ts
 * const { content, conflicts } = mergeLines(base, ours, theirs, { oursLabel: "HEAD", theirsLabel: "origin/main" });
 * ```
 */
export function mergeLines(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: LineMergeOptions = {},
): LineMergeResult {
  const diff = getAlgorithm(options.algorithm ?? DEFAULT_ALGORITHM);
  const b = new ByteLines(base);
  const o = new ByteLines(ours);
  const t = new ByteLines(theirs);
  const oursEdits = diff(BYTE_LINES_COMPARATOR, b, o);
  const theirsEdits = diff(BYTE_LINES_COMPARATOR, b, t);
  // one side unchanged: the other side whole (xdl_merge)
  if (oursEdits.length === 0) return { content: theirs, conflicts: 0 };
  if (theirsEdits.length === 0) return { content: ours, conflicts: 0 };

  const style = options.style ?? "merge";
  let hunks = mergeHunks(b, o, t, oursEdits, theirsEdits);
  if (style === "zdiff3") refineZdiff3(hunks, o, t);
  else if (style === "merge") hunks = simplifyNonConflicts(refineConflicts(hunks, o, t, diff));

  const favor = options.favor ? { ours: 1, theirs: 2, union: 3 }[options.favor] : 0;
  const markerSize = options.markerSize && options.markerSize > 0 ? options.markerSize : 7;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  // xdiff's xdl_recs_copy: lines of a file, a newline added to an unterminated last one
  const copy = (file: ByteLines, from: number, count: number, cr: boolean, addNl: boolean) => {
    if (count < 1) return;
    const bytes = file.range(from, from + count);
    parts.push(bytes);
    if (addNl && bytes[bytes.length - 1] !== 0x0a) parts.push(cr ? CRLF : LF);
  };
  const marker = (char: string, label: string | undefined, cr: boolean) => {
    parts.push(enc.encode(char.repeat(markerSize) + (label !== undefined ? ` ${label}` : "")));
    parts.push(cr ? CRLF : LF);
  };
  let conflicts = 0;
  let i = 0;
  for (const m of hunks) {
    if (favor && m.mode === 0) m.mode = favor;
    if (m.mode === 0) {
      conflicts++;
      const cr = isCrNeeded(b, o, t, m);
      copy(o, i, m.i1 - i, false, false);
      marker("<", options.oursLabel ?? "ours", cr);
      copy(o, m.i1, m.chg1, cr, true);
      if (style !== "merge") {
        marker("|", options.baseLabel, cr);
        copy(b, m.i0, m.chg0, cr, true);
      }
      marker("=", undefined, cr);
      copy(t, m.i2, m.chg2, cr, true);
      marker(">", options.theirsLabel ?? "theirs", cr);
    } else if (m.mode & 3) {
      copy(o, i, m.i1 - i, false, false);
      if (m.mode & 1) copy(o, m.i1, m.chg1, isCrNeeded(b, o, t, m), (m.mode & 2) !== 0);
      if (m.mode & 2) copy(t, m.i2, m.chg2, false, false);
    } else {
      continue;
    }
    i = m.i1 + m.chg1;
  }
  copy(o, i, o.size() - i, false, false);
  const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    content.set(p, pos);
    pos += p.length;
  }
  return { content, conflicts };
}
