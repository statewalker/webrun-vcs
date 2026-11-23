/**
 * One-shot SHA-256 of a buffer. Uses Web Crypto when the runtime has it (native
 * speed in browsers, Node and workerd), otherwise the portable incremental hasher.
 */
import { createSha256 } from "../hasher/index.js";

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === "function";
}

/**
 * Compute the SHA-256 of `data`.
 *
 * @example
 * ```typescript
 * const hash = await sha256(new TextEncoder().encode("hello"));
 * // Uint8Array(32) 2cf24dba…
 * ```
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (hasWebCrypto()) {
    return new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
    );
  }
  return createSha256().update(data).digest();
}
