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
 * Concatenate multiple Uint8Arrays efficiently.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Parse a single packet from the beginning of a buffer.
 * Returns the packet and the remaining buffer, or null if incomplete.
 */
export function parsePacket(
  buffer: Uint8Array,
): { packet: Packet; remaining: Uint8Array<ArrayBuffer> } | null {
  if (buffer.length < 4) {
    return null; // Need more data for header
  }

  const lengthHex = textDecoder.decode(buffer.slice(0, 4));

  // Check for special packets
  if (lengthHex === PKT_FLUSH) {
    return {
      packet: { type: "flush" },
      remaining: new Uint8Array(buffer.subarray(4)),
    };
  }
  if (lengthHex === PKT_DELIM) {
    return {
      packet: { type: "delim" },
      remaining: new Uint8Array(buffer.subarray(4)),
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
      remaining: new Uint8Array(buffer.subarray(4)),
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
    remaining: new Uint8Array(buffer.subarray(length)),
  };
}

/**
 * Read packets from a byte stream.
 * Handles partial packets and buffering internally.
 */
export async function* pktLineReader(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Packet> {
  let buffer = new Uint8Array(0);

  for await (const chunk of stream) {
    // Append incoming chunk to buffer
    buffer = concatBytes(buffer, chunk);

    // Parse complete packets from buffer
    let result = parsePacket(buffer);
    while (result !== null) {
      yield result.packet;
      buffer = result.remaining;
      result = parsePacket(buffer);
    }
  }

  // Check for incomplete packet at end
  if (buffer.length > 0) {
    // Try to parse one more time in case buffer contains a complete packet
    const result = parsePacket(buffer);
    if (result !== null) {
      yield result.packet;
      buffer = result.remaining;
    }
    if (buffer.length > 0) {
      throw new PacketLineError(`Incomplete packet: ${buffer.length} bytes remaining`);
    }
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
