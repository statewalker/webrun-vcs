import { collect } from "./collect.js";
import { splitStream } from "./split-stream.js";

/**
 * Reads a header from an async iterable stream.
 * @param input the input async iterable stream
 * @param getHeaderEnd  function that determines the end of the header within a block.
 * @param maxLength Optional maximum length for the header. If exceeded, an error is thrown.
 * No limit if zero or negative. Default is -1.
 * @returns A tuple containing the header as a Uint8Array and an async generator for the remaining data.
 */
export async function readHeader(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  getHeaderEnd: (block: Uint8Array) => number,
  maxLength = -1,
): Promise<[header: Uint8Array, rest: AsyncGenerator<Uint8Array>]> {
  let header: Uint8Array | null = null;
  let len = 0;

  // Track if we've found the header split point
  let foundHeader = false;

  // Wrap the split function to only split once (on the header delimiter)
  const getSplitPos = (block: Uint8Array): number => {
    // Once we've found the header, don't split anymore
    if (foundHeader) {
      return -1;
    }

    const endPos = getHeaderEnd(block);
    if (endPos >= 0 && endPos <= block.length) {
      foundHeader = true;
      return endPos;
    }

    // Check max length
    if (maxLength > 0) {
      len += block.length;
      if (len > maxLength) {
        throw new Error(`Header exceeds maximum length of ${maxLength} bytes`);
      }
    }

    return -1;
  };

  let restGenerator: AsyncGenerator<Uint8Array> = (async function* () {})();

  for await (const it of splitStream(input, getSplitPos)) {
    if (header === null) {
      header = await collect(it);
    } else {
      // This generator contains ALL remaining content (no more splits)
      restGenerator = it;
      break;
    }
  }

  return [header || new Uint8Array(0), restGenerator];
}

/**
 * Reads ahead from an async iterable stream and returns the header and a combined stream (header + rest).
 *
 * @param input The input async iterable stream
 * @param getHeaderEnd Function that determines the end of the header within a block.
 * @param maxLength Optional maximum length for the header. If exceeded, an error is thrown.
 * @returns A tuple containing the header as a Uint8Array and an async generator for the remaining data.
 */
export async function readAhead(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  getHeaderEnd: (block: Uint8Array) => number,
  maxLength = -1,
): Promise<[header: Uint8Array, stream: AsyncGenerator<Uint8Array>]> {
  const [header, rest] = await readHeader(input, getHeaderEnd, maxLength);
  async function* combinedStream(): AsyncGenerator<Uint8Array> {
    yield header;
    yield* rest;
  }
  return [header, combinedStream()];
}

/**
 * Reads a fixed-length block from an async iterable stream.
 * @param input The input async iterable stream
 * @param len Number of bytes to read
 * @returns A Uint8Array containing exactly len bytes
 */
export async function readBlock(
  input: AsyncIterable<Uint8Array>,
  len: number,
): Promise<Uint8Array> {
  const result: Uint8Array = new Uint8Array(len);
  // Read data into result
  let offset = 0;
  for await (const chunk of input) {
    const toCopy = Math.min(chunk.length, len - offset);
    result.set(chunk.subarray(0, toCopy), offset);
    offset += toCopy;
    if (offset >= len) {
      break;
    }
  }
  return result;
}
