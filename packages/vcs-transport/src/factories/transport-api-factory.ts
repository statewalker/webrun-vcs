/**
 * Factory for creating TransportApi from a Duplex stream.
 *
 * The TransportApi provides the Git wire protocol abstraction layer:
 * - Pkt-line framing (reading and writing)
 * - Sideband multiplexing (channels 1-3)
 * - Pack streaming
 */

import type { Duplex } from "../api/duplex.js";
import type { PktLineResult, SidebandResult, TransportApi } from "../api/transport-api.js";
import type { ProtocolState } from "../context/protocol-state.js";
import { ChunkQueue } from "../protocol/chunk-queue.js";
import { MIN_PACKET_LENGTH, PKT_DELIM, PKT_END, PKT_FLUSH } from "../protocol/constants.js";
import { PacketLineError } from "../protocol/errors.js";
import {
  encodeDelim,
  encodeFlush,
  encodePacket,
  encodePacketLine,
} from "../protocol/pkt-line-codec.js";
import {
  encodeSidebandPacket,
  SIDEBAND_DATA,
  SIDEBAND_HDR_SIZE,
  SIDEBAND_MAX_BUF,
} from "../protocol/sideband.js";
import { readPackFromStream } from "../utils/pack-stream-reader.js";

const _textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Internal pkt-line reader with buffering support.
 *
 * Received bytes wait in a chunk queue and are copied once, when a packet is
 * taken, so a packet arriving in many small chunks is read in linear time.
 */
class PktLineReader {
  private queue = new ChunkQueue();
  private iterator: AsyncIterator<Uint8Array>;
  private done = false;

  constructor(duplex: Duplex) {
    this.iterator = duplex[Symbol.asyncIterator]();
  }

  /**
   * Reads the next pkt-line from the stream.
   */
  async read(): Promise<PktLineResult> {
    while (true) {
      const packet = this.parse();
      if (packet) return packet;
      if (this.done) return { type: "eof" };
      const { value, done } = await this.iterator.next();
      if (done) this.done = true;
      else this.queue.push(value);
    }
  }

  /** The next complete packet in the queue, or null when more bytes are needed. */
  private parse(): PktLineResult | null {
    const queue = this.queue;
    if (queue.length < 4) return null;
    const header = queue.peekHeader();
    if (header === PKT_FLUSH) {
      queue.take(4);
      return { type: "flush" };
    }
    if (header === PKT_DELIM) {
      queue.take(4);
      return { type: "delim" };
    }
    if (header === PKT_END) {
      // Only stateless protocol-v2 exchanges (over HTTP) end a response with 0002;
      // none of the exchanges driven through TransportApi does.
      queue.take(4);
      throw new PacketLineError(
        "Unexpected response-end packet (0002): not part of this exchange",
        header,
      );
    }
    const length = /^[0-9a-fA-F]{4}$/.test(header) ? Number.parseInt(header, 16) : Number.NaN;
    if (Number.isNaN(length) || length < MIN_PACKET_LENGTH) {
      throw new PacketLineError(`Invalid packet line header: ${header}`, header);
    }
    if (queue.length < length) return null;
    queue.take(4);
    const payload = queue.take(length - 4);
    let text = textDecoder.decode(payload);
    // Strip trailing newline
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return { type: "data", payload, text };
  }

  /**
   * Drains any remaining buffered data and returns it.
   * Used when switching from pkt-line mode to raw binary mode.
   */
  drainBuffer(): Uint8Array {
    return this.queue.drain();
  }

  /**
   * Creates a raw byte stream using this reader's own buffer and iterator.
   * Avoids creating a second duplex iterator that could compete for data.
   *
   * Returns a restore function to put leftover bytes back into the buffer
   * after the raw stream consumer finishes.
   */
  createRawStream(): {
    stream: AsyncIterable<Uint8Array>;
    restore: (leftover: Uint8Array) => void;
  } {
    const drained = this.drainBuffer();
    const iter = this.iterator;

    async function* raw(): AsyncGenerator<Uint8Array> {
      if (drained.length > 0) yield drained;
      while (true) {
        const { value, done } = await iter.next();
        if (done) break;
        yield value;
      }
    }

    return {
      stream: raw(),
      restore: (leftover: Uint8Array) => {
        // Prepend leftover before any existing buffer content
        this.queue.unshift(leftover);
      },
    };
  }

  /**
   * Reads a sideband-encoded packet.
   * Extracts the channel byte and payload from pkt-line data.
   */
  async readSideband(): Promise<SidebandResult> {
    const pkt = await this.read();

    if (pkt.type !== "data") {
      throw new Error(`Expected data packet for sideband, got ${pkt.type}`);
    }

    if (pkt.payload.length < 1) {
      throw new Error("Sideband packet too short");
    }

    const channel = pkt.payload[0] as 1 | 2 | 3;
    const data = pkt.payload.slice(1);

    return { channel, data };
  }
}

/**
 * Internal pkt-line writer.
 */
class PktLineWriter {
  constructor(private duplex: Duplex) {}

  /**
   * Writes a pkt-line with proper framing. Each write waits for the duplex (backpressure).
   */
  async write(data: string | Uint8Array): Promise<void> {
    const encoded = typeof data === "string" ? encodePacketLine(data) : encodePacket(data);
    await this.duplex.write(encoded);
  }

  /**
   * Writes a flush packet (0000).
   */
  async flush(): Promise<void> {
    await this.duplex.write(encodeFlush());
  }

  /**
   * Writes a delimiter packet (0001).
   */
  async delimiter(): Promise<void> {
    await this.duplex.write(encodeDelim());
  }

  /**
   * Writes data on a sideband channel.
   * Automatically chunks data that exceeds the pkt-line size limit.
   */
  async writeSideband(channel: 1 | 2 | 3, data: Uint8Array): Promise<void> {
    const maxPayload = SIDEBAND_MAX_BUF - SIDEBAND_HDR_SIZE;
    let offset = 0;
    while (offset < data.length) {
      const end = Math.min(offset + maxPayload, data.length);
      const chunk = data.subarray(offset, end);
      await this.duplex.write(encodeSidebandPacket(channel, chunk));
      offset = end;
    }
  }
}

/**
 * Creates a TransportApi from a Duplex stream and protocol state.
 *
 * The protocol state is used to check capabilities for sideband handling
 * in readPack/writePack operations.
 *
 * @param duplex - Bidirectional byte stream
 * @param state - Protocol state for capability checks
 * @returns TransportApi implementation
 *
 * @example
 * ```ts
 * const state = new ProtocolState();
 * const transport = createTransportApi(duplex, state);
 *
 * // Read server advertisement
 * const pkt = await transport.readPktLine();
 * if (pkt.type === "data") {
 *   console.log("Received:", pkt.text);
 * }
 *
 * // Send wants
 * await transport.writeLine("want abc123 multi_ack_detailed");
 * await transport.writeFlush();
 * ```
 */
export function createTransportApi(duplex: Duplex, state: ProtocolState): TransportApi {
  const reader = new PktLineReader(duplex);
  const writer = new PktLineWriter(duplex);

  return {
    // Pkt-line level
    readPktLine: () => reader.read(),
    writePktLine: (data) => writer.write(data),
    writeFlush: () => writer.flush(),
    writeDelimiter: () => writer.delimiter(),

    // Line level convenience
    readLine: async () => {
      const pkt = await reader.read();
      return pkt.type === "data" ? pkt.text : null;
    },
    writeLine: (line) => writer.write(line.endsWith("\n") ? line : `${line}\n`),

    // Sideband I/O
    readSideband: () => reader.readSideband(),
    writeSideband: (channel, data) => writer.writeSideband(channel, data),

    // Pack streaming
    async *readPack(): AsyncGenerator<Uint8Array> {
      if (state.hasCapability("side-band-64k")) {
        // Read pack data from sideband channel 1
        while (true) {
          const pkt = await reader.read();
          if (pkt.type === "flush" || pkt.type === "eof") {
            break;
          }
          if (pkt.type === "data" && pkt.payload.length > 0) {
            const channel = pkt.payload[0];
            if (channel === SIDEBAND_DATA) {
              // an empty band-1 packet is the server's keep-alive
              if (pkt.payload.length > 1) yield pkt.payload.slice(1);
            } else if (channel === 3) {
              // Error channel
              const errorMsg = textDecoder.decode(pkt.payload.slice(1));
              throw new Error(`Server error: ${errorMsg}`);
            }
            // Channel 2 is progress - ignored
          }
        }
      } else {
        // Raw pack data - yield remaining buffered data first, then stream
        const remaining = reader.drainBuffer();
        if (remaining.length > 0) {
          yield remaining;
        }
        const iter = duplex[Symbol.asyncIterator]();
        while (true) {
          const { value, done } = await iter.next();
          if (done) break;
          yield value;
        }
      }
    },

    // Raw pack streaming (bypasses sideband, always reads raw bytes).
    // Parses the pack header and object boundaries to read exactly one
    // complete pack, then stops — preventing deadlock when the duplex
    // is shared with subsequent protocol exchanges (e.g., push report-status).
    async *readRawPack(): AsyncGenerator<Uint8Array> {
      // Use the reader's own buffer and iterator to avoid creating a
      // competing duplex iterator that could consume report-status data.
      const { stream, restore } = reader.createRawStream();
      const leftover: Uint8Array = yield* readPackFromStream(stream);
      // Put any unconsumed bytes back so the PktLineReader can use them
      // for subsequent reads (e.g., report-status after pack).
      restore(leftover);
    },

    async writePack(packStream: AsyncIterable<Uint8Array>): Promise<void> {
      if (state.hasCapability("side-band-64k")) {
        // Write pack data on sideband channel 1
        for await (const chunk of packStream) {
          await writer.writeSideband(1, chunk);
        }
        await writer.flush();
      } else {
        // Write raw pack data
        for await (const chunk of packStream) {
          await duplex.write(chunk);
        }
      }
    },

    async writeRawPack(packStream: AsyncIterable<Uint8Array>): Promise<void> {
      // Write raw pack data bypassing sideband.
      // Used by push clients where sideband is server→client only.
      for await (const chunk of packStream) {
        await duplex.write(chunk);
      }
    },

    // Connection lifecycle
    async close(): Promise<void> {
      if (duplex.close) {
        await duplex.close();
      }
    },
  };
}
