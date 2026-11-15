/**
 * Reading xorbs (https://huggingface.co/docs/xet/xorb): a sequence of chunks, each an 8-byte
 * header (version 0, compressed size as 3 bytes little-endian, compression type, uncompressed
 * size as 3 bytes little-endian) and its payload. Decoding streams: one chunk (at most 128 KiB
 * uncompressed in practice) is held at a time, whatever the size of the xorb.
 */

import { lz4FrameDecode } from "../lz4/index.js";
import { bg4Regroup } from "./bg4.js";

/** a chunk's compression scheme */
export const XorbCompression = {
  None: 0,
  LZ4: 1,
  ByteGrouping4LZ4: 2,
} as const;
export type XorbCompression = (typeof XorbCompression)[keyof typeof XorbCompression];

/** the 8 bytes before each chunk's payload */
export interface XorbChunkHeader {
  version: number;
  compressedSize: number;
  compression: number;
  uncompressedSize: number;
}

export const XORB_CHUNK_HEADER_SIZE = 8;
/** the largest chunk xet-core accepts, uncompressed (`xorb_chunk_format.rs`: 128 KiB) */
export const XORB_MAX_CHUNK_SIZE = 128 * 1024;
/** the largest chunk payload xet-core accepts, compressed (twice the chunk maximum: 256 KiB) */
export const XORB_MAX_COMPRESSED_CHUNK_SIZE = 2 * XORB_MAX_CHUNK_SIZE;

/** refuses sizes past xet-core's limits (before a payload is read or decoded) */
export function checkXorbChunkSizes(compressedSize: number, uncompressedSize: number): void {
  if (uncompressedSize > XORB_MAX_CHUNK_SIZE)
    throw new Error(`xorb: a chunk of ${uncompressedSize} bytes (at most 128 KiB)`);
  if (compressedSize > XORB_MAX_COMPRESSED_CHUNK_SIZE)
    throw new Error(`xorb: a chunk payload of ${compressedSize} bytes (at most 256 KiB)`);
}

/** parses a chunk header at `at` */
export function parseXorbChunkHeader(b: Uint8Array, at = 0): XorbChunkHeader {
  if (b.length - at < XORB_CHUNK_HEADER_SIZE) throw new Error("xorb: truncated chunk header");
  return {
    version: b[at] as number,
    compressedSize:
      (b[at + 1] as number) | ((b[at + 2] as number) << 8) | ((b[at + 3] as number) << 16),
    compression: b[at + 4] as number,
    uncompressedSize:
      (b[at + 5] as number) | ((b[at + 6] as number) << 8) | ((b[at + 7] as number) << 16),
  };
}

/** one chunk's payload decoded to its `size` bytes (a copy: never a view of `payload`) */
export function decodeXorbChunk(
  compression: number,
  payload: Uint8Array,
  size: number,
): Uint8Array {
  checkXorbChunkSizes(payload.length, size);
  if (compression === XorbCompression.None) {
    if (payload.length !== size) throw new Error("xorb: stored chunk of the wrong size");
    return payload.slice();
  }
  if (compression === XorbCompression.LZ4) return lz4FrameDecode(payload, size);
  if (compression === XorbCompression.ByteGrouping4LZ4)
    return bg4Regroup(lz4FrameDecode(payload, size));
  throw new Error(`xorb: unknown compression ${compression}`);
}

/**
 * Pieces of a byte stream, read without copying the rest on each read: `take(n)` copies only when
 * its bytes span pieces.
 */
class ByteQueue {
  private pieces: Uint8Array[] = [];
  private head = 0; // read position in pieces[0]
  length = 0;

  push(p: Uint8Array) {
    if (!p.length) return;
    this.pieces.push(p);
    this.length += p.length;
  }

  peek(n: number): Uint8Array {
    return this.read(n, false);
  }

  take(n: number): Uint8Array {
    return this.read(n, true);
  }

  private read(n: number, consume: boolean): Uint8Array {
    if (n > this.length) throw new Error("xorb: internal read past the queue");
    const first = this.pieces[0];
    let out: Uint8Array;
    if (first && first.length - this.head >= n) out = first.subarray(this.head, this.head + n);
    else {
      out = new Uint8Array(n);
      let o = 0;
      let k = 0;
      let h = this.head;
      while (o < n) {
        const p = this.pieces[k] as Uint8Array;
        const m = Math.min(n - o, p.length - h);
        out.set(p.subarray(h, h + m), o);
        o += m;
        h = 0;
        k++;
      }
    }
    if (consume) this.skip(n);
    return out;
  }

  private skip(n: number) {
    this.length -= n;
    while (n > 0) {
      const p = this.pieces[0] as Uint8Array;
      const left = p.length - this.head;
      if (n < left) {
        this.head += n;
        return;
      }
      n -= left;
      this.pieces.shift();
      this.head = 0;
    }
  }
}

const XETB = [0x58, 0x45, 0x54, 0x42];

/**
 * The chunks of a xorb byte stream, decoded one at a time as the bytes arrive. With `count`, the
 * first `count` chunks: the stream is closed after them (a fetched range may run on past them:
 * later chunks, a `XETB` footer). Without it, every chunk up to the end of the stream or a `XETB`
 * footer.
 */
export async function* readXorbChunks(
  bytes: AsyncIterable<Uint8Array>,
  count?: number,
): AsyncGenerator<Uint8Array> {
  const it = bytes[Symbol.asyncIterator]();
  const q = new ByteQueue();
  let ended = false;
  const need = async (n: number) => {
    while (q.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else q.push(r.value);
    }
    return q.length >= n;
  };
  try {
    for (let k = 0; count === undefined || k < count; k++) {
      if (count === undefined) {
        if (!(await need(1))) return;
        if ((await need(4)) && q.peek(4).every((b, i) => b === XETB[i])) return;
      }
      if (!(await need(XORB_CHUNK_HEADER_SIZE)))
        throw new Error(
          count === undefined
            ? "xorb: truncated chunk header"
            : "xorb: range ends before its chunks",
        );
      const h = parseXorbChunkHeader(q.take(XORB_CHUNK_HEADER_SIZE));
      if (h.version !== 0) throw new Error(`xorb: chunk header version ${h.version}`);
      checkXorbChunkSizes(h.compressedSize, h.uncompressedSize);
      if (!(await need(h.compressedSize))) throw new Error("xorb: truncated chunk");
      yield decodeXorbChunk(h.compression, q.take(h.compressedSize), h.uncompressedSize);
    }
  } finally {
    await it.return?.();
  }
}
