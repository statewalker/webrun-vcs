/**
 * Asynchronous generator function that receives messages and yields message values to the caller.
 *
 * Uses newAsyncGenerator to create an async generator that handles incoming messages.
 * The onMessage callback receives a function to push messages into the generator.
 *
 * @template T - The type of values yielded by the generator.
 * @template E - The type of errors that can be thrown (defaults to Error).
 * @param onMessage - The callback function to handle incoming messages.
 * @returns An asynchronous generator that yields received values.
 */

import { newAsyncGenerator } from "../streams/new-async-generator.js";

export interface MessageParams<T, E = Error> {
  done?: boolean;
  value?: T;
  error?: E;
}

export type MessageHandler<T, E = Error> = (params?: MessageParams<T, E>) => Promise<void>;

export async function* receiveIterator<T, E = Error>(
  onMessage: (send: MessageHandler<T, E>) => void | (() => void | Promise<void>),
): AsyncGenerator<T, void, unknown> {
  let next: (value: T) => Promise<boolean>;
  let end: (error?: E) => Promise<boolean>;

  const cleanup = onMessage(async ({ done = true, value, error } = {}) => {
    if (error) {
      await end(error);
    } else if (done) {
      await end();
    } else if (value !== undefined) {
      await next(value);
    }
  });

  yield* newAsyncGenerator<T, E>((n, e) => {
    next = n;
    end = e;
    return cleanup;
  });
}
