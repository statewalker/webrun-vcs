/**
 * An LZ4 frame decoder (the LZ4 Frame Format 1.6.x), enough for Xet chunks: one frame, linked
 * or independent blocks, optional content size, block and content checksums skipped (each Xet
 * chunk is verified by its BLAKE3 hash instead). No dictionary support.
 */

import { LZ4_FRAME_MAGIC as MAGIC, readU32 } from "./lz4-format.js";

/** decodes one LZ4 frame whose content is `size` bytes */
export function lz4FrameDecode(src: Uint8Array, size: number): Uint8Array {
  if (readU32(src, 0) !== MAGIC) throw new Error("lz4: not a frame");
  const flg = src[4] as number;
  if (flg >> 6 !== 1) throw new Error("lz4: unsupported frame version");
  const independent = (flg & 0x20) !== 0;
  // BD: the largest block the frame may hold (64 KiB, 256 KiB, 1 MiB or 4 MiB)
  const bdCode = ((src[5] as number) >> 4) & 7;
  if (bdCode < 4) throw new Error("lz4: invalid block maximum");
  const maxBlock = 1 << (8 + 2 * bdCode);
  const blockChecksum = (flg & 0x10) !== 0;
  const contentSize = (flg & 0x08) !== 0;
  if (flg & 0x01) throw new Error("lz4: dictionaries are not supported");
  let at = 6 + (contentSize ? 8 : 0) + 1; // FLG BD [content size] HC
  const out = new Uint8Array(size);
  let o = 0;
  for (;;) {
    if (at + 4 > src.length) throw new Error("lz4: frame without an end mark");
    const word = readU32(src, at);
    at += 4;
    if (word === 0) break; // end mark (a content checksum may follow)
    const n = word & 0x7fffffff;
    if (n > maxBlock) throw new Error("lz4: block larger than the frame's maximum");
    if (at + n > src.length) throw new Error("lz4: block past the end of the frame");
    if (word & 0x80000000) {
      if (o + n > size) throw new Error("lz4: output overflow");
      out.set(src.subarray(at, at + n), o);
      o += n;
    } else o = decodeBlock(src, at, at + n, out, o, independent ? o : 0);
    at += n + (blockChecksum ? 4 : 0);
  }
  if (o !== size) throw new Error(`lz4: frame has ${o} bytes, expected ${size}`);
  return out;
}

/**
 * One LZ4 block (`src[at..end)`) into `out` from `o`; matches may reach back to `windowStart` (the
 * block's own start for independent blocks, the frame's start for linked ones). Every length and
 * offset is checked against the block, the window and the output.
 */
function decodeBlock(
  src: Uint8Array,
  at: number,
  end: number,
  out: Uint8Array,
  o: number,
  windowStart: number,
): number {
  const fail = (what: string): never => {
    throw new Error(`lz4: ${what}`);
  };
  const byte = () => (at < end ? (src[at++] as number) : fail("block ends inside a sequence"));
  while (at < end) {
    const token = byte();
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = byte();
        lit += b;
      } while (b === 255);
    }
    if (at + lit > end) fail("literals run past their block");
    if (o + lit > out.length) fail("output overflow");
    out.set(src.subarray(at, at + lit), o);
    at += lit;
    o += lit;
    if (at >= end) break; // the last sequence has literals only
    const offset = byte() | (byte() << 8);
    if (offset === 0 || o - offset < windowStart) fail("match offset outside its window");
    let len = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = byte();
        len += b;
      } while (b === 255);
    }
    if (o + len > out.length) throw new Error("lz4: output overflow");
    // overlapping copies repeat the last `offset` bytes: copy byte by byte when they overlap
    if (offset >= len) out.copyWithin(o, o - offset, o - offset + len);
    else for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i] as number;
    o += len;
  }
  return o;
}
