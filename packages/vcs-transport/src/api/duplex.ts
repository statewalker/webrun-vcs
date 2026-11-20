/**
 * Bidirectional byte stream interface for transport communication.
 *
 * This is the underlying transport channel abstraction that can be
 * implemented by WebSocket, MessagePort, HTTP streams, etc.
 *
 * @example MessagePort implementation
 * ```ts
 * function createMessagePortDuplex(port: MessagePort): Duplex {
 *   const queue: Uint8Array[] = [];
 *   let resolve: ((chunk: Uint8Array) => void) | null = null;
 *
 *   port.onmessage = (e) => {
 *     if (resolve) { resolve(e.data); resolve = null; }
 *     else queue.push(e.data);
 *   };
 *
 *   return {
 *     async *[Symbol.asyncIterator]() {
 *       while (true) {
 *         yield queue.length > 0
 *           ? queue.shift()!
 *           : await new Promise<Uint8Array>(r => { resolve = r; });
 *       }
 *     },
 *     write: (data) => port.postMessage(data),
 *   };
 * }
 * ```
 */
export interface Duplex {
  /**
   * Async iterator for reading data from the transport.
   * Yields chunks as they arrive.
   */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;

  /**
   * Writes data to the transport. A returned Promise is backpressure: the writer waits for it
   * before writing more (a stream whose reader lags, a socket whose buffer is full). A transport
   * without flow control returns nothing.
   * @param data - The bytes to send
   */
  write(data: Uint8Array): void | Promise<void>;

  /**
   * Ends the write side only (a half-close: a socket's FIN, a child's stdin closed), keeping
   * the read side open for the peer's answer. git half-closes where its peer waits for the end
   * of input: after a push's pack, after the final flush of a fetch. Optional: a transport
   * without it is simply not ended until {@link close}. A peer must keep answering after it
   * (a Node socket needs `allowHalfOpen: true` on both ends, or the FIN ends the answer too).
   */
  end?(): Promise<void>;

  /**
   * Closes the transport connection.
   * Optional - not all transports support explicit close.
   */
  close?(): Promise<void>;
}

/**
 * Half-closes a duplex where it can ({@link Duplex.end}); a transport without `end`, or one
 * whose other end is gone already, is left as it is.
 */
export async function endDuplex(duplex: Duplex): Promise<void> {
  try {
    await duplex.end?.();
  } catch {
    // the other end is gone already
  }
}
