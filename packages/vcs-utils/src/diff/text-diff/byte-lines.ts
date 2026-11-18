/**
 * The lines of a byte buffer as git's xdiff records them: split after each LF, the terminator
 * kept with its line, an unterminated last line a line of its own. Nothing is decoded.
 *
 * @module
 */

import { Sequence, type SequenceComparator } from "./sequence.js";

/**
 * Content that gives the lines of any prefix ending a line: a {@link ByteLines}, or an
 * `InternedText` that reads its lines on demand.
 */
export interface LineSource {
  readonly content: Uint8Array;
  /** The first `length` bytes as lines */
  prefix(length: number): ByteLines;
}

/** The lines of a byte buffer: split after each LF, the terminator kept with its line. */
export class ByteLines extends Sequence implements LineSource {
  /** Start offsets of the lines, plus the content length as the last entry */
  private readonly starts: Int32Array;
  /** The {@link LineInterner} that numbered these lines, and its ids (see `LineInterner.ids`) */
  internedBy: object | undefined;
  internedIds: Int32Array | undefined;
  /** Hash of each line, computed on first use */
  private hashes: Int32Array | undefined;

  constructor(
    readonly content: Uint8Array,
    starts?: Int32Array,
    hashes?: Int32Array,
  ) {
    super();
    if (starts) {
      this.starts = starts;
      this.hashes = hashes;
      return;
    }
    this.starts = lineStarts(content);
  }

  /** The start offsets of the lines, plus the content length as the last entry (shared) */
  get lineStarts(): Int32Array {
    return this.starts;
  }

  /** The hash of each line (see {@link hash}), computed on first use (shared) */
  get lineHashes(): Int32Array {
    return this.hashes ?? this.hashAll();
  }

  /** Whether the line hashes are computed already */
  get hashed(): boolean {
    return this.hashes !== undefined;
  }

  /**
   * The first `length` bytes as lines, sharing this sequence's line table and hashes when
   * `length` ends a line (as a tail trimmed by `trimCommonTail` does).
   */
  prefix(length: number): ByteLines {
    if (length === this.content.length) return this;
    const starts = this.starts;
    // the line ending at `length`: binary search in the line starts
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < length) lo = mid + 1;
      else hi = mid;
    }
    if (starts[lo] !== length) return new ByteLines(this.content.subarray(0, length));
    const hashes = this.hashes ?? this.hashAll();
    const out = new ByteLines(
      this.content.subarray(0, length),
      starts.subarray(0, lo + 1),
      hashes.subarray(0, lo),
    );
    if (this.internedIds) {
      out.internedBy = this.internedBy;
      out.internedIds = this.internedIds.subarray(0, lo);
    }
    return out;
  }

  size(): number {
    return this.starts.length - 1;
  }

  /** Offset of line `i` in the content (`size()` gives the content length) */
  start(i: number): number {
    return this.starts[i];
  }

  /** Line `i` with its terminator (a view of the content) */
  line(i: number): Uint8Array {
    return this.content.subarray(this.starts[i], this.starts[i + 1]);
  }

  /** Lines `[from, to)` with their terminators (a view of the content) */
  range(from: number, to: number): Uint8Array {
    return this.content.subarray(this.starts[from], this.starts[to]);
  }

  /** A hash of line `i`, terminator included (equal lines hash alike) */
  hash(i: number): number {
    return (this.hashes ?? this.hashAll())[i];
  }

  private hashAll(): Int32Array {
    const starts = this.starts;
    const n = starts.length - 1;
    const hashes = new Int32Array(n);
    const c = this.content;
    // four bytes at a time (a hash only ever compared with others of this function: lines
    // are told apart by their bytes, the hash only groups them)
    const words = new DataView(c.buffer, c.byteOffset, c.byteLength);
    for (let k = 0; k < n; k++) {
      let p = starts[k];
      const end = starts[k + 1];
      let h = end - p;
      for (; p + 4 <= end; p += 4) {
        h = Math.imul(h ^ words.getInt32(p, true), 0x5bd1e995);
        h ^= h >>> 13;
      }
      for (; p < end; p++) h = Math.imul(h ^ c[p], 0x01000193);
      hashes[k] = h ^ (h >>> 16);
    }
    this.hashes = hashes;
    return hashes;
  }

  /** Whether line `i` and line `j` of `other` hold the same bytes */
  lineEquals(i: number, other: ByteLines, j: number): boolean {
    const a0 = this.starts[i];
    const len = this.starts[i + 1] - a0;
    const b0 = other.starts[j];
    if (other.starts[j + 1] - b0 !== len) return false;
    const a = this.content;
    const b = other.content;
    for (let k = 0; k < len; k++) if (a[a0 + k] !== b[b0 + k]) return false;
    return true;
  }
}

/** Compares whole lines, terminators included: `a` and `a\n`, `a\n` and `a\r\n` differ. */
export const BYTE_LINES_COMPARATOR: SequenceComparator<ByteLines> = {
  equals(a, ai, b, bi) {
    return a.lineEquals(ai, b, bi);
  },
  hash(seq, index) {
    return seq.hash(index);
  },
};

/**
 * The start of each line of `content` (split after each LF), then its length; `indexOf` finds
 * the LFs (a native scan, several times faster than a loop over the bytes).
 */
function lineStarts(content: Uint8Array): Int32Array {
  const len = content.length;
  if (len === 0) return new Int32Array(1);
  let out = new Int32Array((len >> 5) + 2);
  let n = 0;
  out[n++] = 0;
  for (let i = content.indexOf(0x0a); i >= 0 && i < len - 1; i = content.indexOf(0x0a, i + 1)) {
    if (n + 1 >= out.length) {
      const grown = new Int32Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    out[n++] = i + 1;
  }
  out[n++] = len;
  return out.length === n ? out : out.subarray(0, n);
}
