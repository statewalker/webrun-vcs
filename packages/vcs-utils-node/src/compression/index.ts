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
  };
}
