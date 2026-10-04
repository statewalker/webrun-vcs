/**
 * Pako-based partial decompression implementation
 *
 * Uses pako's low-level zlib API to decompress zlib/deflate data and track
 * bytes consumed. This is essential for git pack file parsing where multiple
 * compressed objects are concatenated without explicit length prefixes.
 *
 * The low-level API correctly handles trailing data and reports exactly how
 * many bytes were consumed via strm.total_in, making this O(1) for boundary
 * detection vs O(log n) decompression attempts with the Web Streams API.
 */

import {
  Z_BUF_ERROR,
  Z_FINISH,
  Z_OK,
  Z_STREAM_END,
  ZStream,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
} from "pako";
import type { PartialDecompressionResult, StreamingCompressionOptions } from "./types.js";
import { CompressionError } from "./types.js";

// Initial output buffer size (64KB, will grow if needed)
const INITIAL_OUTPUT_SIZE = 65536;

/**
 * Decompress a data block and return how many bytes were consumed.
 *
 * Uses pako's low-level zlib API which correctly handles trailing data
 * and reports exact bytes consumed via strm.total_in.
 *
 * @param data Compressed data (may contain trailing data from next object)
 * @param options Decompression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Decompressed data and number of input bytes consumed
 */
export function decompressBlockPartialPako(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): PartialDecompressionResult {
  // Create z_stream structure (pako 3 exports the low-level zlib API)
  const strm = new ZStream();

  try {
    // Initialize inflator
    // windowBits: 15 for zlib format, -15 for raw deflate
    const windowBits = options?.raw ? -15 : 15;
    let ret = zlibInflateInit2(strm, windowBits);
    if (ret !== Z_OK) {
      throw new CompressionError(`Pako inflateInit2 failed: ${strm.msg || `error code ${ret}`}`);
    }

    // Set input
    strm.input = data;
    strm.next_in = 0;
    strm.avail_in = data.length;

    // Collect output chunks (in case data is larger than buffer)
    const outputChunks: Uint8Array[] = [];
    let outputBuffer = new Uint8Array(INITIAL_OUTPUT_SIZE);

    // Decompress in a loop until Z_STREAM_END
    do {
      strm.output = outputBuffer;
      strm.next_out = 0;
      strm.avail_out = outputBuffer.length;

      ret = zlibInflate(strm, Z_FINISH);

      if (ret !== Z_OK && ret !== Z_STREAM_END && ret !== Z_BUF_ERROR) {
        throw new CompressionError(`Pako decompression failed: ${strm.msg || `error code ${ret}`}`);
      }

      // Save produced output
      const produced = outputBuffer.length - strm.avail_out;
      if (produced > 0) {
        outputChunks.push(outputBuffer.slice(0, produced));
      }

      // If buffer was full and we're not done, we need more space
      if (ret === Z_BUF_ERROR && strm.avail_out === 0) {
        outputBuffer = new Uint8Array(INITIAL_OUTPUT_SIZE);
      }
    } while (ret !== Z_STREAM_END && strm.avail_in > 0);

    // Get bytes consumed from input
    const bytesRead = strm.total_in;

    // Combine output chunks
    let result: Uint8Array;
    if (outputChunks.length === 0) {
      result = new Uint8Array(0);
    } else if (outputChunks.length === 1) {
      result = outputChunks[0];
    } else {
      const totalLength = outputChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of outputChunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
    }

    return {
      data: result,
      bytesRead,
    };
  } catch (error) {
    if (error instanceof CompressionError) {
      throw error;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Pako partial decompression failed: ${err.message}`, err);
  } finally {
    // Clean up zlib state
    zlibInflateEnd(strm);
  }
}
