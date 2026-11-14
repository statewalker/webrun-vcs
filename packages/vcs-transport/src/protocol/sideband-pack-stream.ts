/**
 * The pack inside an upload-pack response, demultiplexed as it arrives.
 *
 * An upload-pack response (protocol v0/v1 with side-band-64k) is a series of pkt-lines:
 * shallow lines and ACK/NAK first, then sideband packets whose first byte is the channel
 * (1 pack data, 2 progress, 3 error), separated by flush packets. The pack is the
 * concatenation of the channel-1 payloads; only the packet being parsed is held.
 */
import { ServerError } from "./errors.js";

export interface SidebandPackOptions {
  /** Progress messages (channel 2), decoded as text. */
  onProgress?: (message: string) => void;
}

const textDecoder = new TextDecoder();

/**
 * Yields the pack bytes (sideband channel 1) of a response body as they arrive. Lines that are
 * not sideband packets (NAK, ACK, shallow, unshallow) and flush packets are skipped; channel 2
 * goes to `onProgress`; channel 3 and an `ERR <message>` pkt-line throw `ServerError`. A body ending inside a packet, or with a
 * malformed length, throws.
 *
 * @example
 * ```typescript
 * const response = await fetch(url, { method: "POST", body });
 * await importPack(objects, sidebandPackStream(response.body));
 * ```
 */
export async function* sidebandPackStream(
  body: AsyncIterable<Uint8Array>,
  options: SidebandPackOptions = {},
): AsyncGenerator<Uint8Array> {
  // Chunks are joined only once a whole packet (or a length) is available, so each byte is
  // copied at most once whatever the chunk sizes.
  let parts: Uint8Array[] = [];
  let have = 0;
  let need = 4;
  for await (const chunk of body) {
    parts.push(chunk);
    have += chunk.length;
    if (have < need) continue;
    const data = parts.length === 1 ? (parts[0] as Uint8Array) : join(parts, have);
    let off = 0;
    need = 4;
    while (data.length - off >= 4) {
      const lengthHex = String.fromCharCode(
        data[off] as number,
        data[off + 1] as number,
        data[off + 2] as number,
        data[off + 3] as number,
      );
      const length = /^[0-9a-f]{4}$/i.test(lengthHex) ? parseInt(lengthHex, 16) : Number.NaN;
      if (Number.isNaN(length) || (length > 0 && length < 4))
        throw new Error(`Invalid packet length: ${lengthHex}`);
      if (length === 0) {
        off += 4; // flush: the end of a section (shallow lines, the pack)
        continue;
      }
      if (data.length - off < length) {
        need = length; // the rest of this packet is in later chunks
        break;
      }
      const channel = data[off + 4];
      const payload = data.subarray(off + 5, off + length);
      off += length;
      if (length === 4) continue;
      if (channel === 1) {
        if (payload.length) yield payload;
      } else if (channel === 2) {
        options.onProgress?.(textDecoder.decode(payload));
      } else if (channel === 3) {
        throw new ServerError(textDecoder.decode(payload).trim());
      } else if (isErrLine(data, off - length, length)) {
        // `ERR <message>`: the server refuses the request (protocol v0/v1, outside the sideband)
        throw new ServerError(textDecoder.decode(data.subarray(off - length + 8, off)).trim());
      }
      // anything else is a protocol line before the pack (NAK, ACK, shallow): skipped
    }
    const rest = data.subarray(off);
    parts = rest.length ? [rest] : [];
    have = rest.length;
  }
  if (have) throw new Error("Incomplete packet at the end of the response");
}

/** Whether the pkt-line at `start` (of `length` bytes) is `ERR <message>`. */
function isErrLine(data: Uint8Array, start: number, length: number): boolean {
  return (
    length >= 8 &&
    data[start + 4] === 0x45 && // E
    data[start + 5] === 0x52 && // R
    data[start + 6] === 0x52 && // R
    data[start + 7] === 0x20 // space
  );
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
