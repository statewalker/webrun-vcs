/**
 * Shared test utilities for storage test suites
 */

/**
 * Encode a string to Uint8Array
 */
export function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Decode a Uint8Array to string
 */
export function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/**
 * Convert a single Uint8Array to an async iterable
 */
export async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Convert multiple Uint8Arrays to an async iterable
 */
export async function* toAsyncIterableMulti(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Collect all chunks from an async iterable into a single Uint8Array
 */
export async function collectContent(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return concatArrays(chunks);
}

/**
 * Concatenate multiple Uint8Arrays into one
 */
export function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const totalSize = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Generate random content of specified size
 */
export function randomContent(size: number, seed = 12345): Uint8Array {
  const content = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    // Simple LCG random number generator
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    content[i] = s % 256;
  }
  return content;
}

/**
 * Generate content that fills with a pattern
 */
export function patternContent(size: number, pattern = 42): Uint8Array {
  const content = new Uint8Array(size);
  content.fill(pattern);
  return content;
}

/**
 * Generate content with all byte values (0-255)
 */
export function allBytesContent(): Uint8Array {
  const content = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    content[i] = i;
  }
  return content;
}
