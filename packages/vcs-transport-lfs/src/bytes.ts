import type { ByteStream } from "@statewalker/webrun-content-store";

/** Collect a byte stream into one contiguous buffer (whole-object transfer).
 * The buffer is a plain `ArrayBuffer`-backed `Uint8Array` so it is a valid
 * `BodyInit` for `Request`/`Response`. */
export async function collect(stream: ByteStream): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A single-shot byte stream over one buffer (streams are consumed once). */
export async function* streamOf(bytes: Uint8Array): ByteStream {
  yield bytes;
}
