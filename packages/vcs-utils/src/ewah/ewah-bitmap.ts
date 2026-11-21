/**
 * EWAH compressed bitmaps, as git's `ewah/` (ewah_bitmap.c, ewah_io.c, ewah_rlw.c): 64-bit
 * words, run-length encoded, serialized as JavaEWAH (and so JGit) writes them. Used by the
 * index's untracked cache and split index, and by pack reachability bitmaps.
 *
 * A word is held as two 32-bit halves (`lo`, `hi`) in a `Uint32Array`, so no operation needs
 * `BigInt`. A run-length word (RLW) holds, from the lowest bit: the run bit, a 32-bit running
 * length and a 31-bit count of the literal words that follow it.
 *
 * Every operation reproduces git's buffer layout exactly (where it pushes a new RLW, when a
 * literal word becomes a run), because the layout is what git serializes and what its size
 * comparisons (the XOR choice of `pack-bitmap-write.c`) look at.
 */

/** Bits per word. */
export const EWAH_WORD_BITS = 64;
const LARGEST_RUNNING = 0xffffffff;
const LARGEST_LITERAL = 0x7fffffff;

/** A 64-bit word as two unsigned 32-bit halves. */
export interface EwahWord {
  lo: number;
  hi: number;
}

/** A compressed bitmap, built by setting increasing bits or adding words, serialized as git. */
export class EwahBitmap {
  /** the words, two halves each: `lo` at `2k`, `hi` at `2k + 1` */
  private w: Uint32Array;
  /** words in use (git's `buffer_size`) */
  private n = 1;
  /** the current RLW (git's `rlw`, as a word index) */
  private rlw = 0;
  /** git's `bit_size` */
  bitSize = 0;

  constructor(capacityWords = 4) {
    this.w = new Uint32Array(Math.max(2, capacityWords * 2));
  }

  /** Words in the compressed buffer (git's `buffer_size`): what the XOR choice compares. */
  get bufferSize(): number {
    return this.n;
  }

  /** The `i`-th compressed word's low half. */
  wordLo(i: number): number {
    return this.w[2 * i] as number;
  }
  /** The `i`-th compressed word's high half. */
  wordHi(i: number): number {
    return this.w[2 * i + 1] as number;
  }
  /** The position of the current RLW (serialized after the words). */
  get rlwPosition(): number {
    return this.rlw;
  }

  // ---- RLW fields of word `k` ----
  private runBit(k: number): number {
    return (this.w[2 * k] as number) & 1;
  }
  private runningLen(k: number): number {
    return (((this.w[2 * k] as number) >>> 1) | (((this.w[2 * k + 1] as number) & 1) << 31)) >>> 0;
  }
  private literalWords(k: number): number {
    return (this.w[2 * k + 1] as number) >>> 1;
  }
  private setRunBit(k: number, b: number): void {
    this.w[2 * k] = (((this.w[2 * k] as number) & ~1) | (b & 1)) >>> 0;
  }
  private setRunningLen(k: number, l: number): void {
    this.w[2 * k] = ((l << 1) | ((this.w[2 * k] as number) & 1)) >>> 0;
    this.w[2 * k + 1] = (((this.w[2 * k + 1] as number) & ~1) | (l >>> 31)) >>> 0;
  }
  private setLiteralWords(k: number, l: number): void {
    this.w[2 * k + 1] = ((l << 1) | ((this.w[2 * k + 1] as number) & 1)) >>> 0;
  }

  private grow(words: number): void {
    if (words * 2 <= this.w.length) return;
    let cap = this.w.length;
    while (cap < words * 2) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.w.subarray(0, this.n * 2));
    this.w = next;
  }
  private push(lo: number, hi: number): void {
    this.grow(this.n + 1);
    this.w[2 * this.n] = lo;
    this.w[2 * this.n + 1] = hi;
    this.n++;
  }
  private pushRlw(): void {
    this.push(0, 0);
    this.rlw = this.n - 1;
  }

  private addEmptyWordsRaw(v: number, count: number): void {
    let number = count;
    const r = this.rlw;
    if (this.runBit(r) !== v && this.runningLen(r) + this.literalWords(r) === 0) {
      this.setRunBit(r, v);
    } else if (this.literalWords(r) !== 0 || this.runBit(r) !== v) {
      this.pushRlw();
      if (v) this.setRunBit(this.rlw, v);
    }
    const runlen = this.runningLen(this.rlw);
    const canAdd = Math.min(number, LARGEST_RUNNING - runlen);
    this.setRunningLen(this.rlw, runlen + canAdd);
    number -= canAdd;
    while (number >= LARGEST_RUNNING) {
      this.pushRlw();
      if (v) this.setRunBit(this.rlw, v);
      this.setRunningLen(this.rlw, LARGEST_RUNNING);
      number -= LARGEST_RUNNING;
    }
    if (number > 0) {
      this.pushRlw();
      if (v) this.setRunBit(this.rlw, v);
      this.setRunningLen(this.rlw, number);
    }
  }

  /** git's `ewah_add_empty_words`: `count` words of `v` bits. */
  addEmptyWords(v: boolean | number, count: number): void {
    if (count === 0) return;
    this.bitSize += count * EWAH_WORD_BITS;
    this.addEmptyWordsRaw(v ? 1 : 0, count);
  }

  private addLiteral(lo: number, hi: number): void {
    const current = this.literalWords(this.rlw);
    if (current >= LARGEST_LITERAL) {
      this.pushRlw();
      this.setLiteralWords(this.rlw, 1);
      this.push(lo, hi);
      return;
    }
    this.setLiteralWords(this.rlw, current + 1);
    this.push(lo, hi);
  }

  private addEmptyWord(v: number): void {
    const r = this.rlw;
    const noLiteral = this.literalWords(r) === 0;
    const runLen = this.runningLen(r);
    if (noLiteral && runLen === 0) this.setRunBit(r, v);
    if (noLiteral && this.runBit(r) === v && runLen < LARGEST_RUNNING) {
      this.setRunningLen(r, runLen + 1);
      return;
    }
    this.pushRlw();
    this.setRunBit(this.rlw, v);
    this.setRunningLen(this.rlw, 1);
  }

  /** git's `ewah_add`: one word (64 bits) appended. */
  add(lo: number, hi: number): void {
    this.bitSize += EWAH_WORD_BITS;
    if (lo === 0 && hi === 0) this.addEmptyWord(0);
    else if (lo === 0xffffffff && hi === 0xffffffff) this.addEmptyWord(1);
    else this.addLiteral(lo >>> 0, hi >>> 0);
  }

  /**
   * git's `ewah_add_dirty_words`: `number` literal words of `src` (halves from word `start`),
   * negated with `negate`.
   */
  addDirtyWords(src: EwahBitmap, start: number, number: number, negate: boolean): void {
    let from = start;
    let left = number;
    for (;;) {
      const literals = this.literalWords(this.rlw);
      const canAdd = Math.min(left, LARGEST_LITERAL - literals);
      this.setLiteralWords(this.rlw, literals + canAdd);
      this.grow(this.n + canAdd);
      for (let i = 0; i < canAdd; i++) {
        const lo = src.w[2 * (from + i)] as number;
        const hi = src.w[2 * (from + i) + 1] as number;
        this.w[2 * this.n] = negate ? ~lo >>> 0 : lo;
        this.w[2 * this.n + 1] = negate ? ~hi >>> 0 : hi;
        this.n++;
      }
      this.bitSize += canAdd * EWAH_WORD_BITS;
      if (left - canAdd === 0) break;
      this.pushRlw();
      from += canAdd;
      left -= canAdd;
    }
  }

  /** Sets bit `i`; bits must be set in increasing order (git's `ewah_set`). */
  set(i: number): void {
    if (i < this.bitSize) throw new Error("EwahBitmap.set: bits must be set in increasing order");
    const dist = Math.ceil((i + 1) / EWAH_WORD_BITS) - Math.ceil(this.bitSize / EWAH_WORD_BITS);
    this.bitSize = i + 1;
    const b = i % EWAH_WORD_BITS;
    const lo = b < 32 ? (1 << b) >>> 0 : 0;
    const hi = b >= 32 ? (1 << (b - 32)) >>> 0 : 0;
    if (dist > 0) {
      if (dist > 1) this.addEmptyWordsRaw(0, dist - 1);
      this.addLiteral(lo, hi);
      return;
    }
    if (this.literalWords(this.rlw) === 0) {
      this.setRunningLen(this.rlw, this.runningLen(this.rlw) - 1);
      this.addLiteral(lo, hi);
      return;
    }
    const last = this.n - 1;
    this.w[2 * last] = ((this.w[2 * last] as number) | lo) >>> 0;
    this.w[2 * last + 1] = ((this.w[2 * last + 1] as number) | hi) >>> 0;
    if (this.w[2 * last] === 0xffffffff && this.w[2 * last + 1] === 0xffffffff) {
      this.n--;
      this.w[2 * this.n] = 0;
      this.w[2 * this.n + 1] = 0;
      this.setLiteralWords(this.rlw, this.literalWords(this.rlw) - 1);
      this.addEmptyWord(1);
    }
  }

  /** The uncompressed words in order (git's `ewah_iterator`): `[lo, hi]` pairs, one per word. */
  *words(): Generator<EwahWord> {
    const out: EwahWord = { lo: 0, hi: 0 };
    let p = 0;
    while (p < this.n) {
      const rl = this.runningLen(p);
      const lw = this.literalWords(p);
      const fill = this.runBit(p) ? 0xffffffff : 0;
      for (let k = 0; k < rl; k++) {
        out.lo = fill;
        out.hi = fill;
        yield out;
      }
      for (let k = 1; k <= lw; k++) {
        out.lo = this.w[2 * (p + k)] as number;
        out.hi = this.w[2 * (p + k) + 1] as number;
        yield out;
      }
      p += lw + 1;
    }
  }

  /**
   * Calls `fn` with each uncompressed word index and halves, skipping runs of zeros (much faster
   * than `words()` for sparse maps).
   */
  forEachWord(fn: (index: number, lo: number, hi: number) => void): void {
    let p = 0;
    let at = 0;
    while (p < this.n) {
      const rl = this.runningLen(p);
      const lw = this.literalWords(p);
      if (this.runBit(p)) for (let k = 0; k < rl; k++) fn(at + k, 0xffffffff, 0xffffffff);
      at += rl;
      for (let k = 1; k <= lw; k++) {
        fn(at++, this.w[2 * (p + k)] as number, this.w[2 * (p + k) + 1] as number);
      }
      p += lw + 1;
    }
  }

  /** The positions of the set bits, ascending (git's `ewah_each_bit`). */
  *bits(): Generator<number> {
    const list: number[] = [];
    this.forEachWord((index, lo, hi) => {
      collectBits(list, index * EWAH_WORD_BITS, lo, hi);
    });
    yield* list;
  }

  /** The number of set bits. */
  popcount(): number {
    let c = 0;
    this.forEachWord((_, lo, hi) => {
      c += popcount32(lo) + popcount32(hi);
    });
    return c;
  }

  /** git's `ewah_serialize_to` into `out`: bit size, word count, the words, the RLW position. */
  serialize(out: number[]): void {
    pushU32(out, this.bitSize >>> 0);
    pushU32(out, this.n);
    for (let i = 0; i < this.n; i++) {
      pushU32(out, this.w[2 * i + 1] as number);
      pushU32(out, this.w[2 * i] as number);
    }
    pushU32(out, this.rlw);
  }

  /** Bytes `serialize` writes. */
  get serializedSize(): number {
    return 12 + this.n * 8;
  }

  /** git's `ewah_serialize_to`, into `out` at `at`; returns the position after it. */
  writeTo(out: Uint8Array, at: number): number {
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    v.setUint32(at, this.bitSize >>> 0);
    v.setUint32(at + 4, this.n);
    let p = at + 8;
    for (let i = 0; i < this.n; i++) {
      v.setUint32(p, this.w[2 * i + 1] as number);
      v.setUint32(p + 4, this.w[2 * i] as number);
      p += 8;
    }
    v.setUint32(p, this.rlw);
    return p + 4;
  }

  /**
   * git's `ewah_read_mmap`: a bitmap at `at`, and where it ends; undefined when truncated (or
   * when its RLW position is outside its words).
   */
  static read(
    data: Uint8Array,
    at: number,
    end: number,
  ): { bitmap: EwahBitmap; next: number } | undefined {
    if (at + 8 > end) return undefined;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bitSize = v.getUint32(at);
    const words = v.getUint32(at + 4);
    let next = at + 8;
    if (words * 8 + 4 > end - next) return undefined;
    const bitmap = new EwahBitmap(words);
    for (let i = 0; i < words; i++) {
      bitmap.w[2 * i + 1] = v.getUint32(next);
      bitmap.w[2 * i] = v.getUint32(next + 4);
      next += 8;
    }
    bitmap.n = words;
    const rlw = v.getUint32(next);
    if (words === 0 || rlw >= words) {
      // git points `rlw` past the buffer; nothing can be appended to it (we never do)
      bitmap.rlw = 0;
      if (words === 0) {
        bitmap.n = 1;
        bitmap.w[0] = 0;
        bitmap.w[1] = 0;
      }
    } else bitmap.rlw = rlw;
    bitmap.bitSize = bitSize;
    next += 4;
    return { bitmap, next };
  }

  /**
   * Whether the RLW structure is well formed: every literal count stays inside the buffer
   * (git's iterators assert on it; a corrupt file must not make ours read past the words).
   */
  isWellFormed(): boolean {
    let p = 0;
    while (p < this.n) p += this.literalWords(p) + 1;
    return p === this.n;
  }

  /** git's `ewah_xor`: a new bitmap of `a ^ b`, in git's exact layout. */
  static xor(a: EwahBitmap, b: EwahBitmap): EwahBitmap {
    const out = new EwahBitmap(Math.max(a.n, b.n));
    const i = new RlwIterator(a);
    const j = new RlwIterator(b);
    while (i.wordSize() > 0 && j.wordSize() > 0) {
      while (i.runningLen > 0 || j.runningLen > 0) {
        let prey: RlwIterator;
        let predator: RlwIterator;
        if (i.runningLen < j.runningLen) {
          prey = i;
          predator = j;
        } else {
          prey = j;
          predator = i;
        }
        const negate = predator.runningBit === 1;
        const index = prey.discharge(out, predator.runningLen, negate);
        out.addEmptyWords(negate, predator.runningLen - index);
        predator.discardFirstWords(predator.runningLen);
      }
      const literals = Math.min(i.literalWords, j.literalWords);
      if (literals) {
        for (let k = 0; k < literals; k++) {
          const ia = i.literalWordStart + k;
          const jb = j.literalWordStart + k;
          out.add(
            ((a.w[2 * ia] as number) ^ (b.w[2 * jb] as number)) >>> 0,
            ((a.w[2 * ia + 1] as number) ^ (b.w[2 * jb + 1] as number)) >>> 0,
          );
        }
        i.discardFirstWords(literals);
        j.discardFirstWords(literals);
      }
    }
    if (i.wordSize() > 0) i.discharge(out, Number.MAX_SAFE_INTEGER, false);
    else j.discharge(out, Number.MAX_SAFE_INTEGER, false);
    out.bitSize = Math.max(a.bitSize, b.bitSize);
    return out;
  }

  /** @internal the RLW fields of word `k`, for the iterator */
  rlwFields(k: number): { runBit: number; runningLen: number; literalWords: number } {
    return {
      runBit: this.runBit(k),
      runningLen: this.runningLen(k),
      literalWords: this.literalWords(k),
    };
  }
}

/** git's `struct rlw_iterator` (ewah_rlw.c). */
class RlwIterator {
  private pointer = 0;
  runningLen = 0;
  literalWords = 0;
  runningBit = 0;
  literalWordStart = 0;
  constructor(private readonly src: EwahBitmap) {
    this.nextWord();
    this.literalWordStart = this.pointer - this.literalWords;
  }
  wordSize(): number {
    return this.runningLen + this.literalWords;
  }
  private nextWord(): boolean {
    if (this.pointer >= this.src.bufferSize) return false;
    const f = this.src.rlwFields(this.pointer);
    this.pointer += f.literalWords + 1;
    this.literalWords = f.literalWords;
    this.runningLen = f.runningLen;
    this.runningBit = f.runBit;
    return true;
  }
  discardFirstWords(count: number): void {
    let x = count;
    while (x > 0) {
      if (this.runningLen > x) {
        this.runningLen -= x;
        return;
      }
      x -= this.runningLen;
      this.runningLen = 0;
      const discard = x > this.literalWords ? this.literalWords : x;
      this.literalWordStart += discard;
      this.literalWords -= discard;
      x -= discard;
      if (x > 0 || this.wordSize() === 0) {
        if (!this.nextWord()) break;
        this.literalWordStart = this.pointer - this.literalWords;
      }
    }
  }
  discharge(out: EwahBitmap, max: number, negate: boolean): number {
    let index = 0;
    while (index < max && this.wordSize() > 0) {
      let pl = this.runningLen;
      if (index + pl > max) pl = max - index;
      out.addEmptyWords((this.runningBit ^ (negate ? 1 : 0)) === 1, pl);
      index += pl;
      let pd = this.literalWords;
      if (pd + index > max) pd = max - index;
      out.addDirtyWords(this.src, this.literalWordStart, pd, negate);
      this.discardFirstWords(pd + pl);
      index += pd;
    }
    return index;
  }
}

/** The set bits of one word, as positions from `base`, appended to `out`. */
export function collectBits(out: number[], base: number, lo: number, hi: number): void {
  let x = lo >>> 0;
  while (x !== 0) {
    const t = x & -x;
    out.push(base + 31 - Math.clz32(t));
    x = (x ^ t) >>> 0;
  }
  x = hi >>> 0;
  while (x !== 0) {
    const t = x & -x;
    out.push(base + 63 - Math.clz32(t));
    x = (x ^ t) >>> 0;
  }
}

/** The set bits of a 32-bit word. */
export function popcount32(v: number): number {
  let x = v >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function pushU32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
