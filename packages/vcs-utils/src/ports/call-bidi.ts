/**
 * Calls the peer handler over a port with a stream of input values
 * and returns the stream of resulting values.
 *
 * This method internally creates a new channel and sends it to the peer
 * with other parameters. The peer starts to read the input stream and
 * sends results over this channel.
 *
 * @template TInput - The type of output values to send (becomes input for the peer).
 * @template TOutput - The type of input values to receive (becomes output from the peer).
 * @template TParams - The type of additional parameters.
 * @template E - The type of errors that can occur (defaults to Error).
 * @param port - The MessagePort to call.
 * @param input - The input stream to send to the peer.
 * @param args - The arguments object containing call parameters.
 * @param args.options - The call options for the port call.
 * @param args.options.bidiTimeout - The timeout of the stream to receive;
 *                                     by default it is 2147483647 (max integer).
 * @param args.options.timeout - The timeout of individual calls used to send each individual stream value.
 * @param args.params - Additional call parameters used by peers to handle calls;
 *                       it could contain parameters like method name;
 *                       the peer side will receive in parameters the generated channelName value.
 * @returns An async generator that yields the output of the port call.
 */

import type { CallPortOptions } from "./call-port.js";
import { callPort } from "./call-port.js";
import { ioSend } from "./io-send.js";

export interface CallBidiOptions extends CallPortOptions {
  /** The timeout of the stream to receive; by default it is 2147483647 (max integer). */
  bidiTimeout?: number;
}

export interface CallBidiParams<TParams = Record<string, unknown>> {
  /** Call options including timeouts and channel name. */
  options?: CallBidiOptions;
  /** Additional parameters to pass to the peer handler. */
  params?: TParams;
}

export async function* callBidi<TInput, TOutput, TParams = Record<string, unknown>, E = Error>(
  port: MessagePort,
  input: Iterable<TInput> | AsyncIterable<TInput>,
  { options = {}, ...params }: CallBidiParams<TParams> & TParams = {} as CallBidiParams<TParams> &
    TParams,
): AsyncGenerator<TOutput, void, unknown> {
  const channelName = String(Number(String(Math.random()).substring(2)));
  const { bidiTimeout = 2147483647, ...restOptions } = options;

  const promise = callPort<TParams & { channelName: string }, void>(
    port,
    { ...params, channelName } as TParams & { channelName: string },
    { ...restOptions, timeout: bidiTimeout },
  );

  try {
    yield* ioSend<TOutput, TInput, E>(port, input, {
      ...restOptions,
      channelName,
    });
  } finally {
    await promise;
  }
}
