/**
 * Listens for incoming requests and delegates calls to the given method
 * to handle input streams. The resulting stream of values returned by
 * the handler method is returned to the caller over the same port.
 *
 * This method is used as the server part, receiving and handling
 * requests sent by the callBidi method.
 *
 * @template TInput - The type of input values received.
 * @template TOutput - The type of output values to send back.
 * @template TParams - The type of additional parameters.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to listen on.
 * @param action - The async generator instance receiving
 *                 an AsyncIterator with input values and yielding a stream of results
 *                 returned to the caller.
 * @param accept - The function allowing to accept/reject
 *                 the initial call based on received parameters.
 * @returns A callback method allowing to remove the registered call handler.
 */

import { ioHandle } from "./io-handle.js";
import { listenPort } from "./listen-port.js";

export type BidiParams<TParams = Record<string, unknown>> = TParams & {
  channelName?: string;
};

export type BidiAcceptor<TParams = Record<string, unknown>> = (
  params: BidiParams<TParams>,
) => boolean;

export function listenBidi<TInput, TOutput, TParams = Record<string, unknown>, E = Error>(
  port: MessagePort,
  action: (
    input: AsyncGenerator<TInput, void, unknown>,
    params: BidiParams<TParams>,
  ) => AsyncIterable<TOutput> | Promise<AsyncIterable<TOutput>>,
  accept: BidiAcceptor<TParams> = () => true,
): () => void {
  return listenPort<BidiParams<TParams>, void>(port, async (params) => {
    if (!params.channelName) return;
    if (!accept(params)) return;

    for await (const _idx of ioHandle<TInput, TOutput, E>(
      port,
      (input) => action(input, params),
      params,
    )) {
      // Process only the first iteration, then break
      break;
    }
  });
}
