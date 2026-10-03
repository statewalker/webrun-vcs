/**
 * Pako-based compression implementation
 *
 * Uses pako for both streaming and block compression/decompression.
 * This is a universal implementation that works in both Node.js and browsers.
 */

import * as pako from "pako";
import { decompressBlockPartialPako } from "./pako-inflate.js";
import type {
  ByteStream,
  CompressionUtils,
  PartialDecompressionResult,
  StreamingCompressionOptions,
} from "./types.js";
import { CompressionError } from "./types.js";

/**
 * Compress data using pako (block)
 */
type PakoLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | -1;

export function compressBlockPako(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Uint8Array {
  const level = (options?.level ?? 6) as PakoLevel;
  const raw = options?.raw ?? false;

  try {
    if (raw) {
      return pako.deflateRaw(data, { level });
    }
    return pako.deflate(data, { level });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Pako compression failed: ${err.message}`, err);
  }
}

/**
 * Decompress data using pako (block)
 */
export function decompressBlockPako(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Uint8Array {
  const raw = options?.raw ?? false;

  try {
    if (raw) {
      return pako.inflateRaw(data);
    }
    return pako.inflate(data);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Pako decompression failed: ${err.message}`, err);
  }
}

/**
 * Compress a stream using pako
 *
 * Collects all input, compresses as a block, then yields the result.
 * For true streaming compression, consider using web streams or node zlib.
 */
export async function* deflatePako(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  // Collect all input
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  // Combine chunks
  let input: Uint8Array;
  if (chunks.length === 0) {
    input = new Uint8Array(0);
  } else if (chunks.length === 1) {
    input = chunks[0];
  } else {
    input = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
  }

  // Compress and yield
  yield compressBlockPako(input, options);
}

/**
 * Decompress a stream using pako
 *
 * Collects all input, decompresses as a block, then yields the result.
 * For true streaming decompression, consider using web streams or node zlib.
 */
export async function* inflatePako(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  // Collect all input
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  // Combine chunks
  let input: Uint8Array;
  if (chunks.length === 0) {
    input = new Uint8Array(0);
  } else if (chunks.length === 1) {
    input = chunks[0];
  } else {
    input = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
  }

  // Decompress and yield
  yield decompressBlockPako(input, options);
}

/**
 * Create a pako-based compression implementation
 *
 * This implementation works universally in Node.js and browsers.
 * It uses block-based compression/decompression (collects all data first).
 *
 * @returns CompressionUtils configured for pako
 *
 * @example
 * ```ts
 * import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
 * import { createPakoCompression } from "@statewalker/vcs-utils/compression";
 *
 * setCompressionUtils(createPakoCompression());
 * ```
 */
export function createPakoCompression(): CompressionUtils {
  return {
    deflate: deflatePako,
    inflate: inflatePako,
    compressBlock: async (data, options) => compressBlockPako(data, options),
    decompressBlock: async (data, options) => decompressBlockPako(data, options),
    decompressBlockPartial: async (data, options): Promise<PartialDecompressionResult> =>
      decompressBlockPartialPako(data, options),
  };
}
