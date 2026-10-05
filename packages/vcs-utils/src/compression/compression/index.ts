/**
 * Compression module
 *
 * Provides streaming and block-based compression/decompression operations.
 * By default uses Web Compression Streams API (WinterTC compliant).
 *
 * Use setCompressionUtils() to override with platform-specific implementations
 * (e.g., Node.js zlib for better performance).
 *
 * Primary API:
 * - Streaming: deflate(), inflate() - for large data or incremental processing
 * - Block: compressBlock(), decompressBlock() - for complete buffers
 */

import { decompressBlockPartialPako } from "./pako-inflate.js";
import {
  type ByteStream,
  type CompressBlockFunction,
  CompressionError,
  type CompressionUtils,
  type DecompressBlockFunction,
  type DecompressBlockPartialFunction,
  type DeflateFunction,
  type InflateFunction,
  type PartialDecompressionResult,
  type StreamingCompressionOptions,
} from "./types.js";
import { collectStream, streamFromBuffer } from "./utils.js";
import { deflateWeb, inflateWeb } from "./web-streams.js";

export * from "./pako-compression.js";
// Re-export types
export * from "./types.js";
export * from "./utils.js";

// Current implementations (default to web-based)
let _deflate: DeflateFunction = deflateWeb;
let _inflate: InflateFunction = inflateWeb;

let _compressBlock: CompressBlockFunction | null = null;
let _decompressBlock: DecompressBlockFunction | null = null;
let _decompressBlockPartial: DecompressBlockPartialFunction | null = null;

/**
 * Set custom compression utilities
 *
 * This allows overriding the default web-based compression with
 * platform-specific implementations (e.g., Node.js zlib for better performance).
 *
 * @example
 * ```ts
 * import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
 * import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
 *
 * setCompressionUtils(createNodeCompression());
 * ```
 */
export function setCompressionUtils(impl: Partial<CompressionUtils>): void {
  if (impl.deflate) _deflate = impl.deflate;
  if (impl.inflate) _inflate = impl.inflate;
  if (impl.compressBlock) _compressBlock = impl.compressBlock;
  if (impl.decompressBlock) _decompressBlock = impl.decompressBlock;
  if (impl.decompressBlockPartial) _decompressBlockPartial = impl.decompressBlockPartial;
}

/**
 * Compress a byte stream using DEFLATE
 *
 * @param stream Input byte stream
 * @param options Compression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Compressed byte stream
 */
export function deflate(stream: ByteStream, options?: StreamingCompressionOptions): ByteStream {
  return _deflate(stream, options);
}

/**
 * Decompress a byte stream using INFLATE
 *
 * @param stream Compressed byte stream
 * @param options Decompression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Decompressed byte stream
 */
export function inflate(stream: ByteStream, options?: StreamingCompressionOptions): ByteStream {
  return _inflate(stream, options);
}

/**
 * Compress a data block using DEFLATE
 *
 * @param data Data to compress
 * @param options Compression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Compressed data
 */
export async function compressBlock(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<Uint8Array> {
  try {
    // Use custom implementation if set
    if (_compressBlock) {
      return await _compressBlock(data, options);
    }
    // Fall back to streaming implementation
    const stream = streamFromBuffer(data);
    return await collectStream(deflate(stream, options));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Compression failed: ${err.message}`, err);
  }
}

/**
 * Decompress a data block using INFLATE
 *
 * @param data Compressed data
 * @param options Decompression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Decompressed data
 */
export async function decompressBlock(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<Uint8Array> {
  try {
    // Use custom implementation if set
    if (_decompressBlock) {
      return await _decompressBlock(data, options);
    }
    // Fall back to streaming implementation
    const stream = streamFromBuffer(data);
    return await collectStream(inflate(stream, options));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Decompression failed: ${err.message}`, err);
  }
}

/**
 * Decompress a data block and return how many bytes were consumed from input.
 *
 * Essential for pack file parsing where multiple compressed objects are
 * concatenated without explicit length prefixes. The header only contains
 * the uncompressed size, not the compressed size.
 *
 * @param data Compressed data (may contain trailing data from next object)
 * @param options Decompression options (raw: true for raw DEFLATE, false for ZLIB)
 * @returns Decompressed data and number of input bytes consumed
 */
export async function decompressBlockPartial(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<PartialDecompressionResult> {
  try {
    // Use custom implementation if set
    if (_decompressBlockPartial) {
      return await _decompressBlockPartial(data, options);
    }
    // Fall back to pako implementation
    return decompressBlockPartialPako(data, options);
  } catch (error) {
    if (error instanceof CompressionError) {
      throw error;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    throw new CompressionError(`Partial decompression failed: ${err.message}`, err);
  }
}
