/**
 * The authoritative LFS object id: whole-object SHA-256 as bare lowercase hex.
 * SHA-256 is mandated by the LFS spec, so it is fixed here (not injected).
 *
 * Uses the Web Crypto API (`crypto.subtle`) so it runs unchanged on browsers,
 * Node, Deno, and workers. That API is async, so this returns a Promise.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass the exact byte range (a subarray view may cover only part of its buffer).
  let buffer = bytes.buffer;
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
