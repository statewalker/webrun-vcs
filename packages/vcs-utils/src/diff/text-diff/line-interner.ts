/**
 * Numbers for distinct lines, shared by many diffs: a caller diffing many versions of one
 * file (as blame walks a history) interns each version's lines once, and xdiff then sorts
 * the lines of each pair into classes by those numbers instead of comparing bytes again.
 *
 * @module
 */

import { ByteLines } from "./byte-lines.js";
import { xdlHashRecord, xdlRecmatch } from "./xdiff.js";

/**
 * Gives each distinct line (distinct under the whitespace flags, as xdiff compares lines) a
 * number, the same for every {@link ByteLines} interned here.
 *
 * @example
 * ```typescript
 * const interner = new LineInterner();
 * const a = new ByteLines(before);
 * const b = new ByteLines(after);
 * xdiffHunks(a, b, { interner }); // a and b are interned once, then reused by later diffs
 * ```
 */
export class LineInterner {
  /** Distinct lines interned so far */
  count = 0;
  /** `XDF_*` whitespace flags lines are compared under */
  readonly whitespace: number;
  private arena = new Uint8Array(1 << 16);
  private used = 0;
  /** Start of line `id` in the arena; `starts[id + 1]` is its end */
  private starts = new Int32Array(1 << 10);
  private hashes = new Int32Array(1 << 10);
  private table = new Int32Array(1 << 11).fill(-1);
  private bits = 11;
  /** Generation stamps for {@link scratch}, one per id */
  private stamps = new Int32Array(0);
  private local = new Int32Array(0);
  private generation = 0;

  constructor(whitespace = 0) {
    this.whitespace = whitespace;
  }

  /**
   * Bytes of the distinct lines interned so far. The interner keeps every line it has seen;
   * a caller bounding its memory starts a new interner past a size of its choosing (ids of
   * different interners must never meet in one diff).
   */
  get byteSize(): number {
    return this.used;
  }

  /** The id of each line of `lines` (computed once per sequence and kept with it) */
  ids(lines: ByteLines): Int32Array {
    const known = lines.internedBy === this ? lines.internedIds : undefined;
    if (known) return known;
    const n = lines.size();
    const ids = new Int32Array(n);
    const c = lines.content;
    const ws = this.whitespace;
    for (let i = 0; i < n; i++) {
      const b0 = lines.start(i);
      const b1 = lines.start(i + 1);
      ids[i] = this.intern(c, b0, b1, ws ? xdlHashRecord(c, b0, b1, ws) : lines.hash(i));
    }
    lines.internedBy = this;
    lines.internedIds = ids;
    return ids;
  }

  /**
   * `content` to be interned as far as diffs need it: each diff splits, hashes and numbers
   * only the lines before the tail it trims (see {@link InternedText})
   */
  text(content: Uint8Array): InternedText {
    return new InternedText(this, content);
  }

  /**
   * A table from ids to classes, cleared by a new generation: `local[id]` is valid where
   * `stamps[id] === generation`. The next call reuses it.
   */
  scratch(): { stamps: Int32Array; local: Int32Array; generation: number } {
    if (this.stamps.length < this.count) {
      const size = Math.max(this.count, this.stamps.length * 2);
      this.stamps = new Int32Array(size);
      this.local = new Int32Array(size);
      this.generation = 0;
    }
    return { stamps: this.stamps, local: this.local, generation: ++this.generation };
  }

  /** The id of the line `c[b0, b1)` whose hash is `h` (the hash `ByteLines.hash` gives) */
  intern(c: Uint8Array, b0: number, b1: number, h: number): number {
    const mask = (1 << this.bits) - 1;
    let slot = Math.imul(h, 0x9e3779b1) >>> (32 - this.bits);
    const ws = this.whitespace;
    for (let id = this.table[slot]; id >= 0; id = this.table[slot]) {
      if (this.hashes[id] === h) {
        const r0 = this.starts[id];
        const r1 = this.starts[id + 1];
        if (
          ws
            ? xdlRecmatch(this.arena, r0, r1, c, b0, b1, ws)
            : sameBytes(this.arena, r0, r1, c, b0, b1)
        ) {
          return id;
        }
      }
      slot = (slot + 1) & mask;
    }
    const id = this.count++;
    this.store(c, b0, b1, h);
    this.table[slot] = id;
    if (this.count * 2 > this.table.length) this.rehash();
    return id;
  }

  private store(c: Uint8Array, b0: number, b1: number, h: number): void {
    const len = b1 - b0;
    if (this.used + len > this.arena.length) {
      const next = new Uint8Array(Math.max(this.arena.length * 2, this.used + len));
      next.set(this.arena.subarray(0, this.used));
      this.arena = next;
    }
    this.arena.set(c.subarray(b0, b1), this.used);
    const id = this.count - 1;
    if (id + 2 > this.starts.length) {
      const starts = new Int32Array(this.starts.length * 2);
      starts.set(this.starts);
      this.starts = starts;
      const hashes = new Int32Array(this.hashes.length * 2);
      hashes.set(this.hashes);
      this.hashes = hashes;
    }
    this.starts[id] = this.used;
    this.used += len;
    this.starts[id + 1] = this.used;
    this.hashes[id] = h;
  }

  private rehash(): void {
    this.bits++;
    const table = new Int32Array(1 << this.bits).fill(-1);
    const mask = (1 << this.bits) - 1;
    for (let id = 0; id < this.count; id++) {
      let slot = Math.imul(this.hashes[id], 0x9e3779b1) >>> (32 - this.bits);
      while (table[slot] >= 0) slot = (slot + 1) & mask;
      table[slot] = id;
    }
    this.table = table;
  }
}

function sameBytes(
  a: Uint8Array,
  a0: number,
  a1: number,
  b: Uint8Array,
  b0: number,
  b1: number,
): boolean {
  const len = a1 - a0;
  if (b1 - b0 !== len) return false;
  for (let k = 0; k < len; k++) if (a[a0 + k] !== b[b0 + k]) return false;
  return true;
}

/**
 * A file's lines, split, hashed and interned on demand, front to back: a diff that trims a
 * common tail first (as `xdiffHunks` does) asks only for the lines before it, so lines in
 * tails every diff trims are never read.
 *
 * @example
 * ```typescript
 * const interner = new LineInterner();
 * const a = interner.text(before);
 * const b = interner.text(after);
 * xdiffHunks(a, b, { interner });
 * ```
 */
export class InternedText {
  private starts = new Int32Array(17);
  private hashes = new Int32Array(16);
  private ids = new Int32Array(16);
  /** Lines read so far */
  private n = 0;
  /** End of the lines read so far */
  private end = 0;
  /** All lines, for an interner with whitespace flags */
  private full: ByteLines | undefined;

  constructor(
    readonly interner: LineInterner,
    readonly content: Uint8Array,
  ) {}

  /** The first `length` bytes as interned lines (`length` ends a line or the content) */
  prefix(length: number): ByteLines {
    const content = this.content;
    if (this.interner.whitespace) {
      // lines equal under whitespace flags hash by xdiff's rules: all lines read at once
      this.full ??= new ByteLines(content);
      this.interner.ids(this.full);
      return this.full.prefix(length);
    }
    if (this.end < length) this.extend(length);
    const starts = this.starts;
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < length) lo = mid + 1;
      else hi = mid;
    }
    if (starts[lo] !== length || lo > this.n) {
      const l = new ByteLines(content.subarray(0, length));
      this.interner.ids(l);
      return l;
    }
    const out = new ByteLines(
      content.subarray(0, length),
      starts.subarray(0, lo + 1),
      this.hashes.subarray(0, lo),
    );
    out.internedBy = this.interner;
    out.internedIds = this.ids.subarray(0, lo);
    return out;
  }

  /** Reads lines until `length` bytes are covered */
  private extend(length: number): void {
    const content = this.content;
    const len = content.length;
    const interner = this.interner;
    let { starts, hashes, ids, n } = this;
    let cap = hashes.length;
    let p = this.end;
    while (p < length && p < len) {
      const b0 = p;
      let h = 5381;
      let ch: number;
      do {
        ch = content[p++];
        h = (Math.imul(h, 33) + ch) | 0;
      } while (ch !== 0x0a && p < len);
      if (n === cap) {
        cap = Math.max(cap * 2, Math.ceil((n * len) / p) + 16);
        const s2 = new Int32Array(cap + 1);
        s2.set(starts.subarray(0, n + 1));
        starts = s2;
        const h2 = new Int32Array(cap);
        h2.set(hashes.subarray(0, n));
        hashes = h2;
        const i2 = new Int32Array(cap);
        i2.set(ids.subarray(0, n));
        ids = i2;
      }
      starts[n] = b0;
      hashes[n] = h;
      ids[n] = interner.intern(content, b0, p, h);
      n++;
    }
    starts[n] = p;
    this.starts = starts;
    this.hashes = hashes;
    this.ids = ids;
    this.n = n;
    this.end = p;
  }
}
