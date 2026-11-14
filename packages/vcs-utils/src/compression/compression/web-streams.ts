/**
 * Web Compression Streams API streaming implementation
 *
 * Uses the browser's native CompressionStream/DecompressionStream API
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream
 */

import type { ByteStream, StreamingCompressionOptions } from "./types.js";
import { CompressionError } from "./types.js";

/**
 * Get compression format for Web API
 * Web API "deflate" = ZLIB format, "deflate-raw" = raw DEFLATE
 */
function getFormat(raw?: boolean): CompressionFormat {
  return raw ? ("deflate-raw" as CompressionFormat) : "deflate";
}

/**
 * Compress a stream using DEFLATE (Web implementation).
 *
 * Input is pulled as the compressor accepts it. When the consumer stops early
 * or fails, the compression stream is cancelled and the source closed (its
 * `return()` runs), so no pump or zlib state is left behind. An error from the
 * source is rethrown unchanged; compressor errors become `CompressionError`.
 */
export async function* deflateWeb(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  const cs = new CompressionStream(getFormat(options?.raw));
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  let sourceError: { error: unknown } | undefined;
  const pump = (async () => {
    try {
      for await (const chunk of stream) await writer.write(chunk as unknown as BufferSource);
      await writer.close();
    } catch (error) {
      // a failed write after a cancel lands here too; only the source's own error matters
      sourceError ??= { error };
      await writer.abort(error).catch(() => {});
    }
  })();
  let completed = false;
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (error) {
        await pump;
        if (sourceError) throw sourceError.error;
        throw new CompressionError(`Web compression failed: ${error}`, error);
      }
      if (r.done) break;
      yield r.value;
    }
    await pump;
    if (sourceError) throw sourceError.error;
    completed = true;
  } finally {
    if (!completed) {
      // Stopped early or failed: cancel, so the pending write rejects and the
      // pump's for-await exits, closing the source.
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    }
    reader.releaseLock();
  }
}

/**
 * Decompress a stream using INFLATE (Web implementation)
 */
export async function* inflateWeb(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  try {
    const format = getFormat(options?.raw);
    const decompressionStream = new DecompressionStream(format);
    const writer = decompressionStream.writable.getWriter();
    const reader = decompressionStream.readable.getReader();

    // Start writing input stream to decompression stream
    const writePromise = (async () => {
      try {
        for await (const chunk of stream) {
          await writer.write(chunk as unknown as BufferSource);
        }
        await writer.close();
      } catch (err) {
        await writer.abort(err);
        throw err;
      }
    })();
    // Prevent unhandled rejection if generator is aborted before await
    writePromise.catch(() => {});

    // Read and yield decompressed chunks
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }

    // Ensure write completed without error
    await writePromise;
  } catch (error) {
    throw new CompressionError(`Web decompression failed: ${error}`, error);
  }
}
