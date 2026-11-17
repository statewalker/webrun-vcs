/**
 * Portable incremental SHA-1 (FIPS 180-4). Runs of whole blocks go to a WebAssembly block
 * function where the runtime can compile one (`sha1-wasm.ts`), else to a JavaScript one
 * written for the JIT: fully unrolled, the state and the 16 schedule words in locals, the
 * words read straight from the caller's bytes. Only a block split across `update` calls is
 * copied, and nothing is allocated per block or per call.
 *
 * On Node 24, about 2 times (JavaScript) to 3 times (WebAssembly) as fast as
 * `@noble/hashes`' SHA-1 on large inputs, and more on small ones (no per-hash setup). Node's
 * native hash is faster still, and Web Crypto's async one-shot digest pays off only for inputs
 * of tens of KiB.
 */
import { type Sha1Wasm, sha1Wasm } from "./sha1-wasm.js";

/** Runs shorter than this (in bytes) stay in JavaScript: the call costs more than it saves. */
const WASM_MIN = 128;

/** Hashes the blocks of `p` from `at` to `end` into `s`: in WebAssembly when it pays. */
function hashBlocks(s: Int32Array, p: Uint8Array, at: number, end: number): void {
  const wasm = end - at >= WASM_MIN ? sha1Wasm() : undefined;
  if (wasm) wasmBlocks(wasm, s, p, at, end);
  else blocks(s, p, at, end);
}

function wasmBlocks(wasm: Sha1Wasm, s: Int32Array, p: Uint8Array, at: number, end: number): void {
  wasm.state.set(s);
  while (at < end) {
    const length = Math.min(end - at, wasm.capacity);
    wasm.input.set(p.subarray(at, at + length));
    wasm.blocks(length >>> 6);
    at += length;
  }
  s.set(wasm.state);
}

/**
 * Hashes the 64-byte blocks of `p` from `at` to `end` into `s` (five 32-bit words); `end - at`
 * is a multiple of 64. Generated fully unrolled: the schedule's 16 words are locals and the
 * working variables change roles from round to round instead of being moved.
 */
function blocks(s: Int32Array, p: Uint8Array, at: number, end: number): void {
  let h0 = s[0] as number;
  let h1 = s[1] as number;
  let h2 = s[2] as number;
  let h3 = s[3] as number;
  let h4 = s[4] as number;
  for (; at < end; at += 64) {
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let w0 =
      ((p[at] as number) << 24) |
      ((p[at + 1] as number) << 16) |
      ((p[at + 2] as number) << 8) |
      (p[at + 3] as number);
    let w1 =
      ((p[at + 4] as number) << 24) |
      ((p[at + 4 + 1] as number) << 16) |
      ((p[at + 4 + 2] as number) << 8) |
      (p[at + 4 + 3] as number);
    let w2 =
      ((p[at + 8] as number) << 24) |
      ((p[at + 8 + 1] as number) << 16) |
      ((p[at + 8 + 2] as number) << 8) |
      (p[at + 8 + 3] as number);
    let w3 =
      ((p[at + 12] as number) << 24) |
      ((p[at + 12 + 1] as number) << 16) |
      ((p[at + 12 + 2] as number) << 8) |
      (p[at + 12 + 3] as number);
    let w4 =
      ((p[at + 16] as number) << 24) |
      ((p[at + 16 + 1] as number) << 16) |
      ((p[at + 16 + 2] as number) << 8) |
      (p[at + 16 + 3] as number);
    let w5 =
      ((p[at + 20] as number) << 24) |
      ((p[at + 20 + 1] as number) << 16) |
      ((p[at + 20 + 2] as number) << 8) |
      (p[at + 20 + 3] as number);
    let w6 =
      ((p[at + 24] as number) << 24) |
      ((p[at + 24 + 1] as number) << 16) |
      ((p[at + 24 + 2] as number) << 8) |
      (p[at + 24 + 3] as number);
    let w7 =
      ((p[at + 28] as number) << 24) |
      ((p[at + 28 + 1] as number) << 16) |
      ((p[at + 28 + 2] as number) << 8) |
      (p[at + 28 + 3] as number);
    let w8 =
      ((p[at + 32] as number) << 24) |
      ((p[at + 32 + 1] as number) << 16) |
      ((p[at + 32 + 2] as number) << 8) |
      (p[at + 32 + 3] as number);
    let w9 =
      ((p[at + 36] as number) << 24) |
      ((p[at + 36 + 1] as number) << 16) |
      ((p[at + 36 + 2] as number) << 8) |
      (p[at + 36 + 3] as number);
    let w10 =
      ((p[at + 40] as number) << 24) |
      ((p[at + 40 + 1] as number) << 16) |
      ((p[at + 40 + 2] as number) << 8) |
      (p[at + 40 + 3] as number);
    let w11 =
      ((p[at + 44] as number) << 24) |
      ((p[at + 44 + 1] as number) << 16) |
      ((p[at + 44 + 2] as number) << 8) |
      (p[at + 44 + 3] as number);
    let w12 =
      ((p[at + 48] as number) << 24) |
      ((p[at + 48 + 1] as number) << 16) |
      ((p[at + 48 + 2] as number) << 8) |
      (p[at + 48 + 3] as number);
    let w13 =
      ((p[at + 52] as number) << 24) |
      ((p[at + 52 + 1] as number) << 16) |
      ((p[at + 52 + 2] as number) << 8) |
      (p[at + 52 + 3] as number);
    let w14 =
      ((p[at + 56] as number) << 24) |
      ((p[at + 56 + 1] as number) << 16) |
      ((p[at + 56 + 2] as number) << 8) |
      (p[at + 56 + 3] as number);
    let w15 =
      ((p[at + 60] as number) << 24) |
      ((p[at + 60 + 1] as number) << 16) |
      ((p[at + 60 + 2] as number) << 8) |
      (p[at + 60 + 3] as number);
    e = (((a << 5) | (a >>> 27)) + (d ^ (b & (c ^ d))) + e + 0x5a827999 + w0) | 0;
    b = (b << 30) | (b >>> 2);
    d = (((e << 5) | (e >>> 27)) + (c ^ (a & (b ^ c))) + d + 0x5a827999 + w1) | 0;
    a = (a << 30) | (a >>> 2);
    c = (((d << 5) | (d >>> 27)) + (b ^ (e & (a ^ b))) + c + 0x5a827999 + w2) | 0;
    e = (e << 30) | (e >>> 2);
    b = (((c << 5) | (c >>> 27)) + (a ^ (d & (e ^ a))) + b + 0x5a827999 + w3) | 0;
    d = (d << 30) | (d >>> 2);
    a = (((b << 5) | (b >>> 27)) + (e ^ (c & (d ^ e))) + a + 0x5a827999 + w4) | 0;
    c = (c << 30) | (c >>> 2);
    e = (((a << 5) | (a >>> 27)) + (d ^ (b & (c ^ d))) + e + 0x5a827999 + w5) | 0;
    b = (b << 30) | (b >>> 2);
    d = (((e << 5) | (e >>> 27)) + (c ^ (a & (b ^ c))) + d + 0x5a827999 + w6) | 0;
    a = (a << 30) | (a >>> 2);
    c = (((d << 5) | (d >>> 27)) + (b ^ (e & (a ^ b))) + c + 0x5a827999 + w7) | 0;
    e = (e << 30) | (e >>> 2);
    b = (((c << 5) | (c >>> 27)) + (a ^ (d & (e ^ a))) + b + 0x5a827999 + w8) | 0;
    d = (d << 30) | (d >>> 2);
    a = (((b << 5) | (b >>> 27)) + (e ^ (c & (d ^ e))) + a + 0x5a827999 + w9) | 0;
    c = (c << 30) | (c >>> 2);
    e = (((a << 5) | (a >>> 27)) + (d ^ (b & (c ^ d))) + e + 0x5a827999 + w10) | 0;
    b = (b << 30) | (b >>> 2);
    d = (((e << 5) | (e >>> 27)) + (c ^ (a & (b ^ c))) + d + 0x5a827999 + w11) | 0;
    a = (a << 30) | (a >>> 2);
    c = (((d << 5) | (d >>> 27)) + (b ^ (e & (a ^ b))) + c + 0x5a827999 + w12) | 0;
    e = (e << 30) | (e >>> 2);
    b = (((c << 5) | (c >>> 27)) + (a ^ (d & (e ^ a))) + b + 0x5a827999 + w13) | 0;
    d = (d << 30) | (d >>> 2);
    a = (((b << 5) | (b >>> 27)) + (e ^ (c & (d ^ e))) + a + 0x5a827999 + w14) | 0;
    c = (c << 30) | (c >>> 2);
    e = (((a << 5) | (a >>> 27)) + (d ^ (b & (c ^ d))) + e + 0x5a827999 + w15) | 0;
    b = (b << 30) | (b >>> 2);
    w0 = w13 ^ w8 ^ w2 ^ w0;
    w0 = (w0 << 1) | (w0 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (c ^ (a & (b ^ c))) + d + 0x5a827999 + w0) | 0;
    a = (a << 30) | (a >>> 2);
    w1 = w14 ^ w9 ^ w3 ^ w1;
    w1 = (w1 << 1) | (w1 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (b ^ (e & (a ^ b))) + c + 0x5a827999 + w1) | 0;
    e = (e << 30) | (e >>> 2);
    w2 = w15 ^ w10 ^ w4 ^ w2;
    w2 = (w2 << 1) | (w2 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (a ^ (d & (e ^ a))) + b + 0x5a827999 + w2) | 0;
    d = (d << 30) | (d >>> 2);
    w3 = w0 ^ w11 ^ w5 ^ w3;
    w3 = (w3 << 1) | (w3 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (e ^ (c & (d ^ e))) + a + 0x5a827999 + w3) | 0;
    c = (c << 30) | (c >>> 2);
    w4 = w1 ^ w12 ^ w6 ^ w4;
    w4 = (w4 << 1) | (w4 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w4) | 0;
    b = (b << 30) | (b >>> 2);
    w5 = w2 ^ w13 ^ w7 ^ w5;
    w5 = (w5 << 1) | (w5 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0x6ed9eba1 + w5) | 0;
    a = (a << 30) | (a >>> 2);
    w6 = w3 ^ w14 ^ w8 ^ w6;
    w6 = (w6 << 1) | (w6 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0x6ed9eba1 + w6) | 0;
    e = (e << 30) | (e >>> 2);
    w7 = w4 ^ w15 ^ w9 ^ w7;
    w7 = (w7 << 1) | (w7 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0x6ed9eba1 + w7) | 0;
    d = (d << 30) | (d >>> 2);
    w8 = w5 ^ w0 ^ w10 ^ w8;
    w8 = (w8 << 1) | (w8 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0x6ed9eba1 + w8) | 0;
    c = (c << 30) | (c >>> 2);
    w9 = w6 ^ w1 ^ w11 ^ w9;
    w9 = (w9 << 1) | (w9 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w9) | 0;
    b = (b << 30) | (b >>> 2);
    w10 = w7 ^ w2 ^ w12 ^ w10;
    w10 = (w10 << 1) | (w10 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0x6ed9eba1 + w10) | 0;
    a = (a << 30) | (a >>> 2);
    w11 = w8 ^ w3 ^ w13 ^ w11;
    w11 = (w11 << 1) | (w11 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0x6ed9eba1 + w11) | 0;
    e = (e << 30) | (e >>> 2);
    w12 = w9 ^ w4 ^ w14 ^ w12;
    w12 = (w12 << 1) | (w12 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0x6ed9eba1 + w12) | 0;
    d = (d << 30) | (d >>> 2);
    w13 = w10 ^ w5 ^ w15 ^ w13;
    w13 = (w13 << 1) | (w13 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0x6ed9eba1 + w13) | 0;
    c = (c << 30) | (c >>> 2);
    w14 = w11 ^ w6 ^ w0 ^ w14;
    w14 = (w14 << 1) | (w14 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w14) | 0;
    b = (b << 30) | (b >>> 2);
    w15 = w12 ^ w7 ^ w1 ^ w15;
    w15 = (w15 << 1) | (w15 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0x6ed9eba1 + w15) | 0;
    a = (a << 30) | (a >>> 2);
    w0 = w13 ^ w8 ^ w2 ^ w0;
    w0 = (w0 << 1) | (w0 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0x6ed9eba1 + w0) | 0;
    e = (e << 30) | (e >>> 2);
    w1 = w14 ^ w9 ^ w3 ^ w1;
    w1 = (w1 << 1) | (w1 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0x6ed9eba1 + w1) | 0;
    d = (d << 30) | (d >>> 2);
    w2 = w15 ^ w10 ^ w4 ^ w2;
    w2 = (w2 << 1) | (w2 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0x6ed9eba1 + w2) | 0;
    c = (c << 30) | (c >>> 2);
    w3 = w0 ^ w11 ^ w5 ^ w3;
    w3 = (w3 << 1) | (w3 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w3) | 0;
    b = (b << 30) | (b >>> 2);
    w4 = w1 ^ w12 ^ w6 ^ w4;
    w4 = (w4 << 1) | (w4 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0x6ed9eba1 + w4) | 0;
    a = (a << 30) | (a >>> 2);
    w5 = w2 ^ w13 ^ w7 ^ w5;
    w5 = (w5 << 1) | (w5 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0x6ed9eba1 + w5) | 0;
    e = (e << 30) | (e >>> 2);
    w6 = w3 ^ w14 ^ w8 ^ w6;
    w6 = (w6 << 1) | (w6 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0x6ed9eba1 + w6) | 0;
    d = (d << 30) | (d >>> 2);
    w7 = w4 ^ w15 ^ w9 ^ w7;
    w7 = (w7 << 1) | (w7 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0x6ed9eba1 + w7) | 0;
    c = (c << 30) | (c >>> 2);
    w8 = w5 ^ w0 ^ w10 ^ w8;
    w8 = (w8 << 1) | (w8 >>> 31);
    e = (((a << 5) | (a >>> 27)) + ((b & c) | (d & (b | c))) + e + 0x8f1bbcdc + w8) | 0;
    b = (b << 30) | (b >>> 2);
    w9 = w6 ^ w1 ^ w11 ^ w9;
    w9 = (w9 << 1) | (w9 >>> 31);
    d = (((e << 5) | (e >>> 27)) + ((a & b) | (c & (a | b))) + d + 0x8f1bbcdc + w9) | 0;
    a = (a << 30) | (a >>> 2);
    w10 = w7 ^ w2 ^ w12 ^ w10;
    w10 = (w10 << 1) | (w10 >>> 31);
    c = (((d << 5) | (d >>> 27)) + ((e & a) | (b & (e | a))) + c + 0x8f1bbcdc + w10) | 0;
    e = (e << 30) | (e >>> 2);
    w11 = w8 ^ w3 ^ w13 ^ w11;
    w11 = (w11 << 1) | (w11 >>> 31);
    b = (((c << 5) | (c >>> 27)) + ((d & e) | (a & (d | e))) + b + 0x8f1bbcdc + w11) | 0;
    d = (d << 30) | (d >>> 2);
    w12 = w9 ^ w4 ^ w14 ^ w12;
    w12 = (w12 << 1) | (w12 >>> 31);
    a = (((b << 5) | (b >>> 27)) + ((c & d) | (e & (c | d))) + a + 0x8f1bbcdc + w12) | 0;
    c = (c << 30) | (c >>> 2);
    w13 = w10 ^ w5 ^ w15 ^ w13;
    w13 = (w13 << 1) | (w13 >>> 31);
    e = (((a << 5) | (a >>> 27)) + ((b & c) | (d & (b | c))) + e + 0x8f1bbcdc + w13) | 0;
    b = (b << 30) | (b >>> 2);
    w14 = w11 ^ w6 ^ w0 ^ w14;
    w14 = (w14 << 1) | (w14 >>> 31);
    d = (((e << 5) | (e >>> 27)) + ((a & b) | (c & (a | b))) + d + 0x8f1bbcdc + w14) | 0;
    a = (a << 30) | (a >>> 2);
    w15 = w12 ^ w7 ^ w1 ^ w15;
    w15 = (w15 << 1) | (w15 >>> 31);
    c = (((d << 5) | (d >>> 27)) + ((e & a) | (b & (e | a))) + c + 0x8f1bbcdc + w15) | 0;
    e = (e << 30) | (e >>> 2);
    w0 = w13 ^ w8 ^ w2 ^ w0;
    w0 = (w0 << 1) | (w0 >>> 31);
    b = (((c << 5) | (c >>> 27)) + ((d & e) | (a & (d | e))) + b + 0x8f1bbcdc + w0) | 0;
    d = (d << 30) | (d >>> 2);
    w1 = w14 ^ w9 ^ w3 ^ w1;
    w1 = (w1 << 1) | (w1 >>> 31);
    a = (((b << 5) | (b >>> 27)) + ((c & d) | (e & (c | d))) + a + 0x8f1bbcdc + w1) | 0;
    c = (c << 30) | (c >>> 2);
    w2 = w15 ^ w10 ^ w4 ^ w2;
    w2 = (w2 << 1) | (w2 >>> 31);
    e = (((a << 5) | (a >>> 27)) + ((b & c) | (d & (b | c))) + e + 0x8f1bbcdc + w2) | 0;
    b = (b << 30) | (b >>> 2);
    w3 = w0 ^ w11 ^ w5 ^ w3;
    w3 = (w3 << 1) | (w3 >>> 31);
    d = (((e << 5) | (e >>> 27)) + ((a & b) | (c & (a | b))) + d + 0x8f1bbcdc + w3) | 0;
    a = (a << 30) | (a >>> 2);
    w4 = w1 ^ w12 ^ w6 ^ w4;
    w4 = (w4 << 1) | (w4 >>> 31);
    c = (((d << 5) | (d >>> 27)) + ((e & a) | (b & (e | a))) + c + 0x8f1bbcdc + w4) | 0;
    e = (e << 30) | (e >>> 2);
    w5 = w2 ^ w13 ^ w7 ^ w5;
    w5 = (w5 << 1) | (w5 >>> 31);
    b = (((c << 5) | (c >>> 27)) + ((d & e) | (a & (d | e))) + b + 0x8f1bbcdc + w5) | 0;
    d = (d << 30) | (d >>> 2);
    w6 = w3 ^ w14 ^ w8 ^ w6;
    w6 = (w6 << 1) | (w6 >>> 31);
    a = (((b << 5) | (b >>> 27)) + ((c & d) | (e & (c | d))) + a + 0x8f1bbcdc + w6) | 0;
    c = (c << 30) | (c >>> 2);
    w7 = w4 ^ w15 ^ w9 ^ w7;
    w7 = (w7 << 1) | (w7 >>> 31);
    e = (((a << 5) | (a >>> 27)) + ((b & c) | (d & (b | c))) + e + 0x8f1bbcdc + w7) | 0;
    b = (b << 30) | (b >>> 2);
    w8 = w5 ^ w0 ^ w10 ^ w8;
    w8 = (w8 << 1) | (w8 >>> 31);
    d = (((e << 5) | (e >>> 27)) + ((a & b) | (c & (a | b))) + d + 0x8f1bbcdc + w8) | 0;
    a = (a << 30) | (a >>> 2);
    w9 = w6 ^ w1 ^ w11 ^ w9;
    w9 = (w9 << 1) | (w9 >>> 31);
    c = (((d << 5) | (d >>> 27)) + ((e & a) | (b & (e | a))) + c + 0x8f1bbcdc + w9) | 0;
    e = (e << 30) | (e >>> 2);
    w10 = w7 ^ w2 ^ w12 ^ w10;
    w10 = (w10 << 1) | (w10 >>> 31);
    b = (((c << 5) | (c >>> 27)) + ((d & e) | (a & (d | e))) + b + 0x8f1bbcdc + w10) | 0;
    d = (d << 30) | (d >>> 2);
    w11 = w8 ^ w3 ^ w13 ^ w11;
    w11 = (w11 << 1) | (w11 >>> 31);
    a = (((b << 5) | (b >>> 27)) + ((c & d) | (e & (c | d))) + a + 0x8f1bbcdc + w11) | 0;
    c = (c << 30) | (c >>> 2);
    w12 = w9 ^ w4 ^ w14 ^ w12;
    w12 = (w12 << 1) | (w12 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w12) | 0;
    b = (b << 30) | (b >>> 2);
    w13 = w10 ^ w5 ^ w15 ^ w13;
    w13 = (w13 << 1) | (w13 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0xca62c1d6 + w13) | 0;
    a = (a << 30) | (a >>> 2);
    w14 = w11 ^ w6 ^ w0 ^ w14;
    w14 = (w14 << 1) | (w14 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0xca62c1d6 + w14) | 0;
    e = (e << 30) | (e >>> 2);
    w15 = w12 ^ w7 ^ w1 ^ w15;
    w15 = (w15 << 1) | (w15 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0xca62c1d6 + w15) | 0;
    d = (d << 30) | (d >>> 2);
    w0 = w13 ^ w8 ^ w2 ^ w0;
    w0 = (w0 << 1) | (w0 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0xca62c1d6 + w0) | 0;
    c = (c << 30) | (c >>> 2);
    w1 = w14 ^ w9 ^ w3 ^ w1;
    w1 = (w1 << 1) | (w1 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w1) | 0;
    b = (b << 30) | (b >>> 2);
    w2 = w15 ^ w10 ^ w4 ^ w2;
    w2 = (w2 << 1) | (w2 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0xca62c1d6 + w2) | 0;
    a = (a << 30) | (a >>> 2);
    w3 = w0 ^ w11 ^ w5 ^ w3;
    w3 = (w3 << 1) | (w3 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0xca62c1d6 + w3) | 0;
    e = (e << 30) | (e >>> 2);
    w4 = w1 ^ w12 ^ w6 ^ w4;
    w4 = (w4 << 1) | (w4 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0xca62c1d6 + w4) | 0;
    d = (d << 30) | (d >>> 2);
    w5 = w2 ^ w13 ^ w7 ^ w5;
    w5 = (w5 << 1) | (w5 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0xca62c1d6 + w5) | 0;
    c = (c << 30) | (c >>> 2);
    w6 = w3 ^ w14 ^ w8 ^ w6;
    w6 = (w6 << 1) | (w6 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w6) | 0;
    b = (b << 30) | (b >>> 2);
    w7 = w4 ^ w15 ^ w9 ^ w7;
    w7 = (w7 << 1) | (w7 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0xca62c1d6 + w7) | 0;
    a = (a << 30) | (a >>> 2);
    w8 = w5 ^ w0 ^ w10 ^ w8;
    w8 = (w8 << 1) | (w8 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0xca62c1d6 + w8) | 0;
    e = (e << 30) | (e >>> 2);
    w9 = w6 ^ w1 ^ w11 ^ w9;
    w9 = (w9 << 1) | (w9 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0xca62c1d6 + w9) | 0;
    d = (d << 30) | (d >>> 2);
    w10 = w7 ^ w2 ^ w12 ^ w10;
    w10 = (w10 << 1) | (w10 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0xca62c1d6 + w10) | 0;
    c = (c << 30) | (c >>> 2);
    w11 = w8 ^ w3 ^ w13 ^ w11;
    w11 = (w11 << 1) | (w11 >>> 31);
    e = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w11) | 0;
    b = (b << 30) | (b >>> 2);
    w12 = w9 ^ w4 ^ w14 ^ w12;
    w12 = (w12 << 1) | (w12 >>> 31);
    d = (((e << 5) | (e >>> 27)) + (a ^ b ^ c) + d + 0xca62c1d6 + w12) | 0;
    a = (a << 30) | (a >>> 2);
    w13 = w10 ^ w5 ^ w15 ^ w13;
    w13 = (w13 << 1) | (w13 >>> 31);
    c = (((d << 5) | (d >>> 27)) + (e ^ a ^ b) + c + 0xca62c1d6 + w13) | 0;
    e = (e << 30) | (e >>> 2);
    w14 = w11 ^ w6 ^ w0 ^ w14;
    w14 = (w14 << 1) | (w14 >>> 31);
    b = (((c << 5) | (c >>> 27)) + (d ^ e ^ a) + b + 0xca62c1d6 + w14) | 0;
    d = (d << 30) | (d >>> 2);
    w15 = w12 ^ w7 ^ w1 ^ w15;
    w15 = (w15 << 1) | (w15 >>> 31);
    a = (((b << 5) | (b >>> 27)) + (c ^ d ^ e) + a + 0xca62c1d6 + w15) | 0;
    c = (c << 30) | (c >>> 2);
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  s[0] = h0;
  s[1] = h1;
  s[2] = h2;
  s[3] = h3;
  s[4] = h4;
}

/** An incremental SHA-1: `update` any number of times, then `digest` once. */
/** The largest piece `update` hashes in one go (larger inputs are fed in pieces). */
const UPDATE_PIECE = 2 ** 30;

export class Sha1 {
  private readonly s = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  /** a partial block carried between `update` calls */
  private readonly buf = new Uint8Array(64);
  private used = 0;
  /** bytes hashed so far */
  private length = 0;
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error("Sha1: update after digest");
    // offsets below stay under 2^31, where the bitwise arithmetic is exact
    if (data.length > UPDATE_PIECE) {
      for (let at = 0; at < data.length; at += UPDATE_PIECE) {
        this.update(data.subarray(at, Math.min(at + UPDATE_PIECE, data.length)));
      }
      return this;
    }
    const n = data.length;
    this.length += n;
    let at = 0;
    if (this.used > 0) {
      const take = Math.min(64 - this.used, n);
      this.buf.set(take === n ? data : data.subarray(0, take), this.used);
      this.used += take;
      at = take;
      if (this.used < 64) return this;
      blocks(this.s, this.buf, 0, 64);
      this.used = 0;
    }
    const end = at + ((n - at) & ~63);
    if (end > at) hashBlocks(this.s, data, at, end);
    if (end < n) {
      this.buf.set(data.subarray(end), 0);
      this.used = n - end;
    }
    return this;
  }

  /** The 20-byte digest. The hasher is spent afterwards. */
  digest(): Uint8Array {
    if (this.done) throw new Error("Sha1: digest called twice");
    this.done = true;
    const buf = this.buf;
    let used = this.used;
    buf[used++] = 0x80;
    if (used > 56) {
      buf.fill(0, used);
      blocks(this.s, buf, 0, 64);
      used = 0;
    }
    buf.fill(0, used, 56);
    const bits = this.length * 8;
    const hi = Math.floor(bits / 2 ** 32);
    const lo = bits >>> 0;
    buf[56] = hi >>> 24;
    buf[57] = hi >>> 16;
    buf[58] = hi >>> 8;
    buf[59] = hi;
    buf[60] = lo >>> 24;
    buf[61] = lo >>> 16;
    buf[62] = lo >>> 8;
    buf[63] = lo;
    blocks(this.s, buf, 0, 64);
    const out = new Uint8Array(20);
    for (let i = 0; i < 5; i++) {
      const v = this.s[i] as number;
      out[i * 4] = v >>> 24;
      out[i * 4 + 1] = v >>> 16;
      out[i * 4 + 2] = v >>> 8;
      out[i * 4 + 3] = v;
    }
    return out;
  }

  /** A copy of the current state. */
  clone(): Sha1 {
    const c = new Sha1();
    c.s.set(this.s);
    c.buf.set(this.buf);
    c.used = this.used;
    c.length = this.length;
    return c;
  }
}

const INITIAL = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
const NOTHING = new Uint8Array(0);

/**
 * The SHA-1 of `head` followed by `body` (a git object's header and content), in one call:
 * where the WebAssembly block function is available and the padded message fits its memory,
 * the message is copied there whole, padding included, and hashed in a single run, which
 * saves the per-call costs that dominate for small objects.
 *
 * @example
 * ```typescript
 * const id = sha1Of(new TextEncoder().encode(`blob ${content.length}\0`), content);
 * ```
 */
export function sha1Of(head: Uint8Array, body: Uint8Array = NOTHING): Uint8Array {
  const n = head.length + body.length;
  // the message, the 0x80 byte and the 64-bit length, in whole blocks
  // plain arithmetic: a body of 2 GiB or more must not wrap past the capacity check
  const padded = Math.ceil((n + 9) / 64) * 64;
  const wasm = sha1Wasm();
  if (!wasm || padded > wasm.capacity) return new Sha1().update(head).update(body).digest();
  const input = wasm.input;
  input.set(head, 0);
  input.set(body, head.length);
  input[n] = 0x80;
  input.fill(0, n + 1, padded - 8);
  const bits = n * 8;
  const hi = Math.floor(bits / 2 ** 32);
  const lo = bits >>> 0;
  input[padded - 8] = hi >>> 24;
  input[padded - 7] = hi >>> 16;
  input[padded - 6] = hi >>> 8;
  input[padded - 5] = hi;
  input[padded - 4] = lo >>> 24;
  input[padded - 3] = lo >>> 16;
  input[padded - 2] = lo >>> 8;
  input[padded - 1] = lo;
  const state = wasm.state;
  state.set(INITIAL);
  wasm.blocks(padded >>> 6);
  const out = new Uint8Array(20);
  for (let i = 0; i < 5; i++) {
    const v = state[i] as number;
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = v >>> 16;
    out[i * 4 + 2] = v >>> 8;
    out[i * 4 + 3] = v;
  }
  return out;
}
