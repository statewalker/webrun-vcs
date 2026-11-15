/**
 * Pkt-lines read one at a time from a byte stream that may carry more than one response
 * (a duplex), or one response per request (smart HTTP).
 */

import { ChunkQueue, PacketLineError, ServerError } from "../protocol/index.js";

/** One pkt-line: a data line (with its text, newline removed), or a special packet. */
export type Pkt =
  | { type: "data"; data: Uint8Array; text: string }
  | { type: "flush" }
  | { type: "delim" }
  | { type: "end" };

const decoder = new TextDecoder();

/**
 * Reads pkt-lines from `source` as they arrive, never more than the packet being parsed.
 *
 * Unlike an `AsyncGenerator` over the stream, a `PktStream` can stop at a flush and be read
 * again later: a stateful connection (a duplex) carries the answer to every round, and the pack
 * after them, on one stream.
 *
 * @example
 * ```ts
 * const pkts = new PktStream(response.body);
 * for (let p = await pkts.read(); p && p.type !== "flush"; p = await pkts.read()) {
 *   if (p.type === "data") console.log(p.text);
 * }
 * ```
 */
export class PktStream {
  private readonly queue = new ChunkQueue();
  private readonly next: () => Promise<IteratorResult<Uint8Array>>;
  private readonly stop: () => Promise<unknown>;
  private ended = false;

  constructor(
    /**
     * A response body (read with a reader, so a cancel ends even a pending read) or any
     * async iterable of bytes (a duplex).
     */
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    /** Bounds each wait for the next chunk (a per-read timeout), when given */
    private readonly wait: <T>(next: () => Promise<T>) => Promise<T> = (next) => next(),
  ) {
    if (source instanceof ReadableStream) {
      const reader = source.getReader();
      this.next = () => reader.read() as Promise<IteratorResult<Uint8Array>>;
      this.stop = () => reader.cancel();
    } else {
      const iterator = source[Symbol.asyncIterator]();
      this.next = () => iterator.next();
      this.stop = async () => iterator.return?.();
    }
  }

  /** The next packet, or `undefined` at the end of the stream (between packets). */
  async read(): Promise<Pkt | undefined> {
    if (!(await this.fill(4))) {
      if (this.queue.length > 0) throw new PacketLineError("Incomplete packet at end of stream");
      return undefined;
    }
    const header = this.queue.peekHeader();
    if (header === "0000" || header === "0001" || header === "0002") {
      this.queue.take(4);
      return { type: header === "0000" ? "flush" : header === "0001" ? "delim" : "end" };
    }
    const length = /^[0-9a-fA-F]{4}$/.test(header) ? parseInt(header, 16) : Number.NaN;
    if (Number.isNaN(length) || length < 4) {
      throw new PacketLineError(`Invalid packet line header: ${header}`, header);
    }
    if (!(await this.fill(length))) throw new PacketLineError("Incomplete packet at end of stream");
    this.queue.take(4);
    const data = this.queue.take(length - 4);
    let text = decoder.decode(data);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return { type: "data", data, text };
  }

  /**
   * The next data line's text; `undefined` for a flush (or the end of the stream). A delimiter
   * or response-end packet, and an `ERR` line, throw.
   */
  async readLine(): Promise<string | undefined> {
    const p = await this.read();
    if (!p || p.type === "flush") return undefined;
    if (p.type !== "data") throw new PacketLineError(`Unexpected ${p.type} packet`);
    if (p.text.startsWith("ERR ")) throw new ServerError(p.text.slice(4));
    return p.text;
  }

  /** Stops reading the source (cancels a response body that was not read to its end). */
  async cancel(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.stop().catch(() => {});
  }

  private async fill(n: number): Promise<boolean> {
    while (this.queue.length < n) {
      if (this.ended) return false;
      const next = await this.wait(() => this.next());
      if (next.done) {
        this.ended = true;
        return false;
      }
      this.queue.push(next.value);
    }
    return true;
  }
}

/**
 * The pack of a side-band (side-band-64k, or protocol v2's packfile section) response: the
 * channel-1 payloads of the packets up to the flush that ends it, as they arrive. Channel 2
 * goes to `onProgress`, channel 3 throws a `ServerError`.
 */
export async function* readSidebandPack(
  pkts: PktStream,
  onProgress?: (message: string) => void,
): AsyncGenerator<Uint8Array> {
  while (true) {
    const p = await pkts.read();
    if (!p || p.type === "flush" || p.type === "end") return;
    if (p.type !== "data") throw new PacketLineError(`Unexpected ${p.type} packet in the pack`);
    const channel = p.data[0];
    const payload = p.data.subarray(1);
    if (channel === 1) {
      if (payload.length > 0) yield payload;
    } else if (channel === 2) {
      onProgress?.(decoder.decode(payload));
    } else if (channel === 3) {
      throw new ServerError(decoder.decode(payload).trim());
    } else if (p.text.startsWith("ERR ")) {
      throw new ServerError(p.text.slice(4));
    } else {
      throw new PacketLineError(`Unexpected line in the pack: ${p.text.slice(0, 60)}`);
    }
  }
}
