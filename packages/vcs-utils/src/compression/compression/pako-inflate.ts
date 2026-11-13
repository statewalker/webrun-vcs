/**
 * Partial decompression: inflate the stream at the start of a buffer and report
 * how many bytes it took, ignoring whatever follows (pack entries are
 * concatenated zlib streams with no length prefix).
 */
import { createInflater } from "./stream-inflater.js";
import type { PartialDecompressionResult, StreamingCompressionOptions } from "./types.js";

/**
 * Inflate the stream at the start of `data`.
 *
 * Throws `TruncatedStreamError` when `data` ends inside the stream and
 * `InflateError` when the stream is corrupt; never returns short data.
 */
export function decompressBlockPartialPako(
  data: Uint8Array,
  options?: StreamingCompressionOptions,
): PartialDecompressionResult {
  const inf = createInflater({ raw: options?.raw });
  const { out, done, consumed } = inf.push(data);
  if (!done) inf.end(); // throws TruncatedStreamError
  return { data: join(out), bytesRead: consumed };
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
