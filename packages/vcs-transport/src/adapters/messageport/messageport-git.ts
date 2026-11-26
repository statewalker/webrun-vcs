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
  getPortCloseSignal,
  type MessageTarget,
  overPipe,
  type PortWindow,
  serve,
  serveDuplexOverPort,
  setPortCloseSignal,
  structuredCodec,
} from "@statewalker/webrun-rpc";
import { type ByteStream, type Duplex, isDuplex } from "../../api/duplex.js";
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
  /**
   * The serving side's close (a daemon answering a client over a socket's port): `close`
   * first ends what was written and waits until the far end has taken all of it (a
   * socket's adapter then writes it out and half-closes), giving up once it took no chunk
   * for this many milliseconds, and only then abandons the rest and closes the port.
   * Without it `close` abandons at once, which may drop the last of the answer still in
   * the port.
   */
  drainTimeout?: number;
}

/** {@link MessagePortDuplexOptions.drainTimeout} of `GitDaemon.serve`'s ports. */
export const DEFAULT_PORT_DRAIN_TIMEOUT = 30000;

/**
 * A transport `Duplex` running one git session on a port served by {@link serveGitOverPort}
 * or {@link serveOverPort}, or carrying a socket (vcs-utils-node's `socketMessagePort`).
 * Writes wait (a promise) once `highWaterMark` bytes queue up; `end` is a half-close (the
 * server's input ends, its answer goes on). `close` abandons what is still running and
 * closes the port (idempotent; with `drainTimeout`, once what was written went out). The
 * server closes its end once the session is over, which closes an entangled
 * `MessageChannel` port too, so a session nobody closes still frees both ports.
 *
 * @param port - A `MessagePort` (or any webrun-rpc `MessageTarget`), one session per port
 */
export function messagePortDuplex(
  port: MessageTarget,
  options: MessagePortDuplexOptions = {},
): Duplex {
  const { timeout, drainTimeout, ...queue } = options;
  watchPortClose(port);
  const call = duplexOverPort(port, timeout !== undefined ? { timeout } : {});
  // what the far end took of the input: each chunk pulled, then its end
  let taken: () => void = () => {};
  let inputOver = false;
  const progress = () => taken();
  const duplex = webrunClientDuplex((input) => {
    // `duplexOverPort` installs its listeners synchronously: start the port right after.
    const output = call(drainTimeout === undefined ? input : observePulls(input));
    startPort(port);
    return output;
  }, queue);
  async function* observePulls(
    input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of input) {
      progress();
      yield chunk;
    }
    inputOver = true;
    progress();
  }
  const closePort = portCloser(port);
  let closing: Promise<void> | undefined;
  /** Ends the input and waits until the far end took all of it (or went quiet, or closed). */
  const drain = async (limit: number) => {
    const signal = getPortCloseSignal(port);
    await duplex.end?.();
    if (inputOver || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        taken = () => {};
        resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(done, limit);
      };
      signal?.addEventListener("abort", done, { once: true });
      taken = () => (inputOver ? done() : arm());
      arm();
    });
  };
  return {
    ...duplex,
    close: () => {
      closing ??= (async () => {
        if (drainTimeout !== undefined) {
          await drain(drainTimeout);
          await duplex.close?.();
          // the end of the input is posted in the turns after it was pulled: close after them
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } else await duplex.close?.();
        closePort();
      })();
      return closing;
    },
  };
}

/**
 * The {@link Duplex} of a {@link ByteStream}: a duplex as it is, a port through
 * {@link messagePortDuplex} (its other end serves the stream: a socket's
 * `socketMessagePort`, `serveGitOverPort`, `serveOverPort`).
 *
 * @example
 * ```ts
 * const duplex = duplexOfStream(await connectSocketPort({ host, port })); // vcs-utils-node
 * ```
 */
export function duplexOfStream(stream: ByteStream, options: MessagePortDuplexOptions = {}): Duplex {
  return isDuplex(stream) ? stream : messagePortDuplex(stream, options);
}

/**
 * Starts a `MessagePort`'s message queue. webrun-rpc's stream tier listens with
 * `addEventListener("message")`, which starts a Node `MessagePort` but not a browser's: there
 * only setting `onmessage` (or `start()`) does, and until then every message stays queued, so a
 * session hangs at its first chunk. Called once the stream's listeners are installed, as Node
 * starts the port at its first listener; a no-op for targets without `start`.
 */
function startPort(port: MessageTarget): void {
  (port as { start?: () => void }).start?.();
}

/** Closes `port` once, however often it is called; a failing or missing `close` is ignored. */
function portCloser(port: MessageTarget): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      void Promise.resolve(port.close?.()).catch(() => {});
    } catch {
      // the port may already be gone
    }
  };
}

/**
 * Gives a real `MessagePort` a close signal (its `close` event: Node, current browsers), so
 * the stream tier fails a session whose other end closed instead of waiting for a chunk that
 * will never come. Other targets keep what they have: a `"close"` listener on a target that
 * only knows `"message"` might be called for every message.
 */
function watchPortClose(port: MessageTarget): void {
  if (typeof MessagePort === "undefined" || !(port instanceof MessagePort)) return;
  if (getPortCloseSignal(port)) return;
  const controller = new AbortController();
  port.addEventListener("close", () => controller.abort(new Error("the MessagePort was closed")), {
    once: true,
  });
  setPortCloseSignal(port, controller.signal);
}

/** Default {@link ServeOverPortOptions.lingerTimeout}. */
export const DEFAULT_PORT_LINGER_TIMEOUT = 1000;

/**
 * Serves one session on `port` and closes the port once it is over: right after the answer's
 * end went out (the peer took every chunk), or `lingerTimeout` ms after the session settled
 * and the last of its answer was handed to the port while the peer leaves that last chunk
 * unread (a fetch client stops reading at the end of the protocol, before the stream's own
 * end, and never closes a duplex it was not asked to). The teardown abandons the session and closes the
 * port at once.
 */
function servePortSession(
  port: MessageTarget,
  handler: (hooks: { onSettled(): void; onDrained(): void }) => WebrunDuplex,
  options: { streamTimeout?: number; lingerTimeout?: number },
): () => void {
  const closePort = portCloser(port);
  let lingering: ReturnType<typeof setTimeout> | undefined;
  let answered = false;
  const close = () => {
    if (lingering !== undefined) clearTimeout(lingering);
    closePort();
  };
  const onAnswered = () => {
    answered = true;
    // the end of the answer is posted in the promise turns after this: close after them
    setTimeout(close, 0);
  };
  // the session settled and all of its answer is out, but the peer may not take the last of it
  const linger = () => {
    if (answered || lingering !== undefined) return;
    lingering = setTimeout(close, options.lingerTimeout ?? DEFAULT_PORT_LINGER_TIMEOUT);
  };
  watchPortClose(port);
  const teardown = serveDuplexOverPort(
    port,
    observeAnswerEnd(handler({ onSettled: linger, onDrained: linger }), onAnswered),
    options.streamTimeout !== undefined ? { timeout: options.streamTimeout } : {},
  );
  startPort(port);
  return () => {
    teardown();
    close();
  };
}

/** `handler`, calling `onEnd` once the stream tier pulled the end of its output. */
function observeAnswerEnd(handler: WebrunDuplex, onEnd: () => void): WebrunDuplex {
  return (input) => {
    const output = handler(input);
    const next = output.next.bind(output);
    let ended = false;
    output.next = async (...args) => {
      const result = await next(...args);
      if (result.done && !ended) {
        ended = true;
        onEnd();
      }
      return result;
    };
    return output;
  };
}

/** Options of {@link serveGitOverPort}. */
export type ServeGitOverPortOptions = ServeGitOverWebrunOptions & {
  /** Abort the stream after this many milliseconds without a chunk either way (default: none) */
  streamTimeout?: number;
  /**
   * How long the port stays open after the session settled while the client leaves the last
   * chunk of the answer unread (default {@link DEFAULT_PORT_LINGER_TIMEOUT} ms)
   */
  lingerTimeout?: number;
};

/**
 * Serves one git session on a port: git-daemon's request line, then upload-pack or
 * receive-pack (`serveGitConnection`). The port is closed once the session is over (see
 * {@link ServeGitOverPortOptions.lingerTimeout}), so neither end of a `MessageChannel` keeps
 * a worker or a Node process alive. Returns a teardown that abandons the session and closes
 * the port; `onSettled` hears its outcome once the answer was taken.
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
  const { streamTimeout, lingerTimeout, onSettled, onDrained, ...serveOptions } = options;
  return servePortSession(
    port,
    (hooks) =>
      serveGitOverWebrun({
        ...serveOptions,
        onSettled: (result, error) => {
          hooks.onSettled();
          onSettled?.(result, error);
        },
        onDrained: () => {
          hooks.onDrained();
          onDrained?.();
        },
      }),
    { streamTimeout, lingerTimeout },
  );
}

/** Options of {@link serveOverPort}. */
export interface ServeOverPortOptions extends WebrunDuplexOptions {
  /** Abort the stream after this many milliseconds without a chunk either way (default: none) */
  streamTimeout?: number;
  /**
   * How long the port stays open after `run` settled while the client leaves the last chunk
   * of the answer unread (default {@link DEFAULT_PORT_LINGER_TIMEOUT} ms)
   */
  lingerTimeout?: number;
}

/**
 * Runs `run` against the server's end of one session on a port whose client end is a
 * {@link messagePortDuplex}: the stream `serveOverDuplex` (a fixed service), `serveGitService`
 * or any other server reads and writes. It replaces the server side of the deprecated
 * `createMessagePortDuplex`. The port is closed once the session is over (see
 * {@link ServeOverPortOptions.lingerTimeout}); the returned teardown abandons the session and
 * closes the port at once.
 *
 * @example
 * ```ts
 * const { port1, port2 } = new MessageChannel();
 * serveOverPort(port2, (duplex) =>
 *   serveOverDuplex({ duplex, repository, refStore, service: "git-upload-pack" }),
 * );
 * const result = await fetchOverDuplex({ duplex: messagePortDuplex(port1), repository: local, refStore: localRefs });
 * // both ports are closed once the session is over
 * ```
 */
export function serveOverPort<T>(
  port: MessageTarget,
  run: (duplex: Duplex) => Promise<T>,
  options: ServeOverPortOptions = {},
): () => void {
  const { streamTimeout, lingerTimeout, ...queue } = options;
  return servePortSession(port, (hooks) => webrunServerDuplex(run, { ...queue, ...hooks }), {
    streamTimeout,
    lingerTimeout,
  });
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
