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
   * Writes data to the transport.
   * @param data - The bytes to send
   */
  write(data: Uint8Array): void;

  /**
   * Closes the transport connection.
   * Optional - not all transports support explicit close.
   */
  close?(): Promise<void>;
}
