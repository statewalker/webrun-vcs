/**
 * Node.js compression implementation
 *
 * Uses Node.js built-in zlib module for efficient compression/decompression.
 * Import this module and call setCompressionUtils() to use Node.js compression.
 *
 * @example
 * ```ts
 * import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
 * import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
 *
 * setCompressionUtils(createNodeCompression());
 * ```
 */
import { promisify } from "node:util";
import zlib from "node:zlib";
import type {
  ByteStream,
  CompressionUtils,
  StreamingCompressionOptions,
} from "@statewalker/vcs-utils/compression";
import { CompressionError } from "@statewalker/vcs-utils/compression";

/**
 * Compress a stream using DEFLATE (Node.js implementation)
 */
export async function* deflateNode(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  const deflater = options?.raw
    ? zlib.createDeflateRaw({ level: options?.level ?? 6 })
    : zlib.createDeflate({ level: options?.level ?? 6 });

  const outputQueue: Uint8Array[] = [];
  let resolveWait: (() => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  deflater.on("data", (chunk: Buffer) => {
    outputQueue.push(new Uint8Array(chunk));
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  deflater.on("end", () => {
    finished = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  deflater.on("error", (err) => {
    error = err;
    finished = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  (async () => {
    try {
      for await (const chunk of stream) {
        deflater.write(Buffer.from(chunk));
      }
      deflater.end();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      deflater.destroy();
    }
  })();

  while (!finished || outputQueue.length > 0) {
    if (outputQueue.length > 0) {
      const chunk = outputQueue.shift();
      if (chunk) yield chunk;
    } else if (!finished) {
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  }

  if (error !== null) {
    const err = error as Error;
    throw new CompressionError(`Compression failed: ${err.message}`, err);
  }
}

/**
 * Decompress a stream using INFLATE (Node.js implementation)
 */
export async function* inflateNode(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  const inflater = options?.raw ? zlib.createInflateRaw() : zlib.createInflate();

  const outputQueue: Uint8Array[] = [];
  let resolveWait: (() => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  inflater.on("data", (chunk: Buffer) => {
    outputQueue.push(new Uint8Array(chunk));
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  inflater.on("end", () => {
    finished = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  inflater.on("error", (err) => {
    error = err;
    finished = true;
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  (async () => {
    try {
      for await (const chunk of stream) {
        inflater.write(Buffer.from(chunk));
      }
      inflater.end();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      inflater.destroy();
    }
  })();

  while (!finished || outputQueue.length > 0) {
    if (outputQueue.length > 0) {
      const chunk = outputQueue.shift();
      if (chunk) yield chunk;
    } else if (!finished) {
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  }

  if (error !== null) {
    const err = error as Error;
    throw new CompressionError(`Decompression failed: ${err.message}`, err);
  }
}

/**
 * Compress a data block using DEFLATE (Node.js optimized)
 */
export async function compressBlockNode(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<Uint8Array> {
  const level = options?.level ?? 6;
  const zlibOptions = { level };

  if (options?.raw) {
    const deflateRaw = promisify(zlib.deflateRaw);
    const result = await deflateRaw(Buffer.from(data), zlibOptions);
    return new Uint8Array(result);
  }
  const deflateZlib = promisify(zlib.deflate);
  const result = await deflateZlib(Buffer.from(data), zlibOptions);
  return new Uint8Array(result);
}

/**
 * Decompress a data block using INFLATE (Node.js optimized)
 */
export async function decompressBlockNode(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<Uint8Array> {
  if (options?.raw) {
    const inflateRaw = promisify(zlib.inflateRaw);
    const result = await inflateRaw(Buffer.from(data));
    return new Uint8Array(result);
  }
  const inflateZlib = promisify(zlib.inflate);
  const result = await inflateZlib(Buffer.from(data));
  return new Uint8Array(result);
}

/**
 * Decompress a data block and return how many bytes were consumed.
 *
 * This is essential for pack file parsing where multiple compressed
 * objects are concatenated without explicit length prefixes.
 *
 * Uses binary search to find the exact zlib stream boundary.
 */
export async function decompressBlockPartialNode(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): Promise<{ data: Uint8Array; bytesRead: number }> {
  const raw = options?.raw ?? false;
  const buffer = Buffer.from(data);

  // Binary search to find minimum input size that produces valid decompression
  // This works because:
  // - Too few bytes -> Z_BUF_ERROR (incomplete input)
  // - Exact bytes -> success
  // - Too many bytes -> success (in older Node) or ERR_TRAILING_JUNK_AFTER_STREAM_END (Node 24+)
  const minSize = raw ? 1 : 6;
  let low = minSize;
  let high = buffer.length;

  // First, check if we can decompress with full buffer
  // If it fails, return the error (invalid data)
  // If it succeeds, use binary search to find minimal size
  try {
    if (raw) {
      zlib.inflateRawSync(buffer);
    } else {
      zlib.inflateSync(buffer);
    }
    // No error - either no trailing data, or older Node that ignores it
    // Use binary search to find the exact boundary
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // ERR_TRAILING_JUNK_AFTER_STREAM_END means there IS trailing data
    // We'll use binary search to find boundary
    if (error.code !== "ERR_TRAILING_JUNK_AFTER_STREAM_END") {
      // Real error - propagate it
      throw err;
    }
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const slice = buffer.subarray(0, mid);
      if (raw) {
        zlib.inflateRawSync(slice);
      } else {
        zlib.inflateSync(slice);
      }
      // Success - try smaller input
      high = mid;
    } catch {
      // Need more bytes
      low = mid + 1;
    }
  }

  const slice = buffer.subarray(0, low);
  const result = raw ? zlib.inflateRawSync(slice) : zlib.inflateSync(slice);
  return { data: new Uint8Array(result), bytesRead: low };
}

/**
 * Create a Node.js compression implementation
 *
 * @returns CompressionUtils configured for Node.js
 *
 * @example
 * ```ts
 * import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
 * import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
 *
 * setCompressionUtils(createNodeCompression());
 * ```
 */
export function createNodeCompression(): CompressionUtils {
  return {
    deflate: deflateNode,
    inflate: inflateNode,
    compressBlock: compressBlockNode,
    decompressBlock: decompressBlockNode,
    decompressBlockPartial: decompressBlockPartialNode,
  };
}
