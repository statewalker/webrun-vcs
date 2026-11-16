/**
 * A byte-preserving three-way line merge, a port of git's `xdl_merge` (`xdiff/xmerge.c`).
 *
 * ```ts
 * const { content, conflicts } = mergeLines(base, ours, theirs, { oursLabel: "HEAD", theirsLabel: "topic" });
 * ```
 *
 * Lines are split on LF only and keep their terminators, so CRLF files, a missing final newline
 * and any encoding (UTF-8 or not) come out byte for byte. Nothing is decoded. Both sides are
 * diffed against the base with git's own diff (see {@link xdiff}), so the changes, and therefore
 * the conflicts, are the ones git finds. Changes that touch or overlap in the base conflict
 * unless both sides made the same change, and a conflict is written with git's markers and
 * labels, in the line ending the file uses.
 *
 * The defaults are those of `git merge`, `cherry-pick`, `revert` and `stash apply` (merge-ort
 * calling `ll_merge`): the histogram diff and `XDL_MERGE_ZEALOUS`, which moves lines both sides
 * share out of a conflict and joins conflicts at most three lines apart. git 2.43 merged with
 * Myers (its merge-ort took the algorithm from merge-recursive's options, which had none); the
 * histogram default came with newer git, and is followed here. `git merge-file` uses Myers and
 * `XDL_MERGE_ZEALOUS_ALNUM` (conflicts separated only by lines without letters or digits are
 * joined too): pass `algorithm: "myers", level: "zealous-alnum"` to merge as it does.
 *
 * With the `diff3` style nothing is refined (git's `XDL_MERGE_EAGER`); with `zdiff3` only the
 * lines both sides share at the start and the end of a conflict move out.
 *
 * @module
 */

import { ByteLines } from "./byte-lines.js";
import type { SupportedAlgorithm } from "./diff-algorithm.js";
import { diffScript, type XdFlags, type XdiffAlgorithm, type XdiffChange } from "./xdiff.js";

/**
 * How a conflict is written (git's `merge.conflictStyle`): `merge` (ours and theirs),
 * `diff3` (the base too, unrefined) or `zdiff3` (the base too, shared lines moved out).
 */
export type ConflictStyle = "merge" | "diff3" | "zdiff3";

/**
 * How hard conflicts are refined (xdiff's merge levels): `minimal` (every overlap conflicts),
 * `eager` (identical changes do not), `zealous` (shared lines leave conflicts, near conflicts
 * join), `zealous-alnum` (conflicts separated by lines without letters or digits join too).
 */
export type LineMergeLevel = "minimal" | "eager" | "zealous" | "zealous-alnum";

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
  /** Diff algorithm (default `histogram`, as merge-ort; `git merge-file` uses `myers`) */
  algorithm?: XdiffAlgorithm | SupportedAlgorithm;
  /** Conflict refinement (default `zealous`, as merge-ort; `git merge-file` uses `zealous-alnum`) */
  level?: LineMergeLevel;
  /**
   * Diff a histogram change group again after sliding joined it with another, as git 2.54
   * and later do (default true; false merges as older git)
   */
  histogramRediff?: boolean;
}

/** What {@link mergeLines} produced. */
export interface LineMergeResult {
  /** The merged bytes: conflicts hold both sides between git's markers */
  content: Uint8Array;
  /** Number of conflicting regions (0: a clean merge) */
  conflicts: number;
}

const LEVELS: Record<LineMergeLevel, number> = {
  minimal: 0,
  eager: 1,
  zealous: 2,
  "zealous-alnum": 3,
};

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
  for (let k = 0; k < count; k++) if (!a.lineEquals(ai + k, b, bi + k)) return false;
  return true;
}

/** xdiff's `xdl_do_merge` loop: both sides' changes of the base grouped into regions. */
function mergeHunks(
  b: ByteLines,
  o: ByteLines,
  t: ByteLines,
  e1: XdiffChange[],
  e2: XdiffChange[],
  level: number,
): Hunk[] {
  const out: Hunk[] = [];
  let a = 0;
  let c = 0;
  while (a < e1.length && c < e2.length) {
    const x1 = e1[a];
    const x2 = e2[c];
    if (x1.i1 + x1.chg1 < x2.i1) {
      appendHunk(out, {
        mode: 1,
        i0: x1.i1,
        chg0: x1.chg1,
        i1: x1.i2,
        chg1: x1.chg2,
        i2: x2.i2 - x2.i1 + x1.i1,
        chg2: x1.chg1,
      });
      a++;
      continue;
    }
    if (x2.i1 + x2.chg1 < x1.i1) {
      appendHunk(out, {
        mode: 2,
        i0: x2.i1,
        chg0: x2.chg1,
        i1: x1.i2 - x1.i1 + x2.i1,
        chg1: x2.chg1,
        i2: x2.i2,
        chg2: x2.chg2,
      });
      c++;
      continue;
    }
    if (
      level === 0 ||
      x1.i1 !== x2.i1 ||
      x1.chg1 !== x2.chg1 ||
      x1.chg2 !== x2.chg2 ||
      !sameLines(o, x1.i2, t, x2.i2, x1.chg2)
    ) {
      const off = x1.i1 - x2.i1;
      const ffo = off + x1.chg1 - x2.chg1;
      let i0 = x1.i1;
      let i1 = x1.i2;
      let i2 = x2.i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else {
        i2 += off;
      }
      let chg0 = x1.i1 + x1.chg1 - i0;
      let chg1 = x1.i2 + x1.chg2 - i1;
      let chg2 = x2.i2 + x2.chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else {
        chg2 += ffo;
      }
      appendHunk(out, { mode: 0, i0, chg0, i1, chg1, i2, chg2 });
    }
    const end1 = x1.i1 + x1.chg1;
    const end2 = x2.i1 + x2.chg1;
    if (end1 >= end2) c++;
    if (end2 >= end1) a++;
  }
  for (; a < e1.length; a++) {
    const x = e1[a];
    appendHunk(out, {
      mode: 1,
      i0: x.i1,
      chg0: x.chg1,
      i1: x.i2,
      chg1: x.chg2,
      i2: x.i1 + t.size() - b.size(),
      chg2: x.chg1,
    });
  }
  for (; c < e2.length; c++) {
    const x = e2[c];
    appendHunk(out, {
      mode: 2,
      i0: x.i1,
      chg0: x.chg1,
      i1: x.i1 + o.size() - b.size(),
      chg1: x.chg1,
      i2: x.i2,
      chg2: x.chg2,
    });
  }
  return out;
}

/** xdiff's `xdl_refine_conflicts`: a conflict split where ours and theirs agree. */
function refineConflicts(hunks: Hunk[], o: ByteLines, t: ByteLines, flags: XdFlags): Hunk[] {
  const out: Hunk[] = [];
  for (const m of hunks) {
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) {
      out.push(m);
      continue;
    }
    const script = diffScript(o, m.i1, m.chg1, t, m.i2, m.chg2, flags);
    if (script.length === 0) {
      out.push({ ...m, mode: 4 });
      continue;
    }
    for (const x of script) {
      out.push({
        mode: 0,
        i0: m.i0,
        chg0: m.chg0,
        i1: m.i1 + x.i1,
        chg1: x.chg1,
        i2: m.i2 + x.i2,
        chg2: x.chg2,
      });
    }
  }
  return out;
}

/** git's `isalnum`: ASCII letters and digits only */
function linesContainAlnum(file: ByteLines, from: number, count: number): boolean {
  const c = file.content;
  for (let p = file.start(from), end = file.start(from + count); p < end; p++) {
    const ch = c[p];
    if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)) {
      return true;
    }
  }
  return false;
}

/**
 * xdiff's `xdl_simplify_non_conflicts`: conflicts at most three lines apart are joined, and
 * with `alnum` also conflicts apart only by lines without a letter or digit.
 */
function simplifyNonConflicts(hunks: Hunk[], o: ByteLines, alnum: boolean): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const m = out[out.length - 1];
    if (m && m.mode === 0 && h.mode === 0) {
      const begin = m.i1 + m.chg1;
      const end = h.i1;
      if (end - begin <= 3 || (alnum && !linesContainAlnum(o, begin, end - begin))) {
        m.chg1 = h.i1 + h.chg1 - m.i1;
        m.chg2 = h.i2 + h.chg2 - m.i2;
        continue;
      }
    }
    out.push({ ...h });
  }
  return out;
}

/** xdiff's `xdl_refine_zdiff3_conflicts`: shared leading and trailing lines move out. */
function refineZdiff3(hunks: Hunk[], o: ByteLines, t: ByteLines): void {
  for (const m of hunks) {
    if (m.mode !== 0) continue;
    while (m.chg1 && m.chg2 && o.lineEquals(m.i1, t, m.i2)) {
      m.chg1--;
      m.chg2--;
      m.i1++;
      m.i2++;
    }
    while (m.chg1 && m.chg2 && o.lineEquals(m.i1 + m.chg1 - 1, t, m.i2 + m.chg2 - 1)) {
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
  const flags: XdFlags = {
    algorithm: String(options.algorithm ?? "histogram") as XdiffAlgorithm,
    indentHeuristic: false,
    histogramRediff: options.histogramRediff ?? true,
  };
  const b = new ByteLines(base);
  const o = new ByteLines(ours);
  const t = new ByteLines(theirs);
  const oursEdits = diffScript(b, 0, b.size(), o, 0, o.size(), flags);
  const theirsEdits = diffScript(b, 0, b.size(), t, 0, t.size(), flags);
  // one side unchanged: the other side whole (xdl_merge)
  if (oursEdits.length === 0) return { content: theirs, conflicts: 0 };
  if (theirsEdits.length === 0) return { content: ours, conflicts: 0 };

  const style = options.style ?? "merge";
  let level = LEVELS[options.level ?? "zealous"];
  // "diff3 -m" output does not make sense for anything more aggressive than XDL_MERGE_EAGER
  if (style !== "merge" && level > 1) level = 1;
  let hunks = mergeHunks(b, o, t, oursEdits, theirsEdits, level);
  if (style === "zdiff3") refineZdiff3(hunks, o, t);
  else if (level >= 2) {
    hunks = simplifyNonConflicts(refineConflicts(hunks, o, t, flags), o, level > 2);
  }

  const favor = options.favor ? { ours: 1, theirs: 2, union: 3 }[options.favor] : 0;
  const markerSize = options.markerSize && options.markerSize > 0 ? options.markerSize : 7;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  // xdiff's xdl_recs_copy: lines of a file, a newline added to an unterminated last one
  const copy = (file: ByteLines, from: number, count: number, cr: boolean, addNl: boolean) => {
    if (count < 1) return;
    const bytes = file.range(from, from + count);
    parts.push(bytes);
    if (addNl && (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a)) {
      parts.push(cr ? CRLF : LF);
    }
  };
  const marker = (char: string, label: string | undefined, cr: boolean) => {
    parts.push(enc.encode(char.repeat(markerSize) + (label ? ` ${label}` : "")));
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
