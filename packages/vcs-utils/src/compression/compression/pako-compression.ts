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

type PakoStream = {
  push(data: Uint8Array, flush: boolean): boolean;
  onData(chunk: Uint8Array): void;
  onEnd(status: number): void;
  err: number;
  msg: string;
  ended?: boolean;
};

/**
 * Drive a push-based pako stream from an async source: each input chunk is pushed
 * as it arrives and the chunks pako emits (`onData`) are yielded right away, so
 * neither the input nor the output is ever held whole.
 */
async function* pump(
  stream: ByteStream,
  engine: PakoStream,
  what: "compression" | "decompression",
): ByteStream {
  let out: Uint8Array[] = [];
  engine.onData = (chunk) => {
    out.push(chunk);
  };
  // pako's default onEnd glues the chunks together; nothing is collected here
  engine.onEnd = () => {};
  const fail = (): never => {
    throw new CompressionError(`Pako ${what} failed: ${engine.msg || `error ${engine.err}`}`);
  };

  for await (const chunk of stream) {
    if (chunk.length === 0) continue;
    if (!engine.push(chunk, false)) fail();
    if (out.length > 0) {
      const ready = out;
      out = [];
      yield* ready;
    }
    // A zlib stream ends before trailing bytes; inflate stops reading there
    if (engine.ended) break;
  }
  if (!engine.ended && !engine.push(new Uint8Array(0), true)) fail();
  if (engine.err !== 0) fail();
  yield* out;
}

/**
 * Compress a stream using pako
 *
 * Push-based: each input chunk goes to a pako `Deflate` as it arrives and the
 * compressed chunks it emits are yielded at once (about 16 KiB each), so the
 * input and the output are never concatenated.
 */
export function deflatePako(stream: ByteStream, options?: StreamingCompressionOptions): ByteStream {
  const level = (options?.level ?? 6) as PakoLevel;
  const engine = new pako.Deflate({ level, raw: options?.raw ?? false });
  return pump(stream, engine as unknown as PakoStream, "compression");
}

/**
 * Decompress a stream using pako
 *
 * Push-based: each input chunk goes to a pako `Inflate` as it arrives and the
 * decompressed chunks it emits are yielded at once (about 64 KiB each). Input
 * after the end of the zlib stream is not read. A stream cut short rejects with
 * `CompressionError`.
 */
export function inflatePako(stream: ByteStream, options?: StreamingCompressionOptions): ByteStream {
  const engine = new pako.Inflate({ raw: options?.raw ?? false });
  return pump(stream, engine as unknown as PakoStream, "decompression");
}

/**
 * Create a pako-based compression implementation
 *
 * This implementation works universally in Node.js and browsers.
 * Streams are compressed and decompressed chunk by chunk (push-based pako);
 * the block functions work on whole buffers.
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
