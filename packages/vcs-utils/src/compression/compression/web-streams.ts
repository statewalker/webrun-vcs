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
 * Compress a stream using DEFLATE (Web implementation)
 */
export async function* deflateWeb(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  try {
    const format = getFormat(options?.raw);
    const compressionStream = new CompressionStream(format);
    const writer = compressionStream.writable.getWriter();
    try {
      const reader = compressionStream.readable.getReader();
      // Read and yield compressed chunks
      try {
        // Start writing input stream to compression stream
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }

        // Ensure write completed without error
        await writePromise;
      } finally {
        reader.releaseLock();
      }
    } finally {
      writer.releaseLock();
    }
  } catch (error) {
    throw new CompressionError(`Web compression failed: ${error}`, error);
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
