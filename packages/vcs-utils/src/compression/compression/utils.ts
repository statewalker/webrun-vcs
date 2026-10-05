/**
 * Stream utility functions for working with byte streams
 */

import type { ByteStream } from "./types.js";

/**
 * Collect all chunks from a byte stream into a single Uint8Array
 *
 * @param stream Byte stream to collect
 * @returns Combined Uint8Array containing all chunks
 */
export async function collectStream(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  // Fast path: single chunk
  if (chunks.length === 1) {
    return chunks[0];
  }

  // Fast path: empty stream
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }

  // Combine chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Create a byte stream from a single buffer
 *
 * @param data Buffer to stream
 * @returns Byte stream yielding the buffer
 */
export async function* streamFromBuffer(data: Uint8Array): ByteStream {
  yield data;
}

/**
 * Create a byte stream from multiple buffers
 *
 * @param chunks Iterable of buffers to stream
 * @returns Byte stream yielding each buffer
 */
export async function* streamFromBuffers(chunks: Iterable<Uint8Array>): ByteStream {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Create a byte stream from an async iterable
 *
 * @param source Async iterable of buffers
 * @returns Byte stream yielding each buffer
 */
export async function* streamFromAsyncIterable(source: AsyncIterable<Uint8Array>): ByteStream {
  for await (const chunk of source) {
    yield chunk;
  }
}
