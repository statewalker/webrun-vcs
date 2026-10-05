/**
 * Chunks a binary stream into fixed-size blocks.
 *
 * This utility takes an input stream of arbitrary-sized Uint8Array chunks
 * and yields fixed-size blocks. The final block may be smaller than the
 * specified size if the total stream length is not evenly divisible.
 *
 * Implementation uses array-based accumulation for efficiency:
 * - Incoming chunks are stored in an array without copying
 * - When accumulated size exceeds the target block size, bytes are copied
 *   to a new fixed-size block
 * - Any overflow is stored as the first element of the new chunk array
 *
 * Useful for:
 * - Network transport with fixed packet sizes
 * - Flow control with block-level acknowledgment
 * - Memory-efficient processing of large streams
 *
 * @example
 * ```typescript
 * // Chunk a stream into 128KB blocks
 * const blocks = toChunks(inputStream, 128 * 1024);
 * for await (const block of blocks) {
 *   await sendBlock(block); // Each block is exactly 128KB (except possibly last)
 * }
 * ```
 *
 * @param stream Input binary stream (sync or async iterable)
 * @param size Block size in bytes (default: 128KB)
 * @returns AsyncGenerator yielding fixed-size Uint8Array blocks
 */
export async function* toChunks(
  stream: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  size: number = 128 * 1024,
): AsyncGenerator<Uint8Array> {
  // Array of pending chunks (avoids copying until we need to emit)
  const pendingChunks: Uint8Array[] = [];
  let accumulatedSize = 0;

  for await (const chunk of stream) {
    if (chunk.length === 0) continue;

    pendingChunks.push(chunk);
    accumulatedSize += chunk.length;

    // Yield complete blocks while we have enough data
    while (accumulatedSize >= size) {
      const block = new Uint8Array(size);
      let blockOffset = 0;

      // Copy bytes from pending chunks to fill the block
      while (blockOffset < size && pendingChunks.length > 0) {
        const current = pendingChunks[0];
        const bytesNeeded = size - blockOffset;
        const bytesToCopy = Math.min(bytesNeeded, current.length);

        block.set(current.subarray(0, bytesToCopy), blockOffset);
        blockOffset += bytesToCopy;

        if (bytesToCopy < current.length) {
          // Partial copy - keep the remainder as first chunk
          pendingChunks[0] = current.subarray(bytesToCopy);
        } else {
          // Fully consumed this chunk
          pendingChunks.shift();
        }
      }

      accumulatedSize -= size;
      yield block;
    }
  }

  // Yield any remaining data as final (possibly smaller) block
  if (accumulatedSize > 0) {
    const finalBlock = new Uint8Array(accumulatedSize);
    let offset = 0;
    for (const chunk of pendingChunks) {
      finalBlock.set(chunk, offset);
      offset += chunk.length;
    }
    yield finalBlock;
  }
}
