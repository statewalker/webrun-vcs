/**
 * The lines of a byte buffer as git's xdiff records them: split after each LF, the terminator
 * kept with its line, an unterminated last line a line of its own. Nothing is decoded.
 *
 * @module
 */

import { allocInt32 } from "../../streams/index.js";
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
    // the lines and their hashes in one pass: a diff hashes every line it splits
    const scanned = scanLines(content);
    this.starts = scanned.starts;
    this.hashes = scanned.hashes;
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
    const hashes = allocInt32(n);
    const c = this.content;
    const words = lineWords(c);
    for (let k = 0; k < n; k++) hashes[k] = hashLine(c, starts[k], starts[k + 1], words);
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

/** A view for reading `content` four bytes at a time, as {@link hashLine} takes it */
export function lineWords(content: Uint8Array): DataView {
  return new DataView(content.buffer, content.byteOffset, content.byteLength);
}

/** The seed of {@link hashLine} */
const LINE_SEED = 0x9747b28c | 0;

/**
 * The hash of the line `content[start, end)`, terminator included: the one hash of exact
 * lines everywhere (`ByteLines.hash`, `InternedText`, `LineInterner`; {@link LineHasher}
 * gives the same), so equal lines hash alike whichever reads them. Four bytes at a time; the
 * hash only groups lines, which are told apart by their bytes. `words` is
 * {@link lineWords} of `content`, made once per buffer.
 */
export function hashLine(
  content: Uint8Array,
  start: number,
  end: number,
  words: DataView = lineWords(content),
): number {
  let p = start;
  let h = LINE_SEED;
  for (; p + 4 <= end; p += 4) {
    h = Math.imul(h ^ words.getInt32(p, true), 0x5bd1e995);
    h ^= h >>> 13;
  }
  for (; p < end; p++) h = Math.imul(h ^ content[p], 0x01000193);
  h ^= end - start;
  return h ^ (h >>> 16);
}

/**
 * Finds and hashes lines in one pass, front to back: `next(start)` gives the
 * {@link hashLine} of the line starting at `start` and sets `end` past its LF (or to the
 * content's length). Reads four bytes at a time until a word holds the LF, so short lines
 * cost no native call each (as an `indexOf` per line would).
 *
 * @example
 * ```typescript
 * const hasher = new LineHasher(content);
 * for (let p = 0; p < content.length; p = hasher.end) console.log(hasher.next(p));
 * ```
 */
export class LineHasher {
  /** Where the line the last `next` read ends (after its LF) */
  end = 0;
  private readonly words: DataView;

  constructor(readonly content: Uint8Array) {
    this.words = lineWords(content);
  }

  /** The {@link hashLine} of the line starting at `start`; sets {@link end} */
  next(start: number): number {
    const c = this.content;
    const words = this.words;
    const len = c.length;
    let p = start;
    let h = LINE_SEED;
    // whole words while none holds an LF (a zero byte of `x ^ 0x0a0a0a0a`)
    while (p + 4 <= len) {
      const x = words.getInt32(p, true);
      const y = x ^ 0x0a0a0a0a;
      if (((y - 0x01010101) & ~y & 0x80808080) !== 0) break;
      h = Math.imul(h ^ x, 0x5bd1e995);
      h ^= h >>> 13;
      p += 4;
    }
    // the LF is within the next four bytes (or the content ends there)
    let e = p;
    while (e < len && c[e] !== 0x0a) e++;
    if (e < len) e++;
    // a line ending with the word hashes it as a word, as hashLine does
    if (p + 4 === e) {
      h = Math.imul(h ^ words.getInt32(p, true), 0x5bd1e995);
      h ^= h >>> 13;
      p = e;
    }
    for (; p < e; p++) h = Math.imul(h ^ c[p], 0x01000193);
    h ^= e - start;
    this.end = e;
    return h ^ (h >>> 16);
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

/** Where {@link scanLines} gathers the line starts and hashes (reused across calls) */
let scanStarts = new Int32Array(4096);
let scanHashes = new Int32Array(4096);

/**
 * Splits `content` after each LF and hashes each line ({@link hashLine}) in one pass, front
 * to back: the start of each line, then the content's length (`starts`), and the hash of
 * each line (`hashes`), in arrays of their own.
 */
function scanLines(content: Uint8Array): { starts: Int32Array; hashes: Int32Array } {
  const len = content.length;
  let starts = scanStarts;
  let hashes = scanHashes;
  const hasher = new LineHasher(content);
  let n = 0;
  for (let p = 0; p < len; p = hasher.end) {
    if (n + 1 >= starts.length) {
      const grownStarts = new Int32Array(starts.length * 2);
      grownStarts.set(starts);
      starts = grownStarts;
      const grownHashes = new Int32Array(hashes.length * 2);
      grownHashes.set(hashes);
      hashes = grownHashes;
    }
    hashes[n] = hasher.next(p);
    starts[n++] = p;
  }
  starts[n] = len;
  // kept for the next call unless far longer than a usual file needs
  if (starts.length <= 1 << 16) {
    scanStarts = starts;
    scanHashes = hashes;
  }
  const outStarts = allocInt32(n + 1);
  outStarts.set(starts.subarray(0, n + 1));
  const outHashes = allocInt32(n);
  outHashes.set(hashes.subarray(0, n));
  return { starts: outStarts, hashes: outHashes };
}
