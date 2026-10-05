/**
 * Listen to a specific port and handle incoming RPC calls.
 *
 * Implements the server side of the request/response pattern
 * in conjunction with the `callPort` function.
 */

import { type SerializedError, serializeError } from "./errors.js";

/**
 * Message structure for incoming requests.
 */
interface RequestMessage {
  type: "request";
  channelName: string;
  callId: string;
  params: unknown;
}

/**
 * Message structure for outgoing responses.
 */
interface ResponseMessage {
  type: "response:result" | "response:error";
  channelName: string;
  callId: string;
  result?: unknown;
  error?: SerializedError;
}

/**
 * Options for listenPort.
 */
export interface ListenPortOptions {
  /** Channel name to filter incoming messages. */
  channelName?: string;
  /** Optional logging function. */
  log?: (...args: unknown[]) => void;
}

/**
 * Handler function type for processing incoming requests.
 */
export type PortHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
) => TResult | Promise<TResult>;

/**
 * Listens to a specific port and handles incoming messages.
 * The result of the handler function is sent back to the port.
 *
 * @param port - The port to listen to.
 * @param handler - The function to handle incoming messages.
 * @param options - Additional options.
 * @returns A function to remove the event listener.
 */
export function listenPort<TParams = unknown, TResult = unknown>(
  port: MessagePort,
  handler: PortHandler<TParams, TResult>,
  options: ListenPortOptions = {},
): () => void {
  const { channelName = "", log } = options;

  const onMessage = async (event: MessageEvent): Promise<void> => {
    const data = event.data as RequestMessage | undefined;

    // Filter messages by type and channel name
    if (!data || data.channelName !== channelName || data.type !== "request") {
      return;
    }

    const { callId, params } = data;
    log?.("[listenPort]", { channelName, callId, params });

    let response: ResponseMessage;
    try {
      const result = await handler(params as TParams);
      response = {
        type: "response:result",
        channelName,
        callId,
        result,
      };
    } catch (e) {
      response = {
        type: "response:error",
        channelName,
        callId,
        error: serializeError(e instanceof Error ? e : String(e)),
      };
    }

    port.postMessage(response);
  };

  port.addEventListener("message", onMessage);

  return () => port.removeEventListener("message", onMessage);
}
