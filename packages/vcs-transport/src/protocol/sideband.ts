/**
 * Sideband multiplexing for git protocol.
 *
 * The sideband protocol allows the server to send multiple streams
 * over a single connection by prefixing each packet with a channel byte:
 * - Channel 1: Pack data
 * - Channel 2: Progress messages
 * - Channel 3: Error messages
 *
 * Based on JGit's SideBandInputStream.java and SideBandOutputStream.java
 */

import {
  SIDEBAND_DATA,
  SIDEBAND_ERROR,
  SIDEBAND_HDR_SIZE,
  SIDEBAND_MAX_BUF,
  SIDEBAND_PROGRESS,
} from "./constants.js";

// Re-export for convenience
export {
  SIDEBAND_DATA,
  SIDEBAND_ERROR,
  SIDEBAND_HDR_SIZE,
  SIDEBAND_MAX_BUF,
  SIDEBAND_PROGRESS,
  SIDEBAND_SMALL_BUF,
} from "./constants.js";

import { ServerError } from "./errors.js";
import type { Packet, SidebandMessage } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Demultiplex sideband-encoded packets into channel-specific messages.
 *
 * The sideband format wraps pkt-line data with a single channel byte:
 * [pkt-length][channel-byte][payload]
 *
 * Stops on flush packet (end of response).
 * Throws ServerError if channel 3 (error) is received.
 */
export async function* demuxSideband(
  packets: AsyncIterable<Packet>,
): AsyncGenerator<SidebandMessage> {
  for await (const packet of packets) {
    // Stop on flush packet - this signals end of response
    if (packet.type === "flush") {
      return;
    }

    if (packet.type !== "data" || !packet.data || packet.data.length === 0) {
      continue;
    }

    const channel = packet.data[0];
    const payload = packet.data.slice(1);

    if (channel === SIDEBAND_ERROR) {
      const message = textDecoder.decode(payload).trim();
      throw new ServerError(message);
    }

    yield { channel, data: payload };
  }
}

/**
 * Extract only pack data from sideband stream.
 * Progress messages are optionally reported via callback.
 */
export async function* extractPackData(
  sideband: AsyncIterable<SidebandMessage>,
  onProgress?: (message: string) => void,
): AsyncGenerator<Uint8Array> {
  for await (const msg of sideband) {
    if (msg.channel === SIDEBAND_DATA) {
      yield msg.data;
    } else if (msg.channel === SIDEBAND_PROGRESS && onProgress) {
      onProgress(textDecoder.decode(msg.data));
    }
  }
}

/**
 * Encode data as a sideband packet for the given channel.
 */
export function encodeSidebandPacket(channel: number, data: Uint8Array): Uint8Array {
  if (channel < 1 || channel > 255) {
    throw new Error(`channel ${channel} must be in range [1, 255]`);
  }
  if (data.length + SIDEBAND_HDR_SIZE > SIDEBAND_MAX_BUF) {
    throw new Error(
      `packet size ${data.length + SIDEBAND_HDR_SIZE} must be <= ${SIDEBAND_MAX_BUF}`,
    );
  }

  const length = data.length + SIDEBAND_HDR_SIZE;
  const header = length.toString(16).padStart(4, "0");

  const result = new Uint8Array(length);
  result.set(textEncoder.encode(header), 0);
  result[4] = channel;
  result.set(data, 5);
  return result;
}

/**
 * Options for SideBandOutputStream.
 */
export interface SideBandOutputOptions {
  channel: number;
  maxBuf?: number;
}

/**
 * Sideband output stream that multiplexes data onto a channel.
 *
 * This class buffers writes and emits properly formatted sideband packets.
 */
export class SideBandOutputStream {
  private channel: number;
  private maxBuf: number;
  private buffer: Uint8Array;
  private position: number;
  private output: Uint8Array[];

  constructor(options: SideBandOutputOptions) {
    const { channel, maxBuf = SIDEBAND_MAX_BUF } = options;

    if (channel < 1 || channel > 255) {
      throw new Error(`channel ${channel} must be in range [1, 255]`);
    }
    if (maxBuf < SIDEBAND_HDR_SIZE) {
      throw new Error(`packet size ${maxBuf} must be >= ${SIDEBAND_HDR_SIZE}`);
    }
    if (maxBuf > SIDEBAND_MAX_BUF) {
      throw new Error(`packet size ${maxBuf} must be at most ${SIDEBAND_MAX_BUF}`);
    }

    this.channel = channel;
    this.maxBuf = maxBuf;
    this.buffer = new Uint8Array(maxBuf);
    this.position = SIDEBAND_HDR_SIZE;
    this.output = [];

    // Pre-fill channel byte
    this.buffer[4] = channel;
  }

  /**
   * Write a single byte.
   */
  writeByte(b: number): void {
    if (this.position >= this.maxBuf) {
      this.flushBuffer();
    }
    this.buffer[this.position++] = b;
  }

  /**
   * Write bytes from an array.
   */
  write(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.position >= this.maxBuf) {
        this.flushBuffer();
      }
      const available = this.maxBuf - this.position;
      const toCopy = Math.min(available, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + toCopy), this.position);
      this.position += toCopy;
      offset += toCopy;
    }
  }

  /**
   * Flush the internal buffer to output.
   */
  flush(): void {
    this.flushBuffer();
  }

  /**
   * Get all output packets.
   */
  getOutput(): Uint8Array[] {
    return this.output;
  }

  private flushBuffer(): void {
    if (this.position <= SIDEBAND_HDR_SIZE) {
      return; // Nothing to flush
    }

    // Write length header
    const length = this.position;
    const header = length.toString(16).padStart(4, "0");
    this.buffer.set(textEncoder.encode(header), 0);

    // Copy to output
    this.output.push(this.buffer.slice(0, length));

    // Reset buffer
    this.position = SIDEBAND_HDR_SIZE;
    this.buffer[4] = this.channel;
  }
}

/**
 * Parse progress messages from sideband channel 2.
 *
 * Progress messages accumulate until a line terminator (CR or LF) is seen.
 * This matches JGit's SideBandInputStream behavior.
 */
export class SideBandProgressParser {
  private buffer = "";
  private messages: string[] = [];

  /**
   * Feed data from channel 2 into the parser.
   */
  feed(data: Uint8Array): void {
    const text = textDecoder.decode(data);
    this.buffer += text;

    // Extract complete lines
    let lastTerminator = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === "\r" || ch === "\n") {
        lastTerminator = i;
      }
    }

    if (lastTerminator >= 0) {
      const complete = this.buffer.slice(0, lastTerminator + 1);
      this.buffer = this.buffer.slice(lastTerminator + 1);
      this.messages.push(complete);
    }
  }

  /**
   * Drain any remaining partial message.
   */
  drain(): void {
    if (this.buffer.length > 0) {
      this.messages.push(`${this.buffer}\n`);
      this.buffer = "";
    }
  }

  /**
   * Get and clear accumulated messages.
   */
  getMessages(): string[] {
    const msgs = this.messages;
    this.messages = [];
    return msgs;
  }

  /**
   * Get the current partial buffer content.
   */
  getPartial(): string {
    return this.buffer;
  }
}
