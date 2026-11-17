/**
 * One-shot zlib inflate for a stream held whole in memory, written for small objects.
 *
 * `StreamInflater` (pako, a port of zlib's streaming state machine) pays for being resumable:
 * every symbol goes through its mode switch, its fast loop only runs with 258 bytes of output
 * room, and small objects never get there. Here the whole input is in hand and the output's
 * size is usually known (a pack entry's header gives it), so the decoder is one loop over
 * the input writing straight into the result:
 *
 *  - Huffman codes up to 9 bits are decoded with one table lookup, longer ones bit by bit
 *    from the canonical code (as zlib's puff.c);
 *  - code sets are checked as zlib's inflate_table checks them (over-subscribed, incomplete
 *    except for a single code, a missing end-of-block code), and so are stored block lengths,
 *    distances, repeat codes and the zlib header;
 *  - the Adler-32 trailer is checked, so a stream decodes to exactly what zlib decodes or
 *    fails as zlib fails.
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
   * Stop, without an error, at the first symbol that does not fit the output (`ended` false):
   * to read the start of a stream, such as an object header, without inflating all of it.
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

const LBASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]);
const LEXT = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DBASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DEXT = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
/** Order of the code length code lengths. */
const CLORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/** Most bits resolved by one table lookup. */
const FAST_BITS = 9;
const FAST_SIZE = 1 << FAST_BITS;

/** `REV9[c]`: the 9-bit `c` with its bits reversed. */
const REV9 = new Uint16Array(FAST_SIZE);
for (let c = 0; c < FAST_SIZE; c++) {
  let r = 0;
  for (let k = 0; k < FAST_BITS; k++) r |= ((c >> k) & 1) << (FAST_BITS - 1 - k);
  REV9[c] = r;
}

/** A canonical Huffman code: counts per length and symbols in code order, plus a lookup table. */
interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
  /**
   * By the next `bits` input bits: symbol << 4 | code length; 0 for the prefix of a longer
   * code, or of no code.
   */
  fast: Int32Array;
  /** `(1 << bits) - 1`, bits = min(FAST_BITS, longest code) */
  mask: number;
}

const newHuffman = (symbols: number): Huffman => ({
  count: new Uint16Array(16),
  symbol: new Uint16Array(symbols),
  fast: new Int32Array(FAST_SIZE),
  mask: 0,
});

const offs = new Uint16Array(16);
const nextCode = new Uint16Array(16);

/**
 * Builds `h` from code lengths `lens[from, from + n)`. Returns false for a set zlib refuses:
 * over-subscribed, or incomplete unless `single` allows a lone one-bit code (literal/length
 * and distance codes, as zlib).
 */
function build(h: Huffman, lens: Uint8Array, from: number, n: number, single: boolean): boolean {
  const { count, symbol, fast } = h;
  count.fill(0);
  for (let s = 0; s < n; s++) count[lens[from + s] as number]++;
  count[0] = 0;
  let max = 15;
  while (max > 0 && count[max] === 0) max--;
  const bits = Math.max(1, Math.min(FAST_BITS, max));
  const size = 1 << bits;
  h.mask = size - 1;
  if (max === 0) {
    fast.fill(0, 0, size);
    return true; // no codes at all: any use of the code fails
  }
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= count[len] as number;
    if (left < 0) return false; // over-subscribed
  }
  if (left > 0) {
    if (!single || max !== 1) return false; // incomplete
    fast.fill(0, 0, size); // entries no code reaches stay invalid
  }
  offs[1] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = (offs[len] as number) + (count[len] as number);
  // canonical codes: by length, then symbol order
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    nextCode[len] = code;
    code = (code + (count[len] as number)) << 1;
  }
  for (let s = 0; s < n; s++) {
    const len = lens[from + s] as number;
    if (len === 0) continue;
    symbol[offs[len]++ as number] = s;
    const c = nextCode[len]++ as number;
    if (len <= bits) {
      // deflate sends codes most significant bit first: the table is indexed by reversed codes
      const r = (REV9[c] as number) >> (FAST_BITS - len);
      const entry = (s << 4) | len;
      for (let i = r; i < size; i += 1 << len) fast[i] = entry;
    } else {
      // the prefix of a longer code: decoded bit by bit (a complete code reaches every entry,
      // so the table needs no clearing)
      fast[(REV9[c >> (len - bits)] as number) >> (FAST_BITS - bits)] = 0;
    }
  }
  return true;
}

const fixedLit = newHuffman(288);
const fixedDist = newHuffman(32);
{
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  build(fixedLit, l, 0, 288, true);
  // 32 codes of 5 bits, as zlib's table: 30 and 31 decode, and are refused as distances
  build(fixedDist, new Uint8Array(32).fill(5), 0, 32, true);
}
const dynLit = newHuffman(288);
const dynDist = newHuffman(30);
const clCode = newHuffman(19);
const lengths = new Uint8Array(286 + 30);
const clLens = new Uint8Array(19);

/** Adler-32 of `b[from, to)`. */
function adler32(b: Uint8Array, from: number, to: number): number {
  let a = 1;
  let s = 0;
  for (let i = from; i < to; ) {
    // at most 5552 bytes before the sums are reduced (zlib's NMAX): they stay below 2^32
    const n = Math.min(to, i + 5552);
    for (const n8 = n - 8; i <= n8; i += 8) {
      a += b[i] as number;
      s += a;
      a += b[i + 1] as number;
      s += a;
      a += b[i + 2] as number;
      s += a;
      a += b[i + 3] as number;
      s += a;
      a += b[i + 4] as number;
      s += a;
      a += b[i + 5] as number;
      s += a;
      a += b[i + 6] as number;
      s += a;
      a += b[i + 7] as number;
      s += a;
    }
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
 * The bit reader of the rare paths (block headers, codes longer than the lookup table): the
 * hot loop keeps its position in locals and hands it over here and back.
 */
const rd: { input: Uint8Array; pos: number; end: number; bb: number; bc: number } = {
  input: new Uint8Array(0),
  pos: 0,
  end: 0,
  bb: 0,
  bc: 0,
};

function rdBits(n: number): number {
  if (rd.bc < n) {
    while (rd.bc <= 24 && rd.pos < rd.end) {
      rd.bb |= (rd.input[rd.pos++] as number) << rd.bc;
      rd.bc += 8;
    }
    if (rd.bc < n) throw new TruncatedStreamError();
  }
  const v = rd.bb & ((1 << n) - 1);
  rd.bb >>>= n;
  rd.bc -= n;
  return v;
}

/** The next symbol of `h`, or -1 for an invalid code. */
function rdDecode(h: Huffman): number {
  if (rd.bc < 15) {
    while (rd.bc <= 24 && rd.pos < rd.end) {
      rd.bb |= (rd.input[rd.pos++] as number) << rd.bc;
      rd.bc += 8;
    }
  }
  const entry = h.fast[rd.bb & h.mask] as number;
  if (entry !== 0 && (entry & 15) <= rd.bc) {
    rd.bb >>>= entry & 15;
    rd.bc -= entry & 15;
    return entry >> 4;
  }
  // a code longer than the table, or none: the canonical code, bit by bit (puff.c)
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= rdBits(1);
    const count = h.count[len] as number;
    if (code - count < first) return h.symbol[index + (code - first)] as number;
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  return -1;
}

/** Reads a dynamic block's code lengths and builds `dynLit` and `dynDist` from them. */
function readDynamicTables(): void {
  const nlen = rdBits(5) + 257;
  const ndist = rdBits(5) + 1;
  const ncode = rdBits(4) + 4;
  if (nlen > 286 || ndist > 30)
    throw new InflateError("inflate failed: too many length or distance symbols");
  clLens.fill(0);
  for (let k = 0; k < ncode; k++) clLens[CLORDER[k] as number] = rdBits(3);
  if (!build(clCode, clLens, 0, 19, false))
    throw new InflateError("inflate failed: invalid code lengths set");
  const total = nlen + ndist;
  // the code length symbols, with the reader in locals (handed to `rdDecode` for long codes)
  const input = rd.input;
  const end = rd.end;
  const clFast = clCode.fast;
  const clMask = clCode.mask;
  let pos = rd.pos;
  let bb = rd.bb;
  let bc = rd.bc;
  for (let k = 0; k < total; ) {
    if (bc < 14) {
      while (bc <= 24 && pos < end) {
        bb |= (input[pos++] as number) << bc;
        bc += 8;
      }
    }
    let sym: number;
    const entry = clFast[bb & clMask] as number;
    if (entry !== 0 && (entry & 15) <= bc) {
      bb >>>= entry & 15;
      bc -= entry & 15;
      sym = entry >> 4;
    } else {
      rd.pos = pos;
      rd.bb = bb;
      rd.bc = bc;
      sym = rdDecode(clCode);
      pos = rd.pos;
      bb = rd.bb;
      bc = rd.bc;
    }
    if (sym < 16) {
      if (sym < 0) throw new InflateError("inflate failed: invalid code lengths set");
      lengths[k++] = sym;
      continue;
    }
    // a repeat: 2, 3 or 7 more bits (refilled above to 14 bits or the input's end)
    const extra = sym === 16 ? 2 : sym === 17 ? 3 : 7;
    if (bc < extra) {
      while (bc <= 24 && pos < end) {
        bb |= (input[pos++] as number) << bc;
        bc += 8;
      }
      if (bc < extra) throw new TruncatedStreamError();
    }
    const n = bb & ((1 << extra) - 1);
    bb >>>= extra;
    bc -= extra;
    let value = 0;
    let repeat: number;
    if (sym === 16) {
      if (k === 0) throw new InflateError("inflate failed: invalid bit length repeat");
      value = lengths[k - 1] as number;
      repeat = 3 + n;
    } else if (sym === 17) {
      repeat = 3 + n;
    } else {
      repeat = 11 + n;
    }
    if (k + repeat > total) throw new InflateError("inflate failed: invalid bit length repeat");
    lengths.fill(value, k, k + repeat);
    k += repeat;
  }
  rd.pos = pos;
  rd.bb = bb;
  rd.bc = bc;
  if (lengths[256] === 0)
    throw new InflateError("inflate failed: invalid code -- missing end-of-block");
  if (!build(dynLit, lengths, 0, nlen, true))
    throw new InflateError("inflate failed: invalid literal/lengths set");
  if (!build(dynDist, lengths, nlen, ndist, true))
    throw new InflateError("inflate failed: invalid distances set");
}

/**
 * A copy of `out[0, op)` in a buffer with room for `n` more bytes, at most `limit` bytes long.
 * (Not a closure of `inflateWhole`: its locals stay in registers.)
 */
function grow(out: Uint8Array, op: number, n: number, limit: number, partial: boolean): Uint8Array {
  if (op + n > limit) throw partial ? STOP : new InflateOverflowError();
  const next = new Uint8Array(Math.min(limit, Math.max(op + n, out.length * 2)));
  next.set(out.subarray(0, op));
  return next;
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

  rd.input = input;
  rd.pos = 2;
  rd.end = end;
  rd.bb = 0;
  rd.bc = 0;
  try {
    for (let last = 0; !last; ) {
      last = rdBits(1);
      const type = rdBits(2);
      if (type === 0) {
        // stored: from the next byte boundary, LEN and its complement, then LEN bytes
        rd.bb >>>= rd.bc & 7;
        rd.bc -= rd.bc & 7;
        const len = rdBits(16);
        const nlen = rdBits(16);
        if (len !== (~nlen & 0xffff))
          throw new InflateError("inflate failed: invalid stored block lengths");
        if (op + len > cap) {
          out = grow(out, op, len, growable ? limit : cap, partial);
          cap = out.length;
        }
        // bytes still in the bit buffer go first (whole bytes: it is byte aligned)
        let k = 0;
        for (; k < len && rd.bc >= 8; k++) {
          out[op++] = rd.bb & 255;
          rd.bb >>>= 8;
          rd.bc -= 8;
        }
        const rest = len - k;
        if (rd.pos + rest > end) throw new TruncatedStreamError();
        out.set(input.subarray(rd.pos, rd.pos + rest), op);
        op += rest;
        rd.pos += rest;
        continue;
      }
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        lit = fixedLit;
        dist = fixedDist;
      } else if (type === 2) {
        readDynamicTables();
        lit = dynLit;
        dist = dynDist;
      } else {
        throw new InflateError("inflate failed: invalid block type");
      }
      // the hot loop: the reader's state in locals
      const litFast = lit.fast;
      const litMask = lit.mask;
      const distFast = dist.fast;
      const distMask = dist.mask;
      let pos = rd.pos;
      let bb = rd.bb;
      let bc = rd.bc;
      block: for (;;) {
        // The fast region (inflate_fast's): with 16 input bytes and 258 bytes of output room
        // left, no symbol can run out of either, so they are not checked per byte.
        while (pos + 16 <= end && op + 258 <= cap) {
          if (bc < 16) {
            bb |= ((input[pos] as number) << bc) | ((input[pos + 1] as number) << (bc + 8));
            pos += 2;
            bc += 16;
          }
          let entry = litFast[bb & litMask] as number;
          if (entry === 0) break; // a long code: the checked loop below
          bb >>>= entry & 15;
          bc -= entry & 15;
          const sym = entry >> 4;
          if (sym < 256) {
            out[op++] = sym;
            continue;
          }
          if (sym === 256) break block;
          const li = sym - 257;
          if (li >= 29) throw new InflateError("inflate failed: invalid literal/length code");
          if (bc < 16) {
            bb |= ((input[pos] as number) << bc) | ((input[pos + 1] as number) << (bc + 8));
            pos += 2;
            bc += 16;
          }
          let len = LBASE[li] as number;
          const lx = LEXT[li] as number;
          len += bb & ((1 << lx) - 1);
          bb >>>= lx;
          bc -= lx;
          if (bc < 16) {
            bb |= ((input[pos] as number) << bc) | ((input[pos + 1] as number) << (bc + 8));
            pos += 2;
            bc += 16;
          }
          entry = distFast[bb & distMask] as number;
          let ds: number;
          if (entry !== 0) {
            bb >>>= entry & 15;
            bc -= entry & 15;
            ds = entry >> 4;
          } else {
            rd.pos = pos;
            rd.bb = bb;
            rd.bc = bc;
            ds = rdDecode(dist);
            pos = rd.pos;
            bb = rd.bb;
            bc = rd.bc;
          }
          if (ds < 0 || ds >= 30) throw new InflateError("inflate failed: invalid distance code");
          if (bc < 16) {
            bb |= ((input[pos] as number) << bc) | ((input[pos + 1] as number) << (bc + 8));
            pos += 2;
            bc += 16;
          }
          const dx = DEXT[ds] as number;
          const d = (DBASE[ds] as number) + (bb & ((1 << dx) - 1));
          bb >>>= dx;
          bc -= dx;
          if (d > op) throw new InflateError("inflate failed: invalid distance too far back");
          let from = op - d;
          if (d >= len && len > 12) {
            out.copyWithin(op, from, from + len);
            op += len;
          } else {
            while (len-- > 0) out[op++] = out[from++] as number;
          }
        }
        // one symbol, every bound checked
        if (bc < 15) {
          while (bc <= 24 && pos < end) {
            bb |= (input[pos++] as number) << bc;
            bc += 8;
          }
        }
        let sym: number;
        let entry = litFast[bb & litMask] as number;
        if (entry !== 0 && (entry & 15) <= bc) {
          bb >>>= entry & 15;
          bc -= entry & 15;
          sym = entry >> 4;
        } else {
          rd.pos = pos;
          rd.bb = bb;
          rd.bc = bc;
          sym = rdDecode(lit);
          pos = rd.pos;
          bb = rd.bb;
          bc = rd.bc;
        }
        if (sym < 256) {
          if (sym < 0) throw new InflateError("inflate failed: invalid literal/length code");
          if (op >= cap) {
            out = grow(out, op, 1, growable ? limit : cap, partial);
            cap = out.length;
          }
          out[op++] = sym;
          continue;
        }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= 29) throw new InflateError("inflate failed: invalid literal/length code");
        // length extra bits (at most 5), then the distance code (at most 15 bits)
        let len = LBASE[li] as number;
        const lx = LEXT[li] as number;
        if (bc < 20) {
          while (bc <= 24 && pos < end) {
            bb |= (input[pos++] as number) << bc;
            bc += 8;
          }
        }
        if (lx) {
          if (bc < lx) throw new TruncatedStreamError();
          len += bb & ((1 << lx) - 1);
          bb >>>= lx;
          bc -= lx;
        }
        let ds: number;
        entry = distFast[bb & distMask] as number;
        if (entry !== 0 && (entry & 15) <= bc) {
          bb >>>= entry & 15;
          bc -= entry & 15;
          ds = entry >> 4;
        } else {
          rd.pos = pos;
          rd.bb = bb;
          rd.bc = bc;
          ds = rdDecode(dist);
          pos = rd.pos;
          bb = rd.bb;
          bc = rd.bc;
        }
        if (ds < 0 || ds >= 30) throw new InflateError("inflate failed: invalid distance code");
        let d = DBASE[ds] as number;
        const dx = DEXT[ds] as number;
        if (dx) {
          if (bc < dx) {
            while (bc <= 24 && pos < end) {
              bb |= (input[pos++] as number) << bc;
              bc += 8;
            }
            if (bc < dx) throw new TruncatedStreamError();
          }
          d += bb & ((1 << dx) - 1);
          bb >>>= dx;
          bc -= dx;
        }
        if (d > op) throw new InflateError("inflate failed: invalid distance too far back");
        if (op + len > cap) {
          out = grow(out, op, len, growable ? limit : cap, partial);
          cap = out.length;
        }
        let from = op - d;
        if (d >= len && len > 12) {
          out.copyWithin(op, from, from + len);
          op += len;
        } else {
          while (len-- > 0) out[op++] = out[from++] as number;
        }
      }
      rd.pos = pos;
      rd.bb = bb;
      rd.bc = bc;
    }
    // the Adler-32 trailer, from the next byte boundary
    rd.bb >>>= rd.bc & 7;
    rd.bc -= rd.bc & 7;
    const check = ((rdBits(8) << 24) | (rdBits(8) << 16) | (rdBits(8) << 8) | rdBits(8)) >>> 0;
    if (check !== adler32(out, 0, op))
      throw new InflateError("inflate failed: incorrect data check");
    return { data: out, length: op, consumed: rd.pos - (rd.bc >> 3), ended: true };
  } catch (e) {
    if (e === STOP) return { data: out, length: op, consumed: -1, ended: false };
    throw e;
  } finally {
    // the reader keeps no reference to the caller's input
    rd.input = EMPTY;
  }
}

const EMPTY = new Uint8Array(0);
