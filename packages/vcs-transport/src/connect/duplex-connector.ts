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
 *     open: async () => messagePortDuplex(await openWorkerPort(), { closePort: true }),
 *   }),
 * );
 * // worker://local/repo.git → the worker reads the request line (serveGitOverPort)
 * ```
 */

import type { Duplex } from "../api/duplex.js";
import type { GitConnectRequest, GitTransportConnector } from "./connector.js";
import type { GitUrl } from "./git-url.js";

/** Options of {@link createDuplexConnector}. */
export interface DuplexConnectorOptions {
  /** Names the connector (unregistering by name) */
  name: string;
  /** URL schemes it serves */
  schemes?: readonly string[];
  /** Whether it serves a URL its schemes do not name */
  matches?(url: GitUrl): boolean;
  /** Opens a stream for the request (one session per stream) */
  open(request: GitConnectRequest): Promise<Duplex>;
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
      const duplex = await options.open(request);
      return { kind: "native", duplex, handshake };
    },
  };
}
