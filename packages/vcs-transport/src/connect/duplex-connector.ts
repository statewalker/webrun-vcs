/**
 * A connector over any byte stream the host can open for a URL: a MessagePort, a WebSocket, a
 * libp2p stream. The stream carries git's native protocol, git-daemon's request line first
 * (`git-upload-pack /repo.git\0host=<host>\0`) unless the peer learns the service and
 * repository some other way.
 *
 * @example
 * ```ts
 * transports.register(
 *   createDuplexConnector({
 *     name: "worker",
 *     schemes: ["worker"],
 *     open: async () => messagePortDuplex(await openWorkerPort()),
 *     connectTimeout: 10_000,
 *   }),
 * );
 * // worker://local/repo.git → the worker reads the request line (serveGitOverPort)
 * ```
 */

import type { Duplex } from "../api/duplex.js";
import { TransportError } from "../protocol/index.js";
import type { GitConnectRequest, GitTransportConnector } from "./connector.js";
import type { GitUrl } from "./git-url.js";

/** What {@link DuplexConnectorOptions.open} is given besides the request. */
export interface DuplexOpenOptions {
  /** Aborts when `connectTimeout` passes first: stop connecting */
  signal?: AbortSignal;
}

/** Options of {@link createDuplexConnector}. */
export interface DuplexConnectorOptions {
  /** Names the connector (unregistering by name) */
  name: string;
  /** URL schemes it serves */
  schemes?: readonly string[];
  /** Whether it serves a URL its schemes do not name */
  matches?(url: GitUrl): boolean;
  /** Opens a stream for the request (one session per stream) */
  open(request: GitConnectRequest, options: DuplexOpenOptions): Promise<Duplex>;
  /**
   * Most milliseconds `open` may take (default: no limit): past it the session fails with
   * `fatal: unable to connect`, `open`'s signal aborts, and a stream it still returns is
   * closed
   */
  connectTimeout?: number;
  /**
   * `"git-daemon"` (default): the client writes git-daemon's request line first, so the
   * server (`serveGitConnection`) learns the service, the path and the protocol version.
   * `"implicit"`: the stream is already bound to a service and repository; the server
   * speaks first (`serveGitService`).
   */
  handshake?: "git-daemon" | "implicit";
}

/** A connector whose sessions are the streams `open` returns; see {@link DuplexConnectorOptions}. */
export function createDuplexConnector(options: DuplexConnectorOptions): GitTransportConnector {
  const handshake = options.handshake ?? "git-daemon";
  return {
    name: options.name,
    ...(options.schemes ? { schemes: options.schemes } : {}),
    ...(options.matches ? { matches: (url: GitUrl) => options.matches?.(url) ?? false } : {}),
    async connect(request) {
      const duplex = await openWithin(options, request);
      return { kind: "native", duplex, handshake };
    },
  };
}

async function openWithin(
  options: DuplexConnectorOptions,
  request: GitConnectRequest,
): Promise<Duplex> {
  const ms = options.connectTimeout;
  if (ms === undefined) return options.open(request, {});
  const controller = new AbortController();
  const opening = Promise.resolve().then(() =>
    options.open(request, { signal: controller.signal }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new TransportError(
            `fatal: unable to connect to ${request.url.raw}: timed out after ${ms} ms`,
          );
          controller.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      // a stream that opens after all is not wanted any more
      void opening.then(
        (late) => late.close?.().catch(() => undefined),
        () => undefined,
      );
    }
  }
}
