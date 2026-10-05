/**
 * Async SHA-1 hash function
 *
 * Uses Web Crypto API when available, falls back to pure TypeScript implementation.
 */

import { Sha1 } from "./sha-1.js";

/**
 * Check if Web Crypto API is available
 */
function hasWebCrypto(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined" &&
    typeof globalThis.crypto.subtle.digest === "function"
  );
}

/**
 * Compute SHA-1 hash using Web Crypto API
 */
async function sha1WebCrypto(data: Uint8Array): Promise<Uint8Array> {
  let buffer = data.buffer;
  if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
    // Create a view of the relevant slice of the buffer
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-1", buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute SHA-1 hash synchronously (pure TypeScript, no Web Crypto)
 *
 * Use this when you need synchronous hashing or when Web Crypto is not available.
 *
 * @param data Data to hash
 * @returns 20-byte SHA-1 hash as Uint8Array
 */
export function sha1Sync(data: Uint8Array): Uint8Array {
  return new Sha1(data).finalize();
}

/**
 * Compute SHA-1 hash of data
 *
 * Uses Web Crypto API when available for better performance,
 * falls back to pure TypeScript implementation otherwise.
 *
 * @param data Data to hash
 * @returns Promise resolving to 20-byte SHA-1 hash as Uint8Array
 *
 * @example
 * ```typescript
 * const data = new TextEncoder().encode("hello");
 * const hash = await sha1(data);
 * // hash is Uint8Array(20)
 * ```
 */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  if (hasWebCrypto()) {
    return sha1WebCrypto(data);
  }
  return sha1Sync(data);
}
