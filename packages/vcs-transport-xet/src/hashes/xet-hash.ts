/**
 * Xet's hashes: keyed BLAKE3 (xet-core's `merklehash`) and the way Xet prints a hash, as four
 * 64-bit little-endian words in hex.
 */

import { blake3 } from "@noble/hashes/blake3.js";

/** a chunk hash's key (xet-core `DATA_KEY`) */
export const DATA_KEY: Uint8Array = Uint8Array.from([
  102, 151, 245, 119, 91, 149, 80, 222, 49, 53, 203, 172, 165, 151, 24, 28, 157, 228, 33, 16, 155,
  235, 43, 88, 180, 208, 176, 75, 147, 173, 242, 41,
]);
/** an internal Merkle node's key (xet-core `INTERNAL_NODE_HASH`) */
export const INTERNAL_NODE_KEY: Uint8Array = Uint8Array.from([
  1, 126, 197, 199, 165, 71, 41, 150, 253, 148, 102, 102, 180, 138, 2, 230, 93, 221, 83, 111, 55,
  199, 109, 210, 248, 99, 82, 230, 74, 83, 113, 63,
]);
/** a verification range hash's key (xet-core `VERIFICATION_KEY`) */
export const VERIFICATION_KEY: Uint8Array = Uint8Array.from([
  127, 24, 87, 214, 206, 86, 237, 102, 18, 127, 249, 19, 231, 165, 195, 243, 164, 205, 38, 213, 181,
  219, 73, 230, 65, 36, 152, 127, 40, 251, 148, 195,
]);

/** BLAKE3 in keyed mode (32-byte key, 32-byte output) */
export const keyedBlake3 = (key: Uint8Array, data: Uint8Array): Uint8Array => blake3(data, { key });

/** a chunk's hash: BLAKE3 keyed with DATA_KEY */
export const chunkHash = (data: Uint8Array): Uint8Array => keyedBlake3(DATA_KEY, data);

/**
 * A hash as Xet prints it: four 64-bit little-endian words, each in hex (so each group of eight
 * bytes reads backwards).
 */
export function hashToString(h: Uint8Array): string {
  if (h.length !== 32) throw new Error(`a Xet hash is 32 bytes, not ${h.length}`);
  let s = "";
  for (let w = 0; w < 4; w++)
    for (let i = 7; i >= 0; i--) s += (h[w * 8 + i] as number).toString(16).padStart(2, "0");
  return s;
}

/** the inverse of `hashToString` (lower-case hex only) */
export function hashFromString(s: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`not a Xet hash: ${s}`);
  const h = new Uint8Array(32);
  for (let w = 0; w < 4; w++)
    for (let i = 0; i < 8; i++)
      h[w * 8 + 7 - i] = Number.parseInt(s.slice(w * 16 + i * 2, w * 16 + i * 2 + 2), 16);
  return h;
}

/** byte equality of two hashes */
export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
