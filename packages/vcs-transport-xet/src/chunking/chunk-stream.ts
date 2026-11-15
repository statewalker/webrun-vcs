/**
 * Xet's content-defined chunking (xet-core `deduplication::Chunker`, the specification's
 * "Content-Defined Chunking"): a gear hash, target 64 KiB, at least 8 KiB, at most 128 KiB.
 */

import { GEAR_TABLE } from "./gear-table.js";

/** the smallest chunk but the last (8 KiB) */
export const XET_MIN_CHUNK = 8 * 1024;
/** the target (mean) chunk size: the mask has 16 bits (64 KiB) */
export const XET_TARGET_CHUNK = 64 * 1024;
/** the largest chunk: a boundary is forced here (128 KiB) */
export const XET_MAX_CHUNK = 128 * 1024;

/** the first byte hashed: the gear hash looks back 64 bytes, so the minimum size less 64, less 1 */
const FIRST_HASHED = XET_MIN_CHUNK - 64 - 1;
const GEAR_HI = Uint32Array.from(GEAR_TABLE, (v) => Number(v >> 32n));
const GEAR_LO = Uint32Array.from(GEAR_TABLE, (v) => Number(v & 0xffffffffn));

/**
 * Xet's content-defined chunks of a byte stream: the gear hash `h = (h << 1) + TABLE[b]` (64-bit,
 * kept as two 32-bit halves, since BigInt per byte is slow), a boundary after a byte where
 * `h & 0xFFFF000000000000 == 0` once the chunk has at least 8 KiB, and always at 128 KiB; the hash
 * restarts at each boundary. At most one chunk (128 KiB) is buffered.
 */
export async function* chunkStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let parts: Uint8Array[] = [];
  let length = 0; // bytes in the current chunk
  let hi = 0;
  let lo = 0;
  const take = (): Uint8Array => {
    const out = new Uint8Array(length);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    parts = [];
    length = 0;
    hi = 0;
    lo = 0;
    return out;
  };
  for await (const piece of source) {
    let start = 0;
    let i = 0;
    while (i < piece.length) {
      // skip what can neither end a chunk nor affect its first possible boundary
      if (length < FIRST_HASHED) {
        const skip = Math.min(FIRST_HASHED - length, piece.length - i);
        i += skip;
        length += skip;
        continue;
      }
      const b = piece[i] as number;
      const nlo = (lo << 1) >>> 0;
      const nhi = ((hi << 1) | (lo >>> 31)) >>> 0;
      const sum = nlo + (GEAR_LO[b] as number);
      lo = sum >>> 0;
      hi = (nhi + (GEAR_HI[b] as number) + (sum > 0xffffffff ? 1 : 0)) >>> 0;
      i++;
      length++;
      if ((length >= XET_MIN_CHUNK && hi >>> 16 === 0) || length === XET_MAX_CHUNK) {
        parts.push(piece.subarray(start, i));
        start = i;
        yield take();
      }
    }
    // a copy: the caller may reuse its buffer once the next piece is asked for
    if (start < piece.length) parts.push(piece.slice(start));
  }
  if (length) yield take();
}
