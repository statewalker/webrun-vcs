/**
 * MessagePort-based Duplex implementation.
 *
 * Creates a bidirectional byte stream from a MessagePort.
 * Useful for in-browser client-server communication via
 * Web Workers, SharedWorkers, or window.postMessage.
 */

import type { Duplex } from "../../api/duplex.js";

/**
 * Creates a Duplex stream from a MessagePort.
 *
 * The MessagePort is expected to transfer Uint8Array messages.
 * Incoming messages are queued and yielded via the async iterator.
 *
 * @param port - MessagePort to wrap
 * @returns Duplex stream interface
 *
 * @example
 * ```ts
 * // Create a channel for local client-server communication
 * const channel = new MessageChannel();
 *
 * // Client side
 * const clientDuplex = createMessagePortDuplex(channel.port1);
 *
 * // Server side
 * const serverDuplex = createMessagePortDuplex(channel.port2);
 *
 * // Write from client
 * clientDuplex.write(new Uint8Array([1, 2, 3]));
 *
 * // Read on server
 * for await (const chunk of serverDuplex) {
 *   console.log("Received:", chunk);
 * }
 * ```
 */
export function createMessagePortDuplex(port: MessagePort): Duplex {
  const receiveQueue: Uint8Array[] = [];
  let resolveNext: ((chunk: Uint8Array) => void) | null = null;
  let closed = false;

  // Listen for incoming messages
  port.onmessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle close signal
    if (data === null || data === "__close__") {
      closed = true;
      if (resolveNext) {
        // Signal end by resolving with empty array - will be handled in iterator
        resolveNext(new Uint8Array(0));
        resolveNext = null;
      }
      return;
    }

    // Ensure we have a Uint8Array
    const chunk =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(0);

    if (resolveNext) {
      resolveNext(chunk);
      resolveNext = null;
    } else {
      receiveQueue.push(chunk);
    }
  };

  // Handle errors
  port.onmessageerror = (event: MessageEvent) => {
    console.error("MessagePort error:", event);
    closed = true;
    if (resolveNext) {
      resolveNext(new Uint8Array(0));
      resolveNext = null;
    }
  };

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      while (!closed) {
        if (receiveQueue.length > 0) {
          const chunk = receiveQueue.shift();
          if (chunk && chunk.length > 0) {
            yield chunk;
          }
        } else {
          // Wait for next message
          const chunk = await new Promise<Uint8Array>((resolve) => {
            resolveNext = resolve;
          });

          // Check for close signal (empty chunk)
          if (chunk.length === 0 && closed) {
            return;
          }

          if (chunk.length > 0) {
            yield chunk;
          }
        }
      }

      // Drain any remaining queued messages
      while (receiveQueue.length > 0) {
        const chunk = receiveQueue.shift();
        if (chunk && chunk.length > 0) {
          yield chunk;
        }
      }
    },

    write(data: Uint8Array): void {
      if (!closed) {
        port.postMessage(data);
      }
    },

    async close(): Promise<void> {
      if (!closed) {
        port.postMessage("__close__");
      }
    },
  };
}
