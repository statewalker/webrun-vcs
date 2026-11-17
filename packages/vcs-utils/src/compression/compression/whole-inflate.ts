/**
 * One-shot zlib inflate for a stream held whole in memory, written for small objects.
 *
 * `StreamInflater` (pako, a port of zlib's streaming state machine) pays for being resumable:
 * every symbol goes through its mode switch, its fast loop only runs with 258 bytes of output
 * room, and small objects never get there. Here the whole input is in hand and the output's
 * size is usually known (a pack entry's header gives it), so the decoder is one loop over
 * the input writing straight into the result:
 *
 *  - Huffman tables are built as zlib's `inflate_table` builds them (a root table indexed by
 *    the next 9 bits, 6 for distances, and sub-tables for longer codes), into typed arrays
 *    allocated once; it refuses the same code sets (over-subscribed, incomplete except for a
 *    single one-bit code);
 *  - the decoding loop is zlib's `inflate_fast` while at least 8 input bytes are left, with
 *    the output bound checked per symbol instead of reserving 258 bytes (small objects
 *    decoded into a buffer of their exact size would otherwise never take it), and zlib's
 *    one-symbol-at-a-time `inflate` steps near the end of the input, which pull bytes only as
 *    a code needs them;
 *  - stored block lengths, distances, repeat codes, the zlib header and the Adler-32 trailer
 *    are checked, so a stream decodes to exactly what zlib decodes or fails where zlib fails.
 *
 * Errors: `InflateError` for corrupt data, `TruncatedStreamError` when the input ends inside
 * the stream, `InflateOverflowError` when the output would not fit.
 */
import { InflateError, TruncatedStreamError } from "./stream-inflater.js";

/** The stream inflates to more bytes than the output can hold. */
export class InflateOverflowError extends InflateError {
  constructor(message = "stream inflates past the expected size") {
    super(message);
    this.name = "InflateOverflowError";
  }
}

export interface WholeInflateOptions {
  /**
   * Write here, from offset 0: the output may not exceed its length. Without it, a buffer of
   * `size` bytes is allocated, or (without `size`) one that grows up to `maxSize`.
   */
  into?: Uint8Array;
  /** The expected size: the output may not exceed it. */
  size?: number;
  /** Without `into` or `size`: the most bytes the output may grow to. Default 1 GiB. */
  maxSize?: number;
  /**
   * Stop, without an error, once the output is full (`ended` false), as zlib does with a full
   * output buffer: the part of a stored block or a match that fits is written first, so the
   * output holds the first `length` bytes of the stream. To read the start of a stream, such
   * as an object header, without inflating all of it.
   */
  partial?: boolean;
}

export interface WholeInflateResult {
  /** The output buffer: `into`, the allocated one, or the grown one (`length` bytes used). */
  data: Uint8Array;
  /** Bytes produced. */
  length: number;
  /** Bytes of the input the stream took (header and Adler-32 trailer included); -1 if not `ended`. */
  consumed: number;
  /** False when a `partial` inflate stopped before the end of the stream. */
  ended: boolean;
}

/** Thrown by `grow` to stop a `partial` inflate, caught by `inflateWhole`. */
const STOP = Symbol("stop");

/*
 * A table entry is `bits | op << 8 | val << 16`, as zlib's `code`:
 *  - op 0: a literal (`val`), or a code length symbol in the code length table;
 *  - op 16 + n: a length or distance base (`val`) followed by n extra bits;
 *  - op 1..15: in a root table, a link to the sub-table at `val` indexed by op more bits;
 *  - op 96: end of block; op 64: an invalid code.
 * `bits` is what the entry's code takes (the root bits for a link).
 */
const OP_BASE = 16;
const OP_EOB = 96;
const OP_BAD = 64;

/** Length bases and ops, for symbols 257..287 (286 and 287 are invalid). */
const LBASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258, 0, 0,
]);
const LOP = new Uint8Array([
  16,
  16,
  16,
  16,
  16,
  16,
  16,
  16,
  17,
  17,
  17,
  17,
  18,
  18,
  18,
  18,
  19,
  19,
  19,
  19,
  20,
  20,
  20,
  20,
  21,
  21,
  21,
  21,
  16,
  OP_BAD,
  OP_BAD,
]);
/** Distance bases and ops, for symbols 0..31 (30 and 31 are invalid). */
const DBASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0,
]);
const DOP = new Uint8Array([
  16,
  16,
  16,
  16,
  17,
  17,
  18,
  18,
  19,
  19,
  20,
  20,
  21,
  21,
  22,
  22,
  23,
  23,
  24,
  24,
  25,
  25,
  26,
  26,
  27,
  27,
  28,
  28,
  29,
  29,
  OP_BAD,
  OP_BAD,
]);
/** Order of the code length code lengths. */
const CLORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/** Table entries without their bits, by symbol: code length symbols, literal/lengths, distances. */
const CODE_ENTRY = new Int32Array(19);
for (let s = 0; s < 19; s++) CODE_ENTRY[s] = s << 16;
const LIT_ENTRY = new Int32Array(288);
for (let s = 0; s < 288; s++)
  LIT_ENTRY[s] =
    s < 256
      ? s << 16
      : s === 256
        ? OP_EOB << 8
        : ((LOP[s - 257] as number) << 8) | ((LBASE[s - 257] as number) << 16);
const DIST_ENTRY = new Int32Array(32);
for (let s = 0; s < 32; s++)
  DIST_ENTRY[s] = ((DOP[s] as number) << 8) | ((DBASE[s] as number) << 16);

/** zlib's ENOUGH_LENS and ENOUGH_DISTS: the largest tables for root bits 9 and 6. */
const ENOUGH_LENS = 852;
const ENOUGH_DISTS = 592;

const offs = new Uint16Array(16);
const work = new Uint16Array(288);

/**
 * A code set as the table builder takes it: `count[len]` codes of each length and `syms`, the
 * `n` symbols with a code (lengths in `lens[from + sym]`), in symbol order. The reader of a
 * dynamic block header fills it as it decodes the lengths, so the builder never scans the
 * symbols without a code.
 */
interface CodeSet {
  count: Uint16Array;
  syms: Uint16Array;
  n: number;
}

const newCodeSet = (symbols: number): CodeSet => ({
  count: new Uint16Array(16),
  syms: new Uint16Array(symbols),
  n: 0,
});

/** Fills `set` from the code lengths `lens[from, from + n)`. */
function countLengths(set: CodeSet, lens: Uint8Array, from: number, n: number): CodeSet {
  const { count, syms } = set;
  count.fill(0);
  let k = 0;
  for (let s = 0; s < n; s++) {
    const len = lens[from + s] as number;
    if (len !== 0) {
      count[len]++;
      syms[k++] = s;
    }
  }
  set.n = k;
  return set;
}

/**
 * zlib's `inflate_table`: builds the decoding table for the code set `set` (consuming its
 * counts) into `table` and returns its root bits (`root` or fewer), or -1 for a set zlib
 * refuses: over-subscribed, or incomplete unless it is a lone one-bit code (literal/length and
 * distance codes only, `entries` other than `CODE_ENTRY`).
 */
function buildTable(
  entries: Int32Array,
  set: CodeSet,
  lens: Uint8Array,
  from: number,
  table: Int32Array,
  root: number,
): number {
  const { count, syms } = set;
  let max = 15;
  while (max >= 1 && count[max] === 0) max--;
  if (root > max) root = max;
  if (max === 0) {
    // no codes at all: every lookup is an invalid code of one bit (a code length 0 in the code length table)
    table[0] = 1 | (OP_BAD << 8);
    table[1] = 1 | (OP_BAD << 8);
    return 1;
  }
  let min = 1;
  while (min < max && count[min] === 0) min++;
  if (root < min) root = min;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= count[len] as number;
    if (left < 0) return -1; // over-subscribed
  }
  if (left > 0 && (entries === CODE_ENTRY || max !== 1)) return -1; // incomplete
  // the symbols by code length, then symbol order: the order of their canonical codes
  offs[1] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = (offs[len] as number) + (count[len] as number);
  for (let i = 0; i < set.n; i++) {
    const s = syms[i] as number;
    work[offs[lens[from + s] as number]++ as number] = s;
  }
  let huff = 0; // the current code, bit-reversed
  let sym = 0;
  let len = min;
  let next = 0; // the table being filled, as an offset in `table`
  let curr = root; // its index bits
  let drop = 0; // the bits dropped before indexing it
  let low = -1; // the root entry its codes share
  let used = 1 << root;
  const mask = used - 1;
  const enough = entries === LIT_ENTRY ? ENOUGH_LENS : ENOUGH_DISTS;
  for (;;) {
    const here = (entries[work[sym] as number] as number) | (len - drop);
    // every entry whose low bits are the code, in a table of `curr` bits
    const incr = 1 << (len - drop);
    let fill = 1 << curr;
    const size = fill;
    const at = next + (huff >>> drop);
    do {
      fill -= incr;
      table[at + fill] = here;
    } while (fill !== 0);
    // the next code, bit-reversed: clear the ones above the highest zero below `len`, set it
    const zeros = ~huff & ((1 << len) - 1);
    if (zeros === 0) huff = 0;
    else {
      const inc = 1 << (31 - Math.clz32(zeros));
      huff = (huff & (inc - 1)) | inc;
    }
    sym++;
    if (--count[len] === 0) {
      if (len === max) break;
      do len++;
      while (count[len] === 0);
    }
    // a code longer than the root, not under the current root entry: a new sub-table
    if (len > root && (huff & mask) !== low) {
      if (drop === 0) drop = root;
      next += size;
      curr = len - drop;
      left = 1 << curr;
      while (curr + drop < max) {
        left -= count[curr + drop] as number;
        if (left <= 0) break;
        curr++;
        left <<= 1;
      }
      used += 1 << curr;
      if (used > enough) return -1; // cannot happen for a set that passed the checks above
      low = huff & mask;
      table[low] = root | (curr << 8) | (next << 16);
    }
  }
  // an incomplete set (a lone one-bit code): the one entry no code reaches is invalid
  if (huff !== 0) table[next + huff] = (len - drop) | (OP_BAD << 8);
  return root;
}

const fixedLit = new Int32Array(512);
const fixedDist = new Int32Array(32);
{
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  buildTable(LIT_ENTRY, countLengths(newCodeSet(288), l, 0, 288), l, 0, fixedLit, 9);
  // 32 codes of 5 bits, as zlib's table: 30 and 31 decode, and are refused as distances
  const d = new Uint8Array(32).fill(5);
  buildTable(DIST_ENTRY, countLengths(newCodeSet(32), d, 0, 32), d, 0, fixedDist, 5);
}
const dynLit = new Int32Array(ENOUGH_LENS);
const dynDist = new Int32Array(ENOUGH_DISTS);
const clTable = new Int32Array(128);
const lengths = new Uint8Array(286 + 30);
const clLens = new Uint8Array(19);
const clSet = newCodeSet(19);
const litSet = newCodeSet(286);
const distSet = newCodeSet(30);

/** Whether a `Uint32Array` reads bytes little-endian (the word-wise Adler-32 assumes it). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Words summed before the 16-bit lanes of `adler32`'s sums could overflow: 255 * 22 * 23 / 2 < 2^16. */
const ADLER_WORDS = 22;

/**
 * Adler-32 of `b[from, to)`. Long runs are summed four bytes at a time: a word's even and odd
 * bytes in two 16-bit lanes each, with running sums of those sums for the weighted half.
 */
function adler32(b: Uint8Array, from: number, to: number): number {
  let a = 1;
  let s = 0;
  let i = from;
  if (to - from >= 256 && LITTLE_ENDIAN) {
    // bytes up to a 4-byte boundary of the buffer, then words
    const base = b.byteOffset;
    for (; ((base + i) & 3) !== 0; i++) {
      a += b[i] as number;
      s += a;
    }
    const words = (to - i) >> 2;
    const w = new Uint32Array(b.buffer, base + i, words);
    for (let k = 0; k < words; ) {
      const n = Math.min(words, k + ADLER_WORDS);
      const bytes = (n - k) << 2;
      let even = 0; // bytes 0 and 2 of each word, in the low and high lanes
      let odd = 0; // bytes 1 and 3
      let even2 = 0; // the sum of `even` after each word
      let odd2 = 0;
      for (; k < n; k++) {
        const x = w[k] as number;
        even = (even + (x & 0xff00ff)) | 0;
        odd = (odd + ((x >>> 8) & 0xff00ff)) | 0;
        even2 = (even2 + even) | 0;
        odd2 = (odd2 + odd) | 0;
      }
      // byte j of the block adds (bytes - j) * b[j] to s: 4 * (words left) per word, less
      // its place in the word
      const sum2 = (even2 & 0xffff) + (even2 >>> 16) + (odd2 & 0xffff) + (odd2 >>> 16);
      const placed = (odd & 0xffff) + 2 * (even >>> 16) + 3 * (odd >>> 16);
      s = (s + bytes * a + 4 * sum2 - placed) % 65521;
      a = (a + (even & 0xffff) + (even >>> 16) + (odd & 0xffff) + (odd >>> 16)) % 65521;
    }
    i += words << 2;
  }
  while (i < to) {
    // at most 5552 bytes before the sums are reduced (zlib's NMAX): they stay below 2^32
    const n = Math.min(to, i + 5552);
    for (; i < n; i++) {
      a += b[i] as number;
      s += a;
    }
    a %= 65521;
    s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/**
 * The bit reader's state, handed between `inflateWhole` (which keeps it in locals) and
 * `readDynamicTables`. `hold` keeps up to 30 bits, the next one lowest (32 only briefly for a
 * stored block's LEN/NLEN, which is read with `& 0xffff` and `>>> 16` and then dropped).
 */
const rd = { pos: 0, hold: 0, bits: 0, litBits: 0, distBits: 0 };

/**
 * Reads a dynamic block's header from `input` at `rd` and builds `dynLit` and `dynDist`
 * (root bits in `rd.litBits`, `rd.distBits`), as zlib's TABLE, LENLENS and CODELENS states.
 */
function readDynamicTables(input: Uint8Array, end: number): void {
  let pos = rd.pos;
  let hold = rd.hold;
  let bits = rd.bits;
  while (bits < 14) {
    if (pos >= end) throw new TruncatedStreamError();
    hold |= (input[pos++] as number) << bits;
    bits += 8;
  }
  const nlen = (hold & 31) + 257;
  const ndist = ((hold >> 5) & 31) + 1;
  const ncode = ((hold >> 10) & 15) + 4;
  hold >>= 14;
  bits -= 14;
  if (nlen > 286 || ndist > 30)
    throw new InflateError("inflate failed: too many length or distance symbols");
  clLens.fill(0);
  for (let k = 0; k < ncode; k++) {
    if (bits < 3) {
      if (pos >= end) throw new TruncatedStreamError();
      hold |= (input[pos++] as number) << bits;
      bits += 8;
    }
    clLens[CLORDER[k] as number] = hold & 7;
    hold >>= 3;
    bits -= 3;
  }
  const clBits = buildTable(CODE_ENTRY, countLengths(clSet, clLens, 0, 19), clLens, 0, clTable, 7);
  if (clBits < 0) throw new InflateError("inflate failed: invalid code lengths set");
  const clMask = (1 << clBits) - 1;
  const total = nlen + ndist;
  // the lengths, and the code sets they make (counts, and the symbols with a code)
  const litCount = litSet.count;
  const litSyms = litSet.syms;
  const distCount = distSet.count;
  const distSyms = distSet.syms;
  litCount.fill(0);
  distCount.fill(0);
  let nl = 0;
  let nd = 0;
  // Only lengths other than 0 are written to `lengths` (the builder reads no other); `prev`
  // is the last length, for a repeat of it.
  let prev = 0;
  for (let k = 0; k < total; ) {
    // a code and its extra bits take at most 14 bits: refilled at once while 2 bytes are left,
    // else byte by byte as zlib pulls them
    if (bits < 14 && pos + 2 <= end) {
      hold |= ((input[pos] as number) << bits) | ((input[pos + 1] as number) << (bits + 8));
      pos += 2;
      bits += 16;
    }
    let here = clTable[hold & clMask] as number;
    while ((here & 255) > bits) {
      if (pos >= end) throw new TruncatedStreamError();
      hold |= (input[pos++] as number) << bits;
      bits += 8;
      here = clTable[hold & clMask] as number;
    }
    const cb = here & 255;
    const sym = here >> 16;
    if (sym < 16) {
      hold >>= cb;
      bits -= cb;
      prev = sym;
      if (sym !== 0) {
        lengths[k] = sym;
        if (k < nlen) {
          litCount[sym]++;
          litSyms[nl++] = k;
        } else {
          distCount[sym]++;
          distSyms[nd++] = k - nlen;
        }
      }
      k++;
      continue;
    }
    // a repeat: the code and 2, 3 or 7 more bits
    const extra = sym === 16 ? 2 : sym === 17 ? 3 : 7;
    while (bits < cb + extra) {
      if (pos >= end) throw new TruncatedStreamError();
      hold |= (input[pos++] as number) << bits;
      bits += 8;
    }
    hold >>= cb;
    bits -= cb;
    let repeat = hold & ((1 << extra) - 1);
    hold >>= extra;
    bits -= extra;
    if (sym === 16) {
      if (k === 0) throw new InflateError("inflate failed: invalid bit length repeat");
      repeat += 3;
    } else {
      prev = 0;
      repeat += sym === 17 ? 3 : 11;
    }
    if (k + repeat > total) throw new InflateError("inflate failed: invalid bit length repeat");
    if (prev !== 0) {
      for (const to = k + repeat; k < to; k++) {
        lengths[k] = prev;
        if (k < nlen) {
          litCount[prev]++;
          litSyms[nl++] = k;
        } else {
          distCount[prev]++;
          distSyms[nd++] = k - nlen;
        }
      }
    } else k += repeat;
  }
  litSet.n = nl;
  distSet.n = nd;
  rd.pos = pos;
  rd.hold = hold;
  rd.bits = bits;
  // the end-of-block code has a length: symbol 256 is listed (in order, after any lower one)
  let eob = false;
  for (let i = nl - 1; i >= 0; i--) {
    const sym = litSyms[i] as number;
    if (sym <= 256) {
      eob = sym === 256;
      break;
    }
  }
  if (!eob) throw new InflateError("inflate failed: invalid code -- missing end-of-block");
  rd.litBits = buildTable(LIT_ENTRY, litSet, lengths, 0, dynLit, 9);
  if (rd.litBits < 0) throw new InflateError("inflate failed: invalid literal/lengths set");
  rd.distBits = buildTable(DIST_ENTRY, distSet, lengths, nlen, dynDist, 6);
  if (rd.distBits < 0) throw new InflateError("inflate failed: invalid distances set");
}

/**
 * A copy of `out[0, op)` in a buffer with room for `n` more bytes, at most `limit` bytes long.
 * In a `partial` inflate, `n` bytes that do not fit get a buffer of `limit` bytes (`out` itself
 * when it is that long already): the caller writes what fits and stops.
 * (Not a closure of `inflateWhole`: its locals stay in registers.)
 */
function grow(out: Uint8Array, op: number, n: number, limit: number, partial: boolean): Uint8Array {
  if (op + n > limit) {
    if (!partial) throw new InflateOverflowError();
    if (out.length >= limit) return out;
  }
  const next = new Uint8Array(Math.min(limit, Math.max(op + n, out.length * 2)));
  next.set(out.subarray(0, op));
  return next;
}

/** Copies the `len` bytes `dist` back to `op` (the regions may overlap). */
function copyMatch(out: Uint8Array, op: number, dist: number, len: number): void {
  let from = op - dist;
  if (dist >= len) {
    if (len > 12) {
      out.copyWithin(op, from, from + len);
      return;
    }
  } else if (dist === 1) {
    out.fill(out[from] as number, op, op + len);
    return;
  }
  const to = op + len;
  while (op < to) out[op++] = out[from++] as number;
}

/**
 * Inflates the zlib stream at the start of `input` in one call. Bytes after the stream are
 * not read (`consumed` says where it ended).
 *
 * @example
 * ```typescript
 * const { data, length } = inflateWhole(entryBytes, { size: declaredSize });
 * if (length !== declaredSize) throw new Error("short");
 * ```
 */
export function inflateWhole(
  input: Uint8Array,
  options: WholeInflateOptions = {},
): WholeInflateResult {
  const end = input.length;
  let out: Uint8Array;
  let limit: number;
  let growable = false;
  if (options.into) {
    out = options.into;
    limit = out.length;
  } else if (options.size !== undefined) {
    out = new Uint8Array(options.size);
    limit = options.size;
  } else {
    limit = options.maxSize ?? 2 ** 30;
    out = new Uint8Array(Math.min(limit, Math.max(64, end * 4)));
    growable = true;
  }
  let cap = out.length;
  let op = 0;
  const partial = options.partial === true;

  if (end < 2) throw new TruncatedStreamError();
  const cmf = input[0] as number;
  const flg = input[1] as number;
  if (((cmf << 8) | flg) % 31 !== 0)
    throw new InflateError("inflate failed: incorrect header check");
  if ((cmf & 15) !== 8) throw new InflateError("inflate failed: unknown compression method");
  if (cmf >> 4 > 7) throw new InflateError("inflate failed: invalid window size");
  if (flg & 0x20) throw new InflateError("inflate failed: the stream needs a preset dictionary");

  // the fast loop runs while 8 input bytes are left: a length/distance pair takes at most 48
  // bits, and the loop's refills read no further than that
  const fastEnd = end - 8;
  let pos = 2;
  let hold = 0;
  let bits = 0;
  try {
    for (let last = 0; !last; ) {
      while (bits < 3) {
        if (pos >= end) throw new TruncatedStreamError();
        hold |= (input[pos++] as number) << bits;
        bits += 8;
      }
      last = hold & 1;
      const type = (hold >> 1) & 3;
      hold >>= 3;
      bits -= 3;
      if (type === 0) {
        // stored: from the next byte boundary, LEN and its complement, then LEN bytes
        hold >>= bits & 7;
        bits -= bits & 7;
        while (bits < 32) {
          if (pos >= end) throw new TruncatedStreamError();
          hold |= (input[pos++] as number) << bits;
          bits += 8;
        }
        // the 32 bits are whole bytes read for them alone: the buffer is empty after them
        const len = hold & 0xffff;
        if (len !== ((~hold >>> 16) & 0xffff))
          throw new InflateError("inflate failed: invalid stored block lengths");
        hold = 0;
        bits = 0;
        if (op + len > cap) {
          out = grow(out, op, len, growable ? limit : cap, partial);
          cap = out.length;
          if (op + len > cap) {
            // partial: the part of the block that fits, as zlib copies it before it stops
            const room = cap - op;
            if (pos + room > end) throw new TruncatedStreamError();
            out.set(input.subarray(pos, pos + room), op);
            op = cap;
            throw STOP;
          }
        }
        if (pos + len > end) throw new TruncatedStreamError();
        out.set(input.subarray(pos, pos + len), op);
        op += len;
        pos += len;
        continue;
      }
      let lcode: Int32Array;
      let dcode: Int32Array;
      let lmask: number;
      let dmask: number;
      if (type === 1) {
        lcode = fixedLit;
        dcode = fixedDist;
        lmask = 511;
        dmask = 31;
      } else if (type === 2) {
        rd.pos = pos;
        rd.hold = hold;
        rd.bits = bits;
        readDynamicTables(input, end);
        pos = rd.pos;
        hold = rd.hold;
        bits = rd.bits;
        lcode = dynLit;
        dcode = dynDist;
        lmask = (1 << rd.litBits) - 1;
        dmask = (1 << rd.distBits) - 1;
      } else {
        throw new InflateError("inflate failed: invalid block type");
      }
      block: for (;;) {
        // zlib's inflate_fast, while enough input is left that no refill can run out of it
        // and the output has room for a literal (a match's room is checked by its length)
        while (pos < fastEnd && op < cap) {
          if (bits < 15) {
            hold |= ((input[pos] as number) << bits) | ((input[pos + 1] as number) << (bits + 8));
            pos += 2;
            bits += 16;
          }
          let here = lcode[hold & lmask] as number;
          let n = here & 255;
          hold >>= n;
          bits -= n;
          let o = (here >> 8) & 255;
          if (o !== 0) {
            if (o < OP_BASE) {
              // a code longer than the root: its sub-table
              here = lcode[(here >> 16) + (hold & ((1 << o) - 1))] as number;
              n = here & 255;
              hold >>= n;
              bits -= n;
              o = (here >> 8) & 255;
            }
            if (o !== 0) {
              if ((o & OP_BASE) === 0) {
                if (o & 32) break block; // end of block
                throw new InflateError("inflate failed: invalid literal/length code");
              }
              let len = here >> 16;
              o &= 15;
              if (o !== 0) {
                if (bits < o) {
                  hold |= (input[pos++] as number) << bits;
                  bits += 8;
                }
                len += hold & ((1 << o) - 1);
                hold >>= o;
                bits -= o;
              }
              if (bits < 15) {
                hold |=
                  ((input[pos] as number) << bits) | ((input[pos + 1] as number) << (bits + 8));
                pos += 2;
                bits += 16;
              }
              here = dcode[hold & dmask] as number;
              n = here & 255;
              hold >>= n;
              bits -= n;
              o = (here >> 8) & 255;
              if ((o & OP_BASE) === 0) {
                if (o & OP_BAD) throw new InflateError("inflate failed: invalid distance code");
                here = dcode[(here >> 16) + (hold & ((1 << o) - 1))] as number;
                n = here & 255;
                hold >>= n;
                bits -= n;
                o = (here >> 8) & 255;
                if ((o & OP_BASE) === 0)
                  throw new InflateError("inflate failed: invalid distance code");
              }
              let dist = here >> 16;
              o &= 15;
              if (o !== 0) {
                if (bits < o) {
                  hold |= (input[pos++] as number) << bits;
                  bits += 8;
                  if (bits < o) {
                    hold |= (input[pos++] as number) << bits;
                    bits += 8;
                  }
                }
                dist += hold & ((1 << o) - 1);
                hold >>= o;
                bits -= o;
              }
              if (dist > op)
                throw new InflateError("inflate failed: invalid distance too far back");
              if (op + len > cap) {
                out = grow(out, op, len, growable ? limit : cap, partial);
                cap = out.length;
                if (op + len > cap) {
                  // partial: the part of the match that fits
                  copyMatch(out, op, dist, cap - op);
                  op = cap;
                  throw STOP;
                }
              }
              copyMatch(out, op, dist, len);
              op += len;
              continue;
            }
          }
          out[op++] = here >> 16;
        }
        // one symbol as zlib's inflate takes it: bytes pulled only as the code needs them
        let here = lcode[hold & lmask] as number;
        while ((here & 255) > bits) {
          if (pos >= end) throw new TruncatedStreamError();
          hold |= (input[pos++] as number) << bits;
          bits += 8;
          here = lcode[hold & lmask] as number;
        }
        let o = (here >> 8) & 255;
        if (o !== 0 && o < OP_BASE) {
          here = subEntry(lcode, here, input, end, pos, hold, bits);
          pos = rd.pos;
          hold = rd.hold;
          bits = rd.bits;
          o = (here >> 8) & 255;
        }
        hold >>= here & 255;
        bits -= here & 255;
        if (o === 0) {
          if (op >= cap) {
            out = grow(out, op, 1, growable ? limit : cap, partial);
            cap = out.length;
            if (op >= cap) throw STOP;
          }
          out[op++] = here >> 16;
          continue;
        }
        if ((o & OP_BASE) === 0) {
          if (o & 32) break; // end of block
          throw new InflateError("inflate failed: invalid literal/length code");
        }
        let len = here >> 16;
        o &= 15;
        if (o !== 0) {
          while (bits < o) {
            if (pos >= end) throw new TruncatedStreamError();
            hold |= (input[pos++] as number) << bits;
            bits += 8;
          }
          len += hold & ((1 << o) - 1);
          hold >>= o;
          bits -= o;
        }
        here = dcode[hold & dmask] as number;
        while ((here & 255) > bits) {
          if (pos >= end) throw new TruncatedStreamError();
          hold |= (input[pos++] as number) << bits;
          bits += 8;
          here = dcode[hold & dmask] as number;
        }
        o = (here >> 8) & 255;
        if (o !== 0 && o < OP_BASE) {
          here = subEntry(dcode, here, input, end, pos, hold, bits);
          pos = rd.pos;
          hold = rd.hold;
          bits = rd.bits;
          o = (here >> 8) & 255;
        }
        hold >>= here & 255;
        bits -= here & 255;
        if (o & OP_BAD) throw new InflateError("inflate failed: invalid distance code");
        let dist = here >> 16;
        o &= 15;
        if (o !== 0) {
          while (bits < o) {
            if (pos >= end) throw new TruncatedStreamError();
            hold |= (input[pos++] as number) << bits;
            bits += 8;
          }
          dist += hold & ((1 << o) - 1);
          hold >>= o;
          bits -= o;
        }
        if (dist > op) throw new InflateError("inflate failed: invalid distance too far back");
        if (op + len > cap) {
          out = grow(out, op, len, growable ? limit : cap, partial);
          cap = out.length;
          if (op + len > cap) {
            // partial: the part of the match that fits
            copyMatch(out, op, dist, cap - op);
            op = cap;
            throw STOP;
          }
        }
        copyMatch(out, op, dist, len);
        op += len;
      }
    }
    // the Adler-32 trailer, from the next byte boundary
    hold >>= bits & 7;
    bits -= bits & 7;
    let check = 0;
    for (let k = 0; k < 4; k++) {
      if (bits < 8) {
        if (pos >= end) throw new TruncatedStreamError();
        hold |= (input[pos++] as number) << bits;
        bits += 8;
      }
      check = check * 256 + (hold & 255);
      hold >>= 8;
      bits -= 8;
    }
    if (check !== adler32(out, 0, op))
      throw new InflateError("inflate failed: incorrect data check");
    return { data: out, length: op, consumed: pos - (bits >> 3), ended: true };
  } catch (e) {
    if (e === STOP) return { data: out, length: op, consumed: -1, ended: false };
    throw e;
  }
}

/**
 * The sub-table entry under the root entry `link`, pulling input bytes until the whole code
 * is in the buffer; leaves the reader in `rd` with the root bits dropped.
 */
function subEntry(
  table: Int32Array,
  link: number,
  input: Uint8Array,
  end: number,
  pos: number,
  hold: number,
  bits: number,
): number {
  const rootBits = link & 255;
  const o = (link >> 8) & 255;
  const at = link >> 16;
  let here = table[at + ((hold & ((1 << (rootBits + o)) - 1)) >> rootBits)] as number;
  while (rootBits + (here & 255) > bits) {
    if (pos >= end) throw new TruncatedStreamError();
    hold |= (input[pos++] as number) << bits;
    bits += 8;
    here = table[at + ((hold & ((1 << (rootBits + o)) - 1)) >> rootBits)] as number;
  }
  rd.pos = pos;
  rd.hold = hold >> rootBits;
  rd.bits = bits - rootBits;
  return here;
}
