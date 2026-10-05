/**
 * HTTP-based Duplex implementation.
 *
 * Creates a bidirectional byte stream from HTTP request/response.
 * Used for Git smart HTTP protocol where request body is input
 * and response body is output.
 */

import type { Duplex } from "../../api/duplex.js";

/**
 * Options for creating a simple duplex.
 */
export interface SimpleDuplexOptions {
  /** Optional callback when close() is called */
  onClose?: () => void | Promise<void>;
}

/**
 * Creates a Duplex from an async iterable input and a writer function.
 *
 * This is the basic building block for HTTP duplexes, where:
 * - Input comes from request body (client) or response body (server)
 * - Output goes to response body (server) or is collected (client)
 *
 * @param input - Async iterable of incoming chunks
 * @param writer - Function to write outgoing chunks
 * @returns Duplex interface
 */
export function createSimpleDuplex(
  input: AsyncIterable<Uint8Array>,
  writer: (data: Uint8Array) => void,
): Duplex {
  return {
    [Symbol.asyncIterator]: () => input[Symbol.asyncIterator](),
    write: writer,
  };
}

/**
 * HTTP request body adapter.
 *
 * Wraps a ReadableStream (from fetch Response) as an async iterable.
 */
export async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collects all chunks from an async iterable into a single Uint8Array.
 */
export async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of chunks) {
    parts.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Buffer writer that collects all writes into an array.
 *
 * Used for HTTP client to collect response data.
 */
export class BufferWriter {
  private chunks: Uint8Array[] = [];

  write(data: Uint8Array): void {
    this.chunks.push(data);
  }

  getChunks(): Uint8Array[] {
    return this.chunks;
  }

  async toUint8Array(): Promise<Uint8Array> {
    return collectChunks(this.iterate());
  }

  async *iterate(): AsyncIterable<Uint8Array> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

/**
 * Creates a Duplex for an HTTP client request.
 *
 * The client writes request body data, then reads response body data.
 * Since HTTP is half-duplex, we collect all writes first, send the request,
 * then return the response as the readable side.
 *
 * @param sendRequest - Function that sends HTTP request and returns response body
 * @returns Object with duplex for writing and getResponse for reading after send
 */
/**
 * Result of decoding a sideband-encoded HTTP response.
 */
export interface SidebandDecodedResponse {
  /** Pack data from sideband channel 1 */
  packData: Uint8Array;
  /** Progress messages from sideband channel 2 */
  progressMessages: string[];
  /** Error message from sideband channel 3 (if any) */
  error?: string;
}

const textDecoder = new TextDecoder();

/**
 * Decodes a sideband-encoded HTTP response buffer.
 *
 * Parses pkt-lines from a buffered response, separating sideband channels:
 * - Channel 1: pack data
 * - Channel 2: progress messages
 * - Channel 3: error messages
 *
 * Non-sideband pkt-lines (NAK, ACK, shallow, unshallow) are skipped.
 *
 * @param data - Buffered response bytes
 * @returns Decoded response with pack data, progress, and errors
 */
export function decodeSidebandResponse(data: Uint8Array): SidebandDecodedResponse {
  const packChunks: Uint8Array[] = [];
  const progressMessages: string[] = [];
  let error: string | undefined;
  let offset = 0;

  while (offset < data.length) {
    // Need at least 4 bytes for length prefix
    if (offset + 4 > data.length) break;

    const lengthHex = textDecoder.decode(data.slice(offset, offset + 4));

    // Flush packet
    if (lengthHex === "0000") {
      offset += 4;
      break;
    }

    const length = parseInt(lengthHex, 16);
    if (Number.isNaN(length) || length < 4) break;
    if (offset + length > data.length) break;

    const payload = data.slice(offset + 4, offset + length);
    offset += length;

    if (payload.length === 0) continue;

    // Check if this is a sideband packet (first byte is channel)
    const firstByte = payload[0];
    if (firstByte === 1 || firstByte === 2 || firstByte === 3) {
      const channelData = payload.slice(1);
      if (firstByte === 1) {
        packChunks.push(channelData);
      } else if (firstByte === 2) {
        progressMessages.push(textDecoder.decode(channelData));
      } else {
        error = textDecoder.decode(channelData);
      }
    }
    // Non-sideband lines (NAK, ACK, shallow, unshallow) are skipped
  }

  // Concatenate pack chunks
  const totalLength = packChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const packData = new Uint8Array(totalLength);
  let packOffset = 0;
  for (const chunk of packChunks) {
    packData.set(chunk, packOffset);
    packOffset += chunk.length;
  }

  return { packData, progressMessages, error };
}

export function createHttpClientDuplex(
  sendRequest: (body: Uint8Array) => Promise<ReadableStream<Uint8Array>>,
): {
  writer: BufferWriter;
  sendAndGetReadable: () => Promise<AsyncIterable<Uint8Array>>;
} {
  const writer = new BufferWriter();

  return {
    writer,
    async sendAndGetReadable(): Promise<AsyncIterable<Uint8Array>> {
      const body = await writer.toUint8Array();
      const responseStream = await sendRequest(body);
      return readableStreamToAsyncIterable(responseStream);
    },
  };
}
