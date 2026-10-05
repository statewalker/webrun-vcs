/**
 * Sends data from an async iterator to a specified port.
 *
 * Uses callPort to send each value from the async iterator to the remote side,
 * along with metadata indicating whether the stream is done or has an error.
 *
 * @template T - The type of values to send.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to send the data to.
 * @param output - The async iterator containing data to send.
 * @param options - Additional options for sending the data.
 * @returns A promise that resolves when all data has been sent.
 */

import { type CallPortOptions, callPort } from "./call-port.js";
import type { MessageParams } from "./receive-iterator.js";
import { sendIterator } from "./send-iterator.js";

export async function send<T, E = Error>(
  port: MessagePort,
  output: Iterable<T> | AsyncIterable<T>,
  options: CallPortOptions = {},
): Promise<void> {
  await sendIterator<T, E>(async ({ done, value, error }) => {
    await callPort<MessageParams<T, E>, void>(port, { done, value, error }, options);
  }, output);
}
