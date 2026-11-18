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

/** Pooled deflate states, by level (-1 to 9). */
const pool = new Map<number, ZStream>();

/** zlib's `deflateBound` for a zlib stream (wrapper included) of `n` input bytes. */
function deflateBound(n: number): number {
  return n + (n >> 12) + (n >> 14) + (n >> 25) + 13 + 6;
}

/**
 * The zlib stream (header, deflate data, Adler-32 trailer) of `chunks` taken as one input,
 * compressed at `level` (default 6, zlib's default; git writes loose objects at
 * {@link LOOSE_OBJECT_COMPRESSION_LEVEL}).
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
  options?: { level?: number },
): Uint8Array {
  const level = options?.level ?? 6;
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
  let strm = pool.get(level);
  if (strm) {
    pool.delete(level); // taken: a reentrant call (none today) gets a state of its own
    if (zlibDeflateReset(strm) !== Z_OK) strm = undefined;
  }
  if (!strm) {
    strm = new ZStream();
    if (zlibDeflateInit2(strm, level, Z_DEFLATED, WINDOW_BITS, MEM_LEVEL, STRATEGY) !== Z_OK) {
      throw new CompressionError(`deflate init failed: ${strm.msg || "unknown error"}`);
    }
  }
  const out = new Uint8Array(deflateBound(total));
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
  pool.set(level, strm);
  return out.subarray(0, length);
}
