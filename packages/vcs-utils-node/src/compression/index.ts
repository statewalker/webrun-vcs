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

/** The stream's iterator; plain arrays and other sync iterables are accepted too. */
function iteratorOf(stream: ByteStream): AsyncIterator<Uint8Array> {
  if (Symbol.asyncIterator in Object(stream)) return stream[Symbol.asyncIterator]();
  return (async function* () {
    yield* stream as unknown as Iterable<Uint8Array>;
  })();
}

/** Close an iterator without waiting for a source that is stalled in `next()`. */
function closeIterator(it: AsyncIterator<unknown>): void {
  try {
    const r = it.return?.();
    if (r && typeof r.then === "function") r.then(undefined, () => {});
  } catch {
    // the source failed to close; nothing more to do
  }
}

/** Resolves once `stream` can take more input, or is closed. */
function writable(stream: zlib.Deflate | zlib.DeflateRaw): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };
    stream.on("drain", done);
    stream.on("close", done);
  });
}

/**
 * Compress a stream using DEFLATE (Node.js implementation).
 *
 * Same contract as the Web implementation: input is pulled as zlib takes it
 * (backpressure); a consumer that stops early closes the source without waiting
 * for a stalled one; an error from the source is rethrown unchanged, and zlib's
 * own errors become `CompressionError`.
 */
export async function* deflateNode(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  const deflater = options?.raw
    ? zlib.createDeflateRaw({ level: options?.level ?? 6 })
    : zlib.createDeflate({ level: options?.level ?? 6 });
  const it = iteratorOf(stream);
  let stopped = false;
  let sourceError: { error: unknown } | undefined;
  void (async () => {
    try {
      for (;;) {
        const r = await it.next();
        if (stopped || deflater.destroyed) return;
        if (r.done) {
          deflater.end();
          return;
        }
        if (!deflater.write(Buffer.from(r.value))) await writable(deflater);
      }
    } catch (error) {
      if (stopped) return;
      sourceError = { error };
      deflater.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  let completed = false;
  try {
    try {
      for await (const chunk of deflater) yield new Uint8Array(chunk as Buffer);
    } catch (error) {
      if (sourceError) throw sourceError.error;
      throw new CompressionError(`Compression failed: ${(error as Error).message}`, error);
    }
    completed = true;
  } finally {
    if (!completed && !sourceError) {
      stopped = true;
      closeIterator(it);
      deflater.destroy();
    }
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
