/**
 * One-shot SHA-1 of a buffer. Uses Web Crypto when the runtime has it (native
 * speed in browsers, Node and workerd), otherwise the portable hasher.
 */
import { createSha1 } from "../hasher/index.js";

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === "function";
}

/**
 * Compute the SHA-1 of `data`.
 *
 * @example
 * ```typescript
 * const hash = await sha1(new TextEncoder().encode("hello"));
 * // Uint8Array(20) aaf4c61d…
 * ```
 */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  if (hasWebCrypto()) {
    return new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>),
    );
  }
  return createSha1().update(data).digest();
}
