/**
 * One-shot zlib deflate of bytes held in memory, synchronous, for small objects.
 *
 * The streaming `deflate` goes through the platform's `CompressionStream`: a stream, a
 * reader and (on Node) a round trip through libuv's thread pool per object, which costs far
 * more than compressing a few hundred bytes. Here pako's port of zlib compresses the whole
 * input in one call on a pooled state (one per level, reset between uses, as JGit's
 * `Deflater` cache), so writing a small loose object makes no allocation beyond its result.
 * The output is what zlib's `compress2` writes for the same level (pako is a port of zlib's
 * deflate): with level 1, byte for byte the loose objects git writes by default
 * (`core.looseCompression` unset is `Z_BEST_SPEED`).
 */
import {
  Z_FINISH,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  ZStream,
  zlibDeflate,
  zlibDeflateInit2,
  zlibDeflateReset,
} from "pako";
import { CompressionError } from "./types.js";

/** zlib's `Z_DEFLATED`, `MAX_WBITS`, default `memLevel` and `Z_DEFAULT_STRATEGY`. */
const Z_DEFLATED = 8;
const WINDOW_BITS = 15;
const MEM_LEVEL = 8;
const STRATEGY = 0;

/** git's default level for loose objects (`core.looseCompression`: `Z_BEST_SPEED`). */
export const LOOSE_OBJECT_COMPRESSION_LEVEL = 1;

/**
 * The stream a deflate writes: a zlib stream (header and Adler-32 trailer), raw deflate data
 * (zlib's negative `windowBits`: zip entries) or a gzip member with zlib's default header
 * (no name, time 0, the OS byte 3, as git's `git archive --format=tgz` writes it).
 */
export type DeflateFormat = "zlib" | "raw" | "gzip";

const WINDOW_BITS_OF: Record<DeflateFormat, number> = {
  zlib: WINDOW_BITS,
  raw: -WINDOW_BITS,
  gzip: WINDOW_BITS + 16,
};

/** Pooled deflate states, by format and level (-1 to 9). */
const pool = new Map<string, ZStream>();

/** zlib's `deflateBound` for a zlib stream (wrapper included) of `n` input bytes. */
function deflateBound(n: number): number {
  return n + (n >> 12) + (n >> 14) + (n >> 25) + 13 + 6;
}

/**
 * The zlib stream (header, deflate data, Adler-32 trailer) of `chunks` taken as one input,
 * compressed at `level` (default 6, zlib's default; git writes loose objects at
 * {@link LOOSE_OBJECT_COMPRESSION_LEVEL}). `format` asks for raw deflate data or a gzip
 * member instead (see {@link DeflateFormat}). The deflate data is pako's: for inputs past a
 * few KiB it can differ from what a newer system zlib writes, though it inflates the same.
 *
 * @example
 * ```typescript
 * const header = new TextEncoder().encode("blob 6\0");
 * const stored = deflateSync([header, new TextEncoder().encode("hello\n")], { level: 1 });
 * // the bytes of .git/objects/ce/013625030ba8dba906f756967f9e9ca394464a as git writes them
 * ```
 */
export function deflateSync(
  chunks: readonly Uint8Array[],
  options?: { level?: number; format?: DeflateFormat },
): Uint8Array {
  const level = options?.level ?? 6;
  const format = options?.format ?? "zlib";
  const windowBits = WINDOW_BITS_OF[format];
  if (!Number.isInteger(level) || level < -1 || level > 9) {
    throw new RangeError(`bad compression level ${level}`);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  let input: Uint8Array;
  if (chunks.length === 1) input = chunks[0] as Uint8Array;
  else {
    input = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      input.set(chunk, at);
      at += chunk.length;
    }
  }
  const key = `${format}:${level}`;
  let strm = pool.get(key);
  if (strm) {
    pool.delete(key); // taken: a reentrant call (none today) gets a state of its own
    if (zlibDeflateReset(strm) !== Z_OK) strm = undefined;
  }
  if (!strm) {
    strm = new ZStream();
    if (zlibDeflateInit2(strm, level, Z_DEFLATED, windowBits, MEM_LEVEL, STRATEGY) !== Z_OK) {
      throw new CompressionError(`deflate init failed: ${strm.msg || "unknown error"}`);
    }
  }
  // a gzip wrapper is 18 bytes against zlib's 6
  const out = new Uint8Array(deflateBound(total) + 12);
  strm.input = input;
  strm.next_in = 0;
  strm.avail_in = input.length;
  strm.output = out;
  strm.next_out = 0;
  strm.avail_out = out.length;
  const ret = zlibDeflate(strm, Z_FINISH);
  if (ret !== Z_STREAM_END) {
    throw new CompressionError(`deflate failed: ${strm.msg || `code ${ret}`}`);
  }
  const length = strm.next_out;
  // release the input and output, keep the state for the next call
  strm.input = null as unknown as Uint8Array;
  strm.output = null as unknown as Uint8Array<ArrayBuffer>;
  pool.set(key, strm);
  return out.subarray(0, length);
}

/** An incremental deflate (see {@link createDeflater}). */
export interface Deflater {
  /** Compresses a chunk; returns the compressed bytes ready so far (often none) */
  push(chunk: Uint8Array): Uint8Array[];
  /** Ends the stream: the remaining compressed bytes and the trailer */
  finish(): Uint8Array[];
}

/** The output buffer of {@link createDeflater}. */
const DEFLATER_OUTPUT = 64 * 1024;

/**
 * An incremental deflate, for input too large to hold whole (`git archive`'s streamed
 * blobs, `tgz`): the chunks are compressed as they come, without flushing between them, so
 * the result is the bytes {@link deflateSync} writes for their concatenation, whatever their
 * sizes (zlib's output does not depend on how its input is split; level 0's stored blocks
 * aside, whose sizes follow the buffers).
 *
 * @example
 * ```typescript
 * const deflater = createDeflater({ format: "raw", level: 6 });
 * const out = [...deflater.push(first), ...deflater.push(second), ...deflater.finish()];
 * ```
 */
export function createDeflater(options?: { level?: number; format?: DeflateFormat }): Deflater {
  const level = options?.level ?? 6;
  const format = options?.format ?? "zlib";
  if (!Number.isInteger(level) || level < -1 || level > 9) {
    throw new RangeError(`bad compression level ${level}`);
  }
  const strm = new ZStream();
  if (
    zlibDeflateInit2(strm, level, Z_DEFLATED, WINDOW_BITS_OF[format], MEM_LEVEL, STRATEGY) !== Z_OK
  ) {
    throw new CompressionError(`deflate init failed: ${strm.msg || "unknown error"}`);
  }
  let ended = false;
  const run = (input: Uint8Array, flush: typeof Z_NO_FLUSH | typeof Z_FINISH): Uint8Array[] => {
    if (ended) throw new CompressionError("deflate already finished");
    const out: Uint8Array[] = [];
    strm.input = input;
    strm.next_in = 0;
    strm.avail_in = input.length;
    for (;;) {
      const buffer = new Uint8Array(DEFLATER_OUTPUT);
      strm.output = buffer;
      strm.next_out = 0;
      strm.avail_out = buffer.length;
      const ret = zlibDeflate(strm, flush);
      if (ret !== Z_OK && ret !== Z_STREAM_END && !(ret === -5 && strm.next_out === 0)) {
        throw new CompressionError(`deflate failed: ${strm.msg || `code ${ret}`}`);
      }
      if (strm.next_out > 0) out.push(buffer.subarray(0, strm.next_out));
      if (ret === Z_STREAM_END) {
        ended = true;
        break;
      }
      // more output pending only while the buffer came back full
      if (strm.avail_out !== 0 && strm.avail_in === 0) break;
    }
    strm.input = null as unknown as Uint8Array;
    strm.output = null as unknown as Uint8Array<ArrayBuffer>;
    return out;
  };
  return {
    push: (chunk) => (chunk.length === 0 ? [] : run(chunk, Z_NO_FLUSH)),
    finish: () => run(new Uint8Array(0), Z_FINISH),
  };
}
