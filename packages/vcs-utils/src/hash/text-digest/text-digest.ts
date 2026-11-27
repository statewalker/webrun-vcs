/**
 * Synchronous SHA-256 and SHA-512/256 digests in hex, for protocols that hash short texts
 * one step at a time (HTTP Digest authentication's `algorithm=SHA-256` and `SHA-512-256`).
 * Web Crypto's `digest` is asynchronous and has no SHA-512/256, so these use @noble/hashes.
 *
 * @example
 * ```ts
 * sha256Hex("abc"); // "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
 * ```
 */

import { sha256, sha512_256 } from "@noble/hashes/sha2.js";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const bytesOf = (data: Uint8Array | string) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

/** SHA-256 of `data` (a string as its UTF-8 bytes) as 64 lowercase hex digits. */
export function sha256Hex(data: Uint8Array | string): string {
  return hex(sha256(bytesOf(data)));
}

/** SHA-512/256 (FIPS 180-4) of `data` as 64 lowercase hex digits. */
export function sha512_256Hex(data: Uint8Array | string): string {
  return hex(sha512_256(bytesOf(data)));
}
