/**
 * git's native protocol over a `MessagePort` (a Worker, an iframe, a `MessageChannel` between
 * two modules), on `@statewalker/webrun-rpc`'s stream tier: each direction moves one chunk at
 * a time, the next sent only once the peer's reader has taken the previous one, so a large
 * pack never piles up in the port, and the end of the client's input reaches the server as a
 * half-close.
 *
 * Two shapes:
 * - one session per port: {@link messagePortDuplex} on the client, {@link serveGitOverPort}
 *   on the server (a `MessageChannel` per session);
 * - many sessions over one port: {@link serveGitOverPortMux} on the server and
 *   {@link connectGitOverPortMux} on the client (webrun-rpc's `overPipe` multiplexer, a
 *   virtual port per session, with a flow-control window per port).
 *
 * Either way the client sends git-daemon's request line first, so the server serves any
 * repository its resolver finds (`serveGitConnection`).
 *
 * @example One session per MessageChannel
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * worker.postMessage({ git: port2 }, [port2]);
 * // in the worker: serveGitOverPort(port, { resolveRepository, enableReceivePack: true });
 * transports.register(createMessagePortConnector({
 *   name: "worker", schemes: ["worker"],
 *   openPort: () => openPortToWorker(),   // a fresh MessagePort per session
 * }));
 * ```
 *
 * @example Many sessions over one port
 * ```ts
 * // the worker: await serveGitOverPortMux(port, { resolveRepository });
 * const peer = await connectGitOverPortMux(port1);
 * transports.register(createWebrunConnector({ name: "worker", schemes: ["worker"], call: () => peer.call }));
 * ```
 */

import {
  connect,
  duplexOverPort,
  type MessageTarget,
  overPipe,
  type PortWindow,
  serve,
  serveDuplexOverPort,
  structuredCodec,
} from "@statewalker/webrun-rpc";
import type { Duplex } from "../../api/duplex.js";
import {
  createDuplexConnector,
  type GitConnectRequest,
  type GitTransportConnector,
} from "../../connect/index.js";
import {
  type ServeGitOverWebrunOptions,
  serveGitOverWebrun,
  type WebrunDuplex,
  type WebrunDuplexOptions,
  webrunClientDuplex,
  webrunServerDuplex,
} from "../webrun/index.js";

export type { MessageTarget };

/** Options of {@link messagePortDuplex}. */
export interface MessagePortDuplexOptions extends WebrunDuplexOptions {
  /** Abort the stream after this many milliseconds without a chunk either way (default: none) */
  timeout?: number;
}

/**
 * A transport `Duplex` running one git session on a port served by {@link serveGitOverPort}.
 * Writes wait (a promise) once `highWaterMark` bytes queue up; `end` is a half-close (the
 * server's input ends, its answer goes on). The stream tier closes the port when the session
 * is over (a raw `MessagePort` has no `end` of its own, so the caller's side closes it; an
 * entangled `MessageChannel` port closes its peer too).
 *
 * @param port - A `MessagePort` (or any webrun-rpc `MessageTarget`), one session per port
 */
export function messagePortDuplex(
  port: MessageTarget,
  options: MessagePortDuplexOptions = {},
): Duplex {
  const { timeout, ...queue } = options;
  return webrunClientDuplex(duplexOverPort(port, timeout !== undefined ? { timeout } : {}), queue);
}

/** Options of {@link serveGitOverPort}. */
export type ServeGitOverPortOptions = ServeGitOverWebrunOptions & {
  /** Abort the stream after this many milliseconds without a chunk either way (default: none) */
  streamTimeout?: number;
};

/**
 * Serves one git session on a port: git-daemon's request line, then upload-pack or
 * receive-pack (`serveGitConnection`). Returns a teardown that abandons the session;
 * `onSettled` hears its outcome once the answer was taken.
 *
 * @example
 * ```ts
 * self.onmessage = ({ data }) => serveGitOverPort(data.git, { resolveRepository });
 * ```
 */
export function serveGitOverPort(
  port: MessageTarget,
  options: ServeGitOverPortOptions,
): () => void {
  const { streamTimeout, ...serveOptions } = options;
  return serveDuplexOverPort(
    port,
    serveGitOverWebrun(serveOptions),
    streamTimeout !== undefined ? { timeout: streamTimeout } : {},
  );
}

/** Options of {@link serveOverPort}. */
export interface ServeOverPortOptions extends WebrunDuplexOptions {
  /** Abort the stream after this many milliseconds without a chunk either way (default: none) */
  streamTimeout?: number;
}

/**
 * Runs `run` against the server's end of one session on a port whose client end is a
 * {@link messagePortDuplex}: the stream `serveOverDuplex` (a fixed service), `serveGitService`
 * or any other server reads and writes. It replaces the server side of the deprecated
 * `createMessagePortDuplex`. Returns a teardown that abandons the session.
 *
 * @example
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * serveOverPort(port2, (duplex) =>
 *   serveOverDuplex({ duplex, repository, refStore, service: "git-upload-pack" }),
 * );
 * const result = await fetchOverDuplex({ duplex: messagePortDuplex(port1), repository: local, refStore: localRefs });
 * ```
 */
export function serveOverPort<T>(
  port: MessageTarget,
  run: (duplex: Duplex) => Promise<T>,
  options: ServeOverPortOptions = {},
): () => void {
  const { streamTimeout, ...queue } = options;
  return serveDuplexOverPort(
    port,
    webrunServerDuplex(run, queue),
    streamTimeout !== undefined ? { timeout: streamTimeout } : {},
  );
}

/** Options of {@link serveGitOverPortMux} and {@link connectGitOverPortMux}. */
export interface GitPortMuxOptions {
  /**
   * The flow-control window of each session's port, in bytes, or an adaptive one (webrun-rpc's
   * `PortWindow`; default 1 MiB): what may be delivered to a session and not yet read.
   */
  window?: PortWindow;
  /**
   * The most sessions open at once (webrun-rpc's `maxPorts`); a session past it is refused.
   * {@link serveGitOverPortMux} defaults to {@link DEFAULT_GIT_MAX_PORTS}, so a peer cannot
   * open sessions (each a repository and a window of buffered bytes) without bound; the
   * client side defaults to webrun-rpc's own.
   */
  maxPorts?: number;
}

/** Default {@link GitPortMuxOptions.window}. */
export const DEFAULT_GIT_PORT_WINDOW = 1 << 20;
/** Default {@link GitPortMuxOptions.maxPorts} of {@link serveGitOverPortMux}. */
export const DEFAULT_GIT_MAX_PORTS = 64;

/**
 * Serves git sessions on every virtual port the peer opens over `port` (webrun-rpc's `serve`
 * over `overPipe`, the responder's side), at most `maxPorts` at once (default
 * {@link DEFAULT_GIT_MAX_PORTS}). Returns the teardown.
 */
export async function serveGitOverPortMux(
  port: MessageTarget,
  options: ServeGitOverWebrunOptions & GitPortMuxOptions,
): Promise<() => Promise<void>> {
  const { window, maxPorts, ...serveOptions } = options;
  return serve(
    {
      mux: overPipe(port, {
        codec: structuredCodec,
        side: "responder",
        window: window ?? DEFAULT_GIT_PORT_WINDOW,
        maxPorts: maxPorts ?? DEFAULT_GIT_MAX_PORTS,
      }),
    },
    serveGitOverWebrun(serveOptions),
  );
}

/**
 * The client of {@link serveGitOverPortMux}: `call` opens a session (a virtual port) per
 * invocation; hand it to {@link createWebrunConnector}, or wrap one invocation with
 * `webrunClientDuplex`.
 */
export async function connectGitOverPortMux(
  port: MessageTarget,
  options: GitPortMuxOptions = {},
): Promise<{ call: WebrunDuplex; close(): Promise<void> }> {
  return connect({
    mux: overPipe(port, {
      codec: structuredCodec,
      side: "initiator",
      window: options.window ?? DEFAULT_GIT_PORT_WINDOW,
      ...(options.maxPorts !== undefined ? { maxPorts: options.maxPorts } : {}),
    }),
  });
}

/** Options of {@link createMessagePortConnector}. */
export interface MessagePortConnectorOptions extends WebrunDuplexOptions {
  /** Names the connector */
  name: string;
  /** URL schemes it serves */
  schemes: readonly string[];
  /** A fresh port per session, its other end served by {@link serveGitOverPort} */
  openPort(request: GitConnectRequest): MessageTarget | Promise<MessageTarget>;
}

/** A connector opening one port per session ({@link messagePortDuplex}). */
export function createMessagePortConnector(
  options: MessagePortConnectorOptions,
): GitTransportConnector {
  const { name, schemes, openPort, ...queue } = options;
  return createDuplexConnector({
    name,
    schemes,
    open: async (request) => messagePortDuplex(await openPort(request), queue),
  });
}
