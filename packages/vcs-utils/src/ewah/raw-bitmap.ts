/**
 * An uncompressed, growable bitmap (git's `struct bitmap`, ewah/bitmap.c): what reachability
 * walks fill and combine before the result is compressed into an `EwahBitmap`.
 *
 * Words are 64 bits, held as two 32-bit halves; `wordAlloc` counts 64-bit words as git's
 * `word_alloc` does.
 */
import { EwahBitmap, popcount32 } from "./ewah-bitmap.js";

/** A word's halves with the bits at or above `limit` cleared (word `k` holds bits 64k..64k+63). */
function maskWord(k: number, lo: number, hi: number, limit: number): [number, number] {
  const start = k * 64;
  if (start + 64 <= limit) return [lo, hi];
  const keep = limit - start;
  if (keep <= 0) return [0, 0];
  if (keep <= 32) return [keep === 32 ? lo : (lo & ((1 << keep) - 1)) >>> 0, 0];
  const h = keep - 32;
  return [lo, h === 32 ? hi : (hi & ((1 << h) - 1)) >>> 0];
}

export class RawBitmap {
  /** 32-bit halves: word `k` is `w[2k]` (bits 0-31) and `w[2k + 1]` (bits 32-63) */
  private w: Uint32Array;
  private alloc: number;

  constructor(wordAlloc = 32) {
    this.alloc = wordAlloc;
    this.w = new Uint32Array(wordAlloc * 2);
  }

  /** 64-bit words allocated (git's `word_alloc`). */
  get wordAlloc(): number {
    return this.alloc;
  }

  private grow(words: number): void {
    if (words <= this.alloc) return;
    // git's ALLOC_GROW: alloc_nr(x) = (x + 16) * 3 / 2, at least what is asked
    let next = Math.floor(((this.alloc + 16) * 3) / 2);
    if (next < words) next = words;
    if (next * 2 > this.w.length) {
      const w = new Uint32Array(next * 2);
      w.set(this.w.subarray(0, this.alloc * 2));
      this.w = w;
    }
    this.alloc = next;
  }

  set(pos: number): void {
    const half = pos >>> 5;
    this.grow((half >>> 1) + 1);
    this.w[half] = ((this.w[half] as number) | (1 << (pos & 31))) >>> 0;
  }

  unset(pos: number): void {
    const half = pos >>> 5;
    if (half < this.alloc * 2) this.w[half] = ((this.w[half] as number) & ~(1 << (pos & 31))) >>> 0;
  }

  get(pos: number): boolean {
    const half = pos >>> 5;
    return half < this.alloc * 2 && ((this.w[half] as number) & (1 << (pos & 31))) !== 0;
  }

  /** git's `bitmap_or`. */
  or(other: RawBitmap): void {
    this.grow(other.alloc);
    const n = other.alloc * 2;
    for (let i = 0; i < n; i++) this.w[i] = ((this.w[i] as number) | (other.w[i] as number)) >>> 0;
  }

  /**
   * git's `bitmap_or_ewah`. With `limit`, only bits below it are taken (a bitmap read from a
   * file may claim more bits than its pack has objects): this one grows to `limit` bits at
   * most, whatever the other's size or runs say.
   */
  orEwah(other: EwahBitmap, limit = Infinity): void {
    const limitWords = Math.ceil(limit / 64);
    this.grow(Math.min(Math.ceil(other.bitSize / 64), limitWords));
    other.forEachWord((k, rawLo, rawHi) => {
      if (rawLo === 0 && rawHi === 0) return;
      const [lo, hi] = maskWord(k, rawLo, rawHi, limit);
      this.grow(k + 1);
      this.w[2 * k] = ((this.w[2 * k] as number) | lo) >>> 0;
      this.w[2 * k + 1] = ((this.w[2 * k + 1] as number) | hi) >>> 0;
    }, limitWords);
  }

  /** git's `bitmap_and_not`. */
  andNot(other: RawBitmap): void {
    const n = Math.min(this.alloc, other.alloc) * 2;
    for (let i = 0; i < n; i++) this.w[i] = ((this.w[i] as number) & ~(other.w[i] as number)) >>> 0;
  }

  /** Keeps only the bits `other` has. */
  andEwah(other: EwahBitmap): void {
    const keep = new Uint32Array(this.alloc * 2);
    other.forEachWord((k, lo, hi) => {
      if (k < this.alloc) {
        keep[2 * k] = ((this.w[2 * k] as number) & lo) >>> 0;
        keep[2 * k + 1] = ((this.w[2 * k + 1] as number) & hi) >>> 0;
      }
    }, this.alloc);
    this.w.set(keep);
  }

  /** Clears the bits `other` has (below `limit` only, when given). */
  andNotEwah(other: EwahBitmap, limit = Infinity): void {
    other.forEachWord((k, rawLo, rawHi) => {
      const [lo, hi] = maskWord(k, rawLo, rawHi, limit);
      if (k < this.alloc) {
        this.w[2 * k] = ((this.w[2 * k] as number) & ~lo) >>> 0;
        this.w[2 * k + 1] = ((this.w[2 * k + 1] as number) & ~hi) >>> 0;
      }
    }, this.alloc);
  }

  /** Whether every bit of this one is set in `other` (git's `bitmap_is_subset` negated). */
  isSubsetOf(other: RawBitmap): boolean {
    const n = this.alloc * 2;
    for (let i = 0; i < n; i++) {
      const o = i < other.alloc * 2 ? (other.w[i] as number) : 0;
      if (((this.w[i] as number) & ~o) >>> 0 !== 0) return false;
    }
    return true;
  }

  clone(): RawBitmap {
    const c = new RawBitmap(this.alloc);
    c.w.set(this.w.subarray(0, this.alloc * 2));
    return c;
  }

  popcount(): number {
    let c = 0;
    const n = this.alloc * 2;
    for (let i = 0; i < n; i++) c += popcount32(this.w[i] as number);
    return c;
  }

  /** Calls `fn` with each set bit, ascending. */
  forEach(fn: (pos: number) => void): void {
    const n = this.alloc * 2;
    for (let i = 0; i < n; i++) {
      let x = this.w[i] as number;
      while (x !== 0) {
        const t = x & -x;
        fn(i * 32 + 31 - Math.clz32(t));
        x = (x ^ t) >>> 0;
      }
    }
  }

  /** git's `bitmap_to_ewah`: trailing zero words are dropped. */
  toEwah(): EwahBitmap {
    const ewah = new EwahBitmap();
    let runningEmpty = 0;
    let lastLo = 0;
    let lastHi = 0;
    for (let k = 0; k < this.alloc; k++) {
      const lo = this.w[2 * k] as number;
      const hi = this.w[2 * k + 1] as number;
      if (lo === 0 && hi === 0) {
        runningEmpty++;
        continue;
      }
      if (lastLo !== 0 || lastHi !== 0) ewah.add(lastLo, lastHi);
      if (runningEmpty > 0) {
        ewah.addEmptyWords(false, runningEmpty);
        runningEmpty = 0;
      }
      lastLo = lo;
      lastHi = hi;
    }
    ewah.add(lastLo, lastHi);
    return ewah;
  }

  /** git's `ewah_to_bitmap`. */
  static fromEwah(ewah: EwahBitmap): RawBitmap {
    const words = Math.max(1, Math.ceil(ewah.bitSize / 64));
    const b = new RawBitmap(words);
    let count = 0;
    ewah.forEachWord((k, lo, hi) => {
      b.grow(k + 1);
      b.w[2 * k] = lo;
      b.w[2 * k + 1] = hi;
      count = k + 1;
    });
    if (count > 0 && count < b.alloc) b.alloc = Math.max(count, b.alloc);
    return b;
  }
}
