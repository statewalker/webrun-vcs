import { bytesToHex, createSha256 } from "@statewalker/vcs-utils/hash";

/**
 * Bytes to hash or store: one buffer, a stream of chunks (sync or async), or a
 * `ReadableStream` such as a `Response` body.
 */
export type ByteSource =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

/**
 * Yields the chunks of `content`. A `ReadableStream` is read through its reader,
 * since not every browser makes it async-iterable.
 */
export async function* chunksOf(content: ByteSource): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content;
  } else if (typeof ReadableStream !== "undefined" && content instanceof ReadableStream) {
    const reader = content.getReader();
    let done = false;
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) yield r.value;
      done = true;
    } finally {
      // Stopped early (a size overrun, a failed store): cancel, so the connection is released
      if (done) reader.releaseLock();
      else await reader.cancel().catch(() => {});
    }
  } else {
    yield* content as Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  }
}

/**
 * The authoritative LFS object id: whole-object SHA-256 as bare lowercase hex.
 * SHA-256 is mandated by the LFS spec, so it is fixed here (not injected).
 *
 * The content may be one buffer or a stream of chunks; a stream is hashed
 * chunk by chunk with an incremental SHA-256, so a large object is never held
 * in memory whole.
 *
 * @example
 * ```typescript
 * const oid = await sha256Hex(store.read(id)); // streams the stored object
 * ```
 */
export async function sha256Hex(content: ByteSource): Promise<string> {
  const h = createSha256();
  for await (const chunk of chunksOf(content)) h.update(chunk);
  return bytesToHex(h.digest());
}
