/**
 * Re-cut a byte stream into chunks of exactly `chunkSize` bytes (the last one
 * may be shorter; an empty stream yields nothing). Each yielded chunk is a new
 * array the caller may keep. Memory is one chunk.
 *
 * @example
 * ```typescript
 * for await (const chunk of fixedSizeChunks(content, 256 * 1024)) {
 *   await kv.set(`chunk:${seq++}`, chunk);
 * }
 * ```
 */
export async function* fixedSizeChunks(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`bad chunk size ${chunkSize}`);
  }
  let buffer = new Uint8Array(chunkSize);
  let filled = 0;
  for await (const input of content) {
    let offset = 0;
    while (offset < input.length) {
      const n = Math.min(chunkSize - filled, input.length - offset);
      buffer.set(input.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === chunkSize) {
        yield buffer;
        buffer = new Uint8Array(chunkSize);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.slice(0, filled);
}
