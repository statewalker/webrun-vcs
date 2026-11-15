/**
 * A byte-preserving three-way line merge, as git's `xdl_merge` does it for a text file.
 *
 * Lines are split on LF only and keep their terminators, so CRLF files, a missing final newline
 * and any encoding (UTF-8 or not) come out byte for byte. Nothing is decoded. Changes that touch
 * or overlap in the base conflict unless both sides made the same change, and a conflict is
 * written with git's markers and labels, in the line ending the file uses.
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

/** Options of {@link mergeLines}. */
export interface LineMergeOptions {
  /** Label after `<<<<<<<` (default `ours`) */
  oursLabel?: string;
  /** Label after `>>>>>>>` (default `theirs`) */
  theirsLabel?: string;
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

interface Region {
  baseFrom: number;
  baseTo: number;
  oursFrom: number;
  oursTo: number;
  theirsFrom: number;
  theirsTo: number;
  oursChanged: boolean;
  theirsChanged: boolean;
}

/** Edits of both sides grouped into regions of the base that touch or overlap. */
function regions(oursEdits: Edit[], theirsEdits: Edit[]): Region[] {
  const out: Region[] = [];
  let i = 0;
  let j = 0;
  // offset of each side relative to the base, from the edits before the current region
  let oursDelta = 0;
  let theirsDelta = 0;
  while (i < oursEdits.length || j < theirsEdits.length) {
    const takeOurs =
      j >= theirsEdits.length ||
      (i < oursEdits.length && oursEdits[i].beginA <= theirsEdits[j].beginA);
    const first = takeOurs ? oursEdits[i] : theirsEdits[j];
    let baseFrom = first.beginA;
    let baseTo = first.endA;
    const oursIn: Edit[] = [];
    const theirsIn: Edit[] = [];
    if (takeOurs) {
      oursIn.push(first);
      i++;
    } else {
      theirsIn.push(first);
      j++;
    }
    // absorb every edit of either side that touches the region (git: adjacent changes conflict)
    for (;;) {
      if (i < oursEdits.length && oursEdits[i].beginA <= baseTo) {
        const e = oursEdits[i++];
        oursIn.push(e);
        baseFrom = Math.min(baseFrom, e.beginA);
        baseTo = Math.max(baseTo, e.endA);
        continue;
      }
      if (j < theirsEdits.length && theirsEdits[j].beginA <= baseTo) {
        const e = theirsEdits[j++];
        theirsIn.push(e);
        baseFrom = Math.min(baseFrom, e.beginA);
        baseTo = Math.max(baseTo, e.endA);
        continue;
      }
      break;
    }
    const grow = (edits: Edit[]) =>
      edits.reduce((n, e) => n + (e.endB - e.beginB) - (e.endA - e.beginA), 0);
    const oursGrow = grow(oursIn);
    const theirsGrow = grow(theirsIn);
    out.push({
      baseFrom,
      baseTo,
      oursFrom: baseFrom + oursDelta,
      oursTo: baseTo + oursDelta + oursGrow,
      theirsFrom: baseFrom + theirsDelta,
      theirsTo: baseTo + theirsDelta + theirsGrow,
      oursChanged: oursIn.length > 0,
      theirsChanged: theirsIn.length > 0,
    });
    oursDelta += oursGrow;
    theirsDelta += theirsGrow;
  }
  return out;
}

/** The line ending the file uses: CRLF when its first terminated line ends with one. */
function eolOf(...texts: Uint8Array[]): Uint8Array {
  for (const t of texts) {
    const lf = t.indexOf(0x0a);
    if (lf >= 0) return lf > 0 && t[lf - 1] === 0x0d ? CRLF : LF;
  }
  return LF;
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
  const enc = new TextEncoder();
  const eol = eolOf(ours, theirs, base);
  const parts: Uint8Array[] = [];
  let conflicts = 0;
  let at = 0; // base position
  for (const r of regions(oursEdits, theirsEdits)) {
    parts.push(b.range(at, r.baseFrom));
    at = r.baseTo;
    const oursPart = o.range(r.oursFrom, r.oursTo);
    const theirsPart = t.range(r.theirsFrom, r.theirsTo);
    if (!r.theirsChanged || (r.oursChanged && bytesEqual(oursPart, theirsPart))) {
      parts.push(oursPart);
      continue;
    }
    if (!r.oursChanged) {
      parts.push(theirsPart);
      continue;
    }
    conflicts++;
    const marker = (text: string) => {
      parts.push(enc.encode(text), eol);
    };
    const side = (bytes: Uint8Array) => {
      parts.push(bytes);
      // a side that ends the file without a newline still ends its line before the next marker
      if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) parts.push(eol);
    };
    marker(`<<<<<<< ${options.oursLabel ?? "ours"}`);
    side(oursPart);
    marker("=======");
    side(theirsPart);
    marker(`>>>>>>> ${options.theirsLabel ?? "theirs"}`);
  }
  parts.push(b.range(at, b.size()));
  const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    content.set(p, pos);
    pos += p.length;
  }
  return { content, conflicts };
}
