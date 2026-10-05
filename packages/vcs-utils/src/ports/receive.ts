/**
 * Transforms a sequence of received messages from a specified port
 * into an asynchronous iterator over iterators.
 *
 * Each returned value is an AsyncIterator providing access to individual series of
 * calls. This creates a stream of streams pattern, where each inner iterator
 * represents one logical sequence of messages.
 *
 * @template T - The type of values received.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to listen to.
 * @param options - Additional options for receiving messages (optional).
 * @returns An asynchronous generator that yields async iterators.
 */

import { type ListenPortOptions, listenPort } from "./listen-port.js";
import type { MessageHandler, MessageParams } from "./receive-iterator.js";
import { receiveIterator } from "./receive-iterator.js";

export async function* receive<T, E = Error>(
  port: MessagePort,
  options: ListenPortOptions = {},
): AsyncGenerator<AsyncGenerator<T, void, unknown>, void, unknown> {
  let onMessage: MessageHandler<T, E>;

  const close = listenPort<MessageParams<T, E>, void>(
    port,
    async ({ done, value, error }) => {
      await onMessage({ done, value, error });
    },
    options,
  );

  try {
    const interrupted = false;
    while (!interrupted) {
      yield receiveIterator<T, E>((p) => {
        onMessage = p;
      });
    }
  } finally {
    if (close) {
      close();
    }
  }
}
