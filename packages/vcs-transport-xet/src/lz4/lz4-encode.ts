/**
 * An LZ4 frame encoder for Xet chunks (greedy, one 64 KiB window, LZ4's end-of-block rules kept)
 * and xxHash32, the frame descriptor's header checksum.
 */

import { LZ4_FRAME_MAGIC as MAGIC, readU32 } from "./lz4-format.js";

const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;
const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;

/** xxHash32 (seed 0): the frame descriptor's header checksum */
export function xxh32(b: Uint8Array, seed = 0): number {
  let at = 0;
  let h: number;
  if (b.length >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    const round = (v: number, x: number) => mul(rotl((v + mul(x, P2)) >>> 0, 13), P1);
    for (; at + 16 <= b.length; at += 16) {
      v1 = round(v1, readU32(b, at));
      v2 = round(v2, readU32(b, at + 4));
      v3 = round(v3, readU32(b, at + 8));
      v4 = round(v4, readU32(b, at + 12));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else h = (seed + P5) >>> 0;
  h = (h + b.length) >>> 0;
  for (; at + 4 <= b.length; at += 4) h = mul(rotl((h + mul(readU32(b, at), P3)) >>> 0, 17), P4);
  for (; at < b.length; at++) h = mul(rotl((h + mul(b[at] as number, P5)) >>> 0, 11), P1);
  h = mul(h ^ (h >>> 15), P2);
  h = mul(h ^ (h >>> 13), P3);
  return (h ^ (h >>> 16)) >>> 0;
}

const MIN_MATCH = 4;
const LAST_LITERALS = 5; // the block's last 5 bytes are literals
const MF_LIMIT = 12; // and no match starts in its last 12
const HASH_BITS = 14;

/** one LZ4 block of `src` (greedy, a 16 Ki-entry table of 4-byte sequences) */
export function lz4BlockEncode(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  let o = 0;
  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  const hash4 = (i: number) => Math.imul(readU32(src, i), 2654435761) >>> (32 - HASH_BITS);
  const length = (v: number) => {
    for (v -= 15; v >= 255; v -= 255) out[o++] = 255;
    out[o++] = v;
  };
  let anchor = 0;
  let i = 0;
  const matchLimit = n - LAST_LITERALS;
  while (n >= MF_LIMIT + 1 && i <= n - MF_LIMIT) {
    const h = hash4(i);
    const ref = table[h] as number;
    table[h] = i;
    if (ref < 0 || i - ref > 65535 || readU32(src, ref) !== readU32(src, i)) {
      i++;
      continue;
    }
    let len = MIN_MATCH;
    while (i + len < matchLimit && src[ref + len] === src[i + len]) len++;
    const lit = i - anchor;
    const token = o++;
    out[token] = (Math.min(lit, 15) << 4) | Math.min(len - MIN_MATCH, 15);
    if (lit >= 15) length(lit);
    out.set(src.subarray(anchor, i), o);
    o += lit;
    out[o++] = (i - ref) & 0xff;
    out[o++] = (i - ref) >> 8;
    if (len - MIN_MATCH >= 15) length(len - MIN_MATCH);
    i += len;
    anchor = i;
  }
  const lit = n - anchor;
  out[o++] = Math.min(lit, 15) << 4;
  if (lit >= 15) length(lit);
  out.set(src.subarray(anchor), o);
  o += lit;
  return out.subarray(0, o);
}

/** the frame's block maximum: 4 MiB (BD 0x70); a Xet chunk (at most 128 KiB) is one block */
export const LZ4_MAX_BLOCK = 4 * 1024 * 1024;

/**
 * One LZ4 frame of `src`: version 01, independent blocks of at most 4 MiB (decoders refuse a block
 * past the frame's declared maximum), no checksums but the header's; a block that would not shrink
 * is stored uncompressed.
 */
export function lz4FrameEncode(src: Uint8Array): Uint8Array {
  const blocks: { body: Uint8Array; stored: boolean }[] = [];
  for (let at = 0; at < src.length; at += LZ4_MAX_BLOCK) {
    const part = src.subarray(at, Math.min(at + LZ4_MAX_BLOCK, src.length));
    const block = lz4BlockEncode(part);
    const stored = block.length >= part.length;
    blocks.push({ body: stored ? part : block, stored });
  }
  const out = new Uint8Array(7 + blocks.reduce((n, b) => n + 4 + b.body.length, 0) + 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  out[4] = 0x60; // version 01, independent blocks
  out[5] = 0x70; // block maximum 4 MiB
  out[6] = (xxh32(out.subarray(4, 6)) >>> 8) & 0xff;
  let at = 7;
  for (const b of blocks) {
    v.setUint32(at, (b.body.length | (b.stored ? 0x80000000 : 0)) >>> 0, true);
    out.set(b.body, at + 4);
    at += 4 + b.body.length;
  }
  v.setUint32(at, 0, true); // end mark
  return out;
}
