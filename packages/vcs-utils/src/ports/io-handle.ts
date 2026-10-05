/**
 * Handles streams of data coming from the port, processes them with a handler function,
 * and sends back responses over the same port.
 *
 * This method yields the counter with the number of requests (iterators) handled.
 * It's used as the server part, receiving the request stream and replying to the caller.
 * Works in pair with the ioSend method.
 *
 * @template TInput - The type of input values.
 * @template TOutput - The type of output values.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to handle.
 * @param handler - The async generator handler function to process the input (an AsyncIterator);
 *                  generates the output values to send over the port.
 * @param options - The options for handling the input and output.
 * @returns An async generator that yields the counter value.
 */

import type { CallPortOptions } from "./call-port.js";
import { receive } from "./receive.js";
import { send } from "./send.js";

export async function* ioHandle<TInput, TOutput, E = Error>(
  port: MessagePort,
  handler: (
    input: AsyncGenerator<TInput, void, unknown>,
  ) => AsyncIterable<TOutput> | Promise<AsyncIterable<TOutput>>,
  options: CallPortOptions = {},
): AsyncGenerator<number, void, unknown> {
  let counter = 0;
  for await (const input of receive<TInput, E>(port, options)) {
    const output = await handler(input);
    await send<TOutput, E>(port, output, options);
    yield counter++;
  }
}
