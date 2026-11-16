/**
 * The lines of a byte buffer as git's xdiff records them: split after each LF, the terminator
 * kept with its line, an unterminated last line a line of its own. Nothing is decoded.
 *
 * @module
 */

import { Sequence, type SequenceComparator } from "./sequence.js";

/** The lines of a byte buffer: split after each LF, the terminator kept with its line. */
export class ByteLines extends Sequence {
  /** Start offsets of the lines, plus the content length as the last entry */
  private readonly starts: Int32Array;
  /** Hash of each line, computed on first use */
  private hashes: Int32Array | undefined;

  constructor(readonly content: Uint8Array) {
    super();
    let count = 0;
    for (let i = 0; i < content.length; i++) if (content[i] === 0x0a) count++;
    if (content.length > 0 && content[content.length - 1] !== 0x0a) count++;
    const starts = new Int32Array(count + 1);
    let n = 0;
    if (content.length > 0) {
      starts[n++] = 0;
      for (let i = 0; i < content.length - 1; i++) if (content[i] === 0x0a) starts[n++] = i + 1;
    }
    starts[n] = content.length;
    this.starts = starts;
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
    let hashes = this.hashes;
    if (!hashes) {
      const n = this.size();
      hashes = new Int32Array(n);
      const c = this.content;
      for (let k = 0; k < n; k++) {
        let h = 5381;
        for (let p = this.starts[k], end = this.starts[k + 1]; p < end; p++) {
          h = (Math.imul(h, 33) + c[p]) | 0;
        }
        hashes[k] = h;
      }
      this.hashes = hashes;
    }
    return hashes[i];
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
