/**
 * Sends values from an async iterator to a specified function.
 *
 * Iterates over all values in the async iterator and sends them using the provided send function.
 * When the iterator completes or throws an error, sends a final message with done=true.
 *
 * @template T - The type of values in the iterator.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param send - The function sending values to the remote handlers.
 * @param it - The async iterator to send values from.
 * @returns A promise that resolves when the iterator is fully consumed.
 */

import type { MessageParams } from "./receive-iterator.js";

export async function sendIterator<T, E = Error>(
  send: (params: MessageParams<T, E>) => Promise<void>,
  it: Iterable<T> | AsyncIterable<T>,
): Promise<void> {
  let error: E | undefined;
  try {
    for await (const value of it) {
      await send({ done: false, value });
    }
  } catch (err) {
    error = err as E;
  } finally {
    await send({ done: true, error });
  }
}
