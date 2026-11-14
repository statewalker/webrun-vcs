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

/** The stream's iterator; plain arrays and other sync iterables are accepted too. */
function iteratorOf(stream: ByteStream): AsyncIterator<Uint8Array> {
  if (Symbol.asyncIterator in Object(stream)) return stream[Symbol.asyncIterator]();
  return (async function* () {
    yield* stream as unknown as Iterable<Uint8Array>;
  })();
}

/**
 * Close an iterator without waiting: a source parked in `next()` (a stalled
 * network body, say) must not hold up the consumer that stopped reading it.
 */
function closeIterator(it: AsyncIterator<unknown>): void {
  try {
    const r = it.return?.();
    if (r && typeof r.then === "function") r.then(undefined, () => {});
  } catch {
    // the source failed to close; nothing more to do
  }
}

/**
 * Compress a stream using DEFLATE (Web implementation).
 *
 * Input is pulled as the compressor accepts it. When the consumer stops early
 * or fails, the source is closed (its `return()` is called, without waiting for
 * a source that is stalled) and the compressor cancelled. An error from the
 * source is rethrown unchanged; compressor errors become `CompressionError`.
 */
export async function* deflateWeb(
  stream: ByteStream,
  options?: StreamingCompressionOptions,
): ByteStream {
  const cs = new CompressionStream(getFormat(options?.raw));
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const it = iteratorOf(stream);
  let stopped = false;
  let failure: { error: unknown; fromSource: boolean } | undefined;
  const pump = (async () => {
    let fromSource = true;
    try {
      for (;;) {
        fromSource = true;
        const r = await it.next();
        if (stopped) return;
        if (r.done) break;
        fromSource = false;
        await writer.write(r.value as unknown as BufferSource);
      }
      await writer.close();
    } catch (error) {
      if (stopped) return;
      failure = { error, fromSource };
      if (!fromSource) closeIterator(it);
      // End the reader directly: after a failed write some runtimes never error it.
      await reader.cancel(error).catch(() => {});
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
        failure ??= { error, fromSource: false };
        break;
      }
      if (r.done) break;
      yield r.value;
    }
    await pump;
    if (failure) {
      if (failure.fromSource) throw failure.error;
      throw new CompressionError(`Web compression failed: ${failure.error}`, failure.error);
    }
    completed = true;
  } finally {
    if (!completed && !failure) {
      // The consumer stopped early or failed.
      stopped = true;
      closeIterator(it);
      await reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
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
