/**
 * Push inflater that reports where each zlib (or raw deflate) stream ends, with
 * pooled state after JGit's InflaterCache.
 *
 * Built on pako's low-level zlib port:
 * - `zlibInflate(strm, Z_NO_FLUSH)` takes input in arbitrary pieces and keeps all
 *   state in the ZStream, so a chunk boundary can fall anywhere.
 * - At Z_STREAM_END, `strm.next_in` is the index in the current chunk of the first
 *   byte after the stream: the exact end, without inflating anything twice.
 * - Z_STREAM_END comes only after the Adler-32 trailer is read and checked, so a
 *   stream cut short never reaches it. That is what makes truncation detectable.
 */
import {
  Z_BUF_ERROR,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  ZStream,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
  zlibInflateReset,
} from "pako";
import { CompressionError } from "./types.js";

/** The input ended before the stream's end (for zlib: before its Adler-32 trailer). */
export class TruncatedStreamError extends CompressionError {
  constructor(message = "compressed stream ended before its end marker") {
    super(message);
    this.name = "TruncatedStreamError";
  }
}

/** The input is not a valid stream: bad header, bad block, or a checksum mismatch. */
export class InflateError extends CompressionError {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

/** What one `push` produced. */
export interface InflatePush {
  /** Decompressed bytes produced by this push, each a fresh copy. */
  out: Uint8Array[];
  /** True once the stream's end (including its checksum) has been read. */
  done: boolean;
  /** Bytes of the pushed chunk that belong to this stream; the rest follow it. */
  consumed: number;
}

/**
 * Inflates one stream from chunks pushed in order. After `done`, the bytes past
 * `consumed` belong to whatever follows the stream. Call `end()` when the input
 * is over: it throws `TruncatedStreamError` if the stream did not finish.
 */
export interface StreamInflater {
  push(chunk: Uint8Array): InflatePush;
  end(): void;
}

export interface InflaterOptions {
  /** Raw deflate (no zlib header or Adler-32), as in Xet or ZIP. */
  raw?: boolean;
}

/** A cache of inflate states. `createInflater` uses a shared one. */
export interface InflaterPool {
  acquire(options?: InflaterOptions): StreamInflater;
  /** States allocated so far. */
  readonly allocated: number;
  /** Idle states held for reuse (at most 4 per format). */
  readonly idle: number;
}

const OUT_SIZE = 64 * 1024;
/** JGit's InflaterCache.SZ. */
const MAX_IDLE = 4;
const EMPTY = new Uint8Array(0);

function newStream(raw: boolean): ZStream {
  const strm = new ZStream();
  const init = zlibInflateInit2(strm, raw ? -15 : 15);
  if (init !== Z_OK) throw new InflateError(`inflateInit2 failed: ${strm.msg || init}`);
  return strm;
}

/**
 * Inflates `chunk` into `buf`, copying produced bytes out. A shared output buffer
 * is safe because pushes are synchronous; returning views of it instead would pin
 * it (a 64 KiB buffer per view) for as long as the caller keeps the output.
 */
function pushInto(strm: ZStream, buf: Uint8Array<ArrayBuffer>, chunk: Uint8Array): InflatePush {
  const out: Uint8Array[] = [];
  strm.input = chunk;
  strm.next_in = 0;
  strm.avail_in = chunk.length;
  for (;;) {
    strm.output = buf;
    strm.next_out = 0;
    strm.avail_out = buf.length;
    const ret = zlibInflate(strm, Z_NO_FLUSH);
    const produced = buf.length - strm.avail_out;
    if (produced > 0) out.push(buf.slice(0, produced));
    if (ret === Z_STREAM_END) return { out, done: true, consumed: strm.next_in };
    if (ret !== Z_OK && ret !== Z_BUF_ERROR) {
      throw new InflateError(`inflate failed: ${strm.msg || `code ${ret}`}`);
    }
    // The output buffer filled: more output may be pending with no input left.
    if (strm.avail_out === 0) continue;
    // Input used up and the stream not ended: wait for the next chunk.
    if (strm.avail_in === 0) return { out, done: false, consumed: chunk.length };
    if (ret === Z_BUF_ERROR) throw new InflateError("inflate made no progress");
  }
}

/**
 * Create a pool of inflate states. Each acquired inflater owns one state while
 * its stream is open; when the stream ends, fails or is found truncated, the
 * state is reset and kept for the next stream, or freed if 4 are already idle.
 *
 * @example
 * ```typescript
 * const pool = createInflaterPool();
 * const inf = pool.acquire();
 * const { out, done, consumed } = inf.push(chunk);
 * ```
 */
export function createInflaterPool(): InflaterPool {
  const idle = { zlib: [] as ZStream[], raw: [] as ZStream[] };
  const buf = new Uint8Array(OUT_SIZE);
  let allocated = 0;

  const release = (strm: ZStream, list: ZStream[]) => {
    // pako's inflateReset keeps strm.input; drop it so an idle state does not keep
    // the caller's last chunk (often a whole pack window) alive.
    strm.input = EMPTY;
    strm.next_in = 0;
    strm.avail_in = 0;
    if (list.length < MAX_IDLE && zlibInflateReset(strm) === Z_OK) list.push(strm);
    else zlibInflateEnd(strm);
  };

  return {
    get allocated() {
      return allocated;
    },
    get idle() {
      return idle.zlib.length + idle.raw.length;
    },
    acquire(options = {}) {
      const raw = options.raw === true;
      const list = raw ? idle.raw : idle.zlib;
      let owned: ZStream | undefined = list.pop();
      if (!owned) {
        owned = newStream(raw);
        allocated++;
      }
      let finished = false;
      const giveBack = () => {
        if (owned) {
          release(owned, list);
          owned = undefined;
        }
      };
      return {
        push(chunk) {
          if (!owned) throw new Error("inflater used after its stream ended");
          if (chunk.length === 0) return { out: [], done: false, consumed: 0 };
          let r: InflatePush;
          try {
            r = pushInto(owned, buf, chunk);
          } catch (e) {
            giveBack();
            throw e;
          }
          if (r.done) {
            finished = true;
            giveBack();
          }
          return r;
        },
        end() {
          if (finished) return;
          if (owned) {
            giveBack();
            throw new TruncatedStreamError();
          }
        },
      };
    },
  };
}

const shared = createInflaterPool();

/**
 * Create an inflater for one zlib stream (or raw deflate with `{ raw: true }`),
 * backed by a shared state pool.
 *
 * @example
 * ```typescript
 * const inf = createInflater();
 * for (const chunk of chunks) {
 *   const { out, done, consumed } = inf.push(chunk);
 *   output.push(...out);
 *   if (done) { rest = chunk.subarray(consumed); break; }
 * }
 * inf.end(); // throws TruncatedStreamError if the stream never finished
 * ```
 */
export function createInflater(options?: InflaterOptions): StreamInflater {
  return shared.acquire(options);
}
