/**
 * Read at most `maxBytes` from the start of a stream, then stop pulling it.
 *
 * The source is closed (its `return()` is called) once enough bytes are read, so
 * a large blob is never read past its prefix. Content sniffing (git's binary
 * check looks at the first 8000 bytes) reads through this.
 *
 * @example
 * ```typescript
 * const head = await readPrefix(blobs.load(id), 8000);
 * const binary = head.includes(0);
 * ```
 *
 * @param input The stream to read
 * @param maxBytes The most bytes to return
 * @returns A copy of the first `min(maxBytes, stream length)` bytes
 */
export async function readPrefix(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(Math.max(0, maxBytes));
  let at = 0;
  if (out.length === 0) return out;
  for await (const chunk of input) {
    const count = Math.min(chunk.length, out.length - at);
    out.set(chunk.subarray(0, count), at);
    at += count;
    if (at >= out.length) break;
  }
  return at === out.length ? out : out.slice(0, at);
}
