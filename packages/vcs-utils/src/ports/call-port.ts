/**
 * Call a port with parameters and wait for a response.
 *
 * Implements the client side of the request/response pattern
 * in conjunction with the `listenPort` function.
 */

import { deserializeError, type SerializedError } from "./errors.js";

/**
 * Message structure for outgoing requests.
 */
interface RequestMessage {
  type: "request";
  channelName: string;
  callId: string;
  params: unknown;
}

/**
 * Message structure for incoming responses.
 */
interface ResponseMessage {
  type: "response:result" | "response:error";
  channelName: string;
  callId: string;
  result?: unknown;
  error?: SerializedError;
}

/**
 * Options for callPort.
 */
export interface CallPortOptions {
  /** Timeout duration in milliseconds (default: 1000). */
  timeout?: number;
  /** Channel name for filtering messages. */
  channelName?: string;
  /** Optional logging function. */
  log?: (...args: unknown[]) => void;
  /** Function to generate a new call ID. */
  newCallId?: () => string;
}

/**
 * Generate a unique call ID.
 */
function defaultNewCallId(): string {
  return `call-${Date.now()}-${String(Math.random()).substring(2)}`;
}

/**
 * Calls a port with the specified parameters and returns a promise
 * that resolves with the call result.
 *
 * @param port - The port to call.
 * @param params - The parameters to pass to the port.
 * @param options - Optional configuration options.
 * @returns A promise that resolves with the result of the port call.
 */
export async function callPort<TParams = unknown, TResult = unknown>(
  port: MessagePort,
  params: TParams,
  options: CallPortOptions = {},
): Promise<TResult> {
  const { timeout = 1000, channelName = "", log, newCallId = defaultNewCallId } = options;

  const callId = newCallId();
  log?.("[callPort]", { channelName, callId, params });

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
      port.removeEventListener("message", onMessage);
    };

    const settle = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    timerId = setTimeout(() => {
      settle(reject, new Error(`Call timeout. CallId: "${callId}".`));
    }, timeout);

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as ResponseMessage | undefined;
      if (!data) return;
      if (data.channelName !== channelName) return;
      if (data.callId !== callId) return;

      if (data.type === "response:error") {
        settle(reject, deserializeError(data.error ?? "Unknown error"));
      } else if (data.type === "response:result") {
        settle(resolve, data.result as TResult);
      }
    };

    port.addEventListener("message", onMessage);

    // Send the request
    const request: RequestMessage = {
      type: "request",
      channelName,
      callId,
      params,
    };
    port.postMessage(request);
  });
}
