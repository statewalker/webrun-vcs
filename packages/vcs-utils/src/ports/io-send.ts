/**
 * Sends the given output values to the port and yields asynchronously
 * the response from the other side.
 *
 * This method is used as the client part, sending requests to the server.
 * Works in pair with the ioHandle method.
 *
 * @template TInput - The type of input values received.
 * @template TOutput - The type of output values to send.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to receive data from and send data to.
 * @param output - The output values to send to the port.
 * @param options - Additional options for sending data.
 * @returns An async generator returning the received values.
 */

import type { CallPortOptions } from "./call-port.js";
import { receive } from "./receive.js";
import { send } from "./send.js";

export async function* ioSend<TInput, TOutput, E = Error>(
  port: MessagePort,
  output: Iterable<TOutput> | AsyncIterable<TOutput>,
  options: CallPortOptions = {},
): AsyncGenerator<TInput, void, unknown> {
  for await (const input of receive<TInput, E>(port, options)) {
    const promise = send<TOutput, E>(port, output, options);
    try {
      yield* input;
    } finally {
      await promise;
    }
    break;
  }
}
