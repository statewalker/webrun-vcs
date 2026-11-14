/**
 * Pkt-line codec for git protocol framing.
 *
 * The pkt-line format is the foundation of git's wire protocol.
 * Each packet has a 4-byte hex length prefix followed by payload.
 * Special markers use reserved length values:
 * - 0000 = flush (end of message section)
 * - 0001 = delim (separator in protocol v2)
 * - 0002 = response end (protocol v2)
 *
 * Based on JGit's PacketLineIn.java and PacketLineOut.java
 */

import { MAX_PACKET_SIZE, MIN_PACKET_LENGTH, PKT_DELIM, PKT_END, PKT_FLUSH } from "./constants.js";

// Re-export for convenience
export { PKT_DELIM, PKT_END, PKT_FLUSH } from "./constants.js";

import { PacketLineError } from "./errors.js";
import type { Packet } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Check if a string represents the END marker.
 */
export function isEnd(s: string): boolean {
  return s === PKT_FLUSH;
}

/**
 * Check if a string represents the DELIM marker.
 */
export function isDelimiter(s: string): boolean {
  return s === PKT_DELIM;
}

/**
 * Encode a data packet with 4-byte hex length prefix.
 * Length includes the 4-byte prefix itself.
 */
export function encodePacket(data: Uint8Array | string): Uint8Array {
  const payload = typeof data === "string" ? textEncoder.encode(data) : data;

  const length = payload.length + 4;
  if (length > MAX_PACKET_SIZE) {
    throw new PacketLineError(`Packet too large: ${length} bytes (max ${MAX_PACKET_SIZE})`);
  }

  const header = length.toString(16).padStart(4, "0");
  const result = new Uint8Array(length);
  result.set(textEncoder.encode(header), 0);
  result.set(payload, 4);
  return result;
}

/**
 * Encode a string with trailing newline as a packet.
 */
export function encodePacketLine(line: string): Uint8Array {
  const withNewline = line.endsWith("\n") ? line : `${line}\n`;
  return encodePacket(withNewline);
}

/**
 * Encode a flush packet (0000).
 */
export function encodeFlush(): Uint8Array {
  return textEncoder.encode(PKT_FLUSH);
}

/**
 * Encode a delimiter packet (0001).
 */
export function encodeDelim(): Uint8Array {
  return textEncoder.encode(PKT_DELIM);
}

/**
 * Encode a response end packet (0002).
 */
export function encodeEnd(): Uint8Array {
  return textEncoder.encode(PKT_END);
}

/**
 * Create a pkt-line writer that yields encoded packets.
 * Suitable for building request streams.
 */
export async function* pktLineWriter(packets: AsyncIterable<Packet>): AsyncGenerator<Uint8Array> {
  for await (const packet of packets) {
    switch (packet.type) {
      case "flush":
        yield encodeFlush();
        break;
      case "delim":
        yield encodeDelim();
        break;
      case "end":
        yield encodeEnd();
        break;
      case "data":
        if (packet.data) {
          yield encodePacket(packet.data);
        }
        break;
    }
  }
}

/**
 * Parse a single packet from the beginning of a buffer.
 * Returns the packet and the remaining buffer, or null if incomplete.
 *
 * `remaining` is a view of `buffer` (not a copy), so parsing a buffer packet by
 * packet costs time linear in its length. A data packet's `data` is a copy.
 */
export function parsePacket<T extends ArrayBufferLike>(
  buffer: Uint8Array<T>,
): { packet: Packet; remaining: Uint8Array<T> } | null {
  if (buffer.length < 4) {
    return null; // Need more data for header
  }

  const lengthHex = textDecoder.decode(buffer.slice(0, 4));

  // Check for special packets
  if (lengthHex === PKT_FLUSH) {
    return {
      packet: { type: "flush" },
      remaining: buffer.subarray(4),
    };
  }
  if (lengthHex === PKT_DELIM) {
    return {
      packet: { type: "delim" },
      remaining: buffer.subarray(4),
    };
  }
  // Note: PKT_END (0002) is only used in protocol v2
  // In protocol v1, length 0002 is invalid

  // Parse data packet length
  const length = parseInt(lengthHex, 16);
  if (Number.isNaN(length)) {
    throw new PacketLineError(`Invalid packet line header: ${lengthHex}`, lengthHex);
  }

  // Length values 0001-0003 are invalid for data packets
  if (length > 0 && length < MIN_PACKET_LENGTH) {
    throw new PacketLineError(`Invalid packet line header: ${lengthHex}`, lengthHex);
  }

  // Empty data packet (length = 4)
  if (length === MIN_PACKET_LENGTH) {
    return {
      packet: { type: "data", data: new Uint8Array(0) },
      remaining: buffer.subarray(4),
    };
  }

  // Wait for complete packet
  if (buffer.length < length) {
    return null; // Need more data
  }

  // Extract packet data (excluding length prefix)
  const data = new Uint8Array(buffer.subarray(4, length));
  return {
    packet: { type: "data", data },
    remaining: buffer.subarray(length),
  };
}

/**
 * Bytes received but not yet parsed, kept as the chunks they arrived in.
 *
 * Reading from the front copies only the bytes taken, so a stream of many small
 * packets, or one large packet in many small chunks, is decoded in linear time.
 */
class ChunkQueue {
  private chunks: Uint8Array[] = [];
  /** Bytes of `chunks[0]` already consumed. */
  private offset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Copies of the first `n` bytes (n <= length), removed from the queue. */
  take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.chunks[0] as Uint8Array;
      const count = Math.min(n - at, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + count), at);
      at += count;
      this.offset += count;
      if (this.offset === head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.length -= n;
    return out;
  }

  /** The first four bytes as a string, without removing them (length >= 4). */
  peekHeader(): string {
    const head = this.chunks[0] as Uint8Array;
    if (head.length - this.offset >= 4) {
      return String.fromCharCode(...head.subarray(this.offset, this.offset + 4));
    }
    let s = "";
    let i = 0;
    let off = this.offset;
    while (s.length < 4) {
      const c = this.chunks[i] as Uint8Array;
      if (off >= c.length) {
        i++;
        off = 0;
        continue;
      }
      s += String.fromCharCode(c[off++] as number);
    }
    return s;
  }
}

/**
 * Read packets from a byte stream.
 * Handles partial packets and buffering internally.
 *
 * The bytes received are queued as chunks and parsed from the front, so the
 * reader works in time linear in the input however it is chunked.
 */
export async function* pktLineReader(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Packet> {
  const queue = new ChunkQueue();
  // Length of the data packet whose header has been read, or -1
  let pending = -1;

  for await (const chunk of stream) {
    queue.push(chunk);
    while (true) {
      if (pending < 0) {
        if (queue.length < 4) break;
        const lengthHex = queue.peekHeader();
        if (lengthHex === PKT_FLUSH) {
          queue.take(4);
          yield { type: "flush" };
          continue;
        }
        if (lengthHex === PKT_DELIM) {
          queue.take(4);
          yield { type: "delim" };
          continue;
        }
        const length = /^[0-9a-fA-F]{4}$/.test(lengthHex) ? parseInt(lengthHex, 16) : Number.NaN;
        if (Number.isNaN(length) || length < MIN_PACKET_LENGTH) {
          throw new PacketLineError(`Invalid packet line header: ${lengthHex}`, lengthHex);
        }
        queue.take(4);
        pending = length - 4;
      }
      if (queue.length < pending) break;
      const data = queue.take(pending);
      pending = -1;
      yield { type: "data", data };
    }
  }

  if (pending >= 0 || queue.length > 0) {
    const remaining = queue.length + (pending >= 0 ? 4 : 0);
    throw new PacketLineError(`Incomplete packet: ${remaining} bytes remaining`);
  }
}

/**
 * Read a single string from the packet stream.
 * Returns the string content (without trailing LF).
 */
export function packetDataToString(packet: Packet): string {
  if (packet.type === "flush") {
    return PKT_FLUSH;
  }
  if (packet.type === "delim") {
    return PKT_DELIM;
  }
  if (packet.type === "end") {
    return PKT_END;
  }
  if (!packet.data) {
    return "";
  }

  let str = textDecoder.decode(packet.data);
  // Strip trailing newline if present
  if (str.endsWith("\n")) {
    str = str.slice(0, -1);
  }
  return str;
}

/**
 * Read a single string from the packet stream (raw, no LF stripping).
 */
export function packetDataToStringRaw(packet: Packet): string {
  if (packet.type === "flush") {
    return PKT_FLUSH;
  }
  if (packet.type === "delim") {
    return PKT_DELIM;
  }
  if (packet.type === "end") {
    return PKT_END;
  }
  if (!packet.data) {
    return "";
  }

  return textDecoder.decode(packet.data);
}

/**
 * Create a data packet from a string.
 */
export function dataPacket(content: string): Packet {
  return { type: "data", data: textEncoder.encode(content) };
}

/**
 * Create a flush packet.
 */
export function flushPacket(): Packet {
  return { type: "flush" };
}

/**
 * Create a delimiter packet.
 */
export function delimPacket(): Packet {
  return { type: "delim" };
}

/**
 * Create an end packet.
 */
export function endPacket(): Packet {
  return { type: "end" };
}

/**
 * Collect all bytes from a packet stream.
 */
export async function collectPackets(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
