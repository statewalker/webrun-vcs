/**
 * Writing xorbs, used here to build test data and fixtures (the CAS upload API is not called by
 * this package).
 */

import { lz4FrameEncode } from "../lz4/index.js";
import { bg4Split } from "./bg4.js";
import { XORB_MAX_CHUNK_SIZE, XorbCompression } from "./xorb-reader.js";

/** at most this many chunks in a xorb (the specification's MUST) */
export const XORB_MAX_CHUNKS = 8192;
/** at most this much chunk data in a xorb (the specification's SHOULD, kept as a limit here) */
export const XORB_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A serialized xorb of `chunks`: an 8-byte header (version 0, compressed size, compression type,
 * uncompressed size) and the payload per chunk, ending right after the last chunk (no footer: the
 * specification forbids trailing bytes). LZ4 by default; a chunk LZ4 would not shrink is stored
 * uncompressed, as the specification advises.
 */
export function writeXorb(
  chunks: Uint8Array[],
  o: { compression?: "none" | "lz4" | "bg4-lz4" } = {},
): Uint8Array {
  if (chunks.length > XORB_MAX_CHUNKS)
    throw new Error(`xorb: ${chunks.length} chunks (at most ${XORB_MAX_CHUNKS})`);
  const data = chunks.reduce((n, c) => n + c.length, 0);
  if (data > XORB_MAX_BYTES) throw new Error(`xorb: ${data} bytes of chunks (at most 64 MiB)`);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const c of chunks) {
    if (c.length === 0) throw new Error("xorb: an empty chunk");
    if (c.length > XORB_MAX_CHUNK_SIZE)
      throw new Error(`xorb: a chunk of ${c.length} bytes (at most 128 KiB)`);
    let type: number = XorbCompression.None;
    let payload = c;
    if (o.compression !== "none") {
      const bg4 = o.compression === "bg4-lz4";
      const packed = lz4FrameEncode(bg4 ? bg4Split(c) : c);
      if (packed.length < c.length) {
        type = bg4 ? XorbCompression.ByteGrouping4LZ4 : XorbCompression.LZ4;
        payload = packed;
      }
    }
    const header = new Uint8Array(8);
    header[0] = 0;
    header[1] = payload.length & 0xff;
    header[2] = (payload.length >> 8) & 0xff;
    header[3] = (payload.length >> 16) & 0xff;
    header[4] = type;
    header[5] = c.length & 0xff;
    header[6] = (c.length >> 8) & 0xff;
    header[7] = (c.length >> 16) & 0xff;
    parts.push(header, payload);
    total += 8 + payload.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
