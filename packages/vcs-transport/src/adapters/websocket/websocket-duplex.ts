/**
 * git's native protocol over a WebSocket: one git session per socket, the protocol's bytes in
 * binary frames, as over a TCP socket. The client sends git-daemon's request line first
 * (`git-upload-pack /repo.git\0host=<host>\0`), so a server serves any repository its
 * resolver finds, and the URL's path is the repository's.
 *
 * A WebSocket has no half-close, and git needs one where its peer waits for the end of input
 * (a spawned `git upload-pack` after the last v2 command), so this adapter defines one frame:
 * **an empty binary frame ends the sender's direction** (`Duplex.end`); data frames are never
 * empty. Our own server does not wait for it (git's protocol says where each request ends),
 * but a bridge to a native git process turns it into the end of the process's stdin.
 *
 * Flow control: a write waits while the socket's `bufferedAmount` is above the high water
 * mark (polled, as webrun-streams' `newMessagePipe` does). Incoming frames queue until read;
 * a socket that can pause (the `ws` package's `pause()` / `resume()`) is paused while more
 * than `receiveHighWaterMark` bytes wait, so the sender's TCP window closes. A browser
 * WebSocket cannot pause: its reader must keep up.
 *
 * @example Client (browser or Node's global WebSocket) and server (the `ws` package)
 * ```ts
 * transports.register(createWebSocketConnector());
 * await git.clone().setURI("wss://git.example.com/repo.git").setTransports(transports).call();
 *
 * new WebSocketServer({ port: 8080 }).on("connection", (socket) =>
 *   serveGitOverWebSocket(socket, { resolveRepository, enableReceivePack: true }));
 * ```
 */

import { newMessagePipe } from "@statewalker/webrun-streams";
import type { Duplex } from "../../api/duplex.js";
import {
  createDuplexConnector,
  type GitTransportConnector,
  type GitUrl,
} from "../../connect/index.js";
import {
  type ServeGitConnectionOptions,
  type ServeGitConnectionResult,
  serveGitConnection,
} from "../../operations/index.js";
import { TransportError } from "../../protocol/index.js";

/** What this adapter needs of a WebSocket: the browser's, Node's global one, or the `ws` package's. */
export interface WebSocketLike {
  /** 0 connecting, 1 open, 2 closing, 3 closed */
  readonly readyState: number;
  /** Bytes sent and not yet written out */
  readonly bufferedAmount: number;
  /** Set to `"arraybuffer"` where present */
  binaryType?: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
  /** The `ws` package: stops reading from the socket */
  pause?(): void;
  /** The `ws` package: reads again */
  resume?(): void;
}

/** Options of {@link webSocketDuplex}. */
export interface WebSocketDuplexOptions {
  /** A write waits while more than this many bytes are buffered in the socket (default 1 MiB) */
  highWaterMark?: number;
  /** A pausable socket pauses while more than this many received bytes wait (default 4 MiB) */
  receiveHighWaterMark?: number;
  /** How often a waiting write looks at `bufferedAmount`, in milliseconds (default 5) */
  drainPollMs?: number;
}

const OPEN = 1;
const EMPTY = new Uint8Array(0);

/**
 * A transport `Duplex` over an open WebSocket (a connecting one is waited for): binary frames
 * both ways, an empty frame for {@link Duplex.end}, `close` closes the socket (after what is
 * buffered, as a WebSocket closes).
 */
export function webSocketDuplex(
  socket: WebSocketLike,
  options: WebSocketDuplexOptions = {},
): Duplex {
  const highWaterMark = options.highWaterMark ?? 1 << 20;
  const receiveHighWaterMark = options.receiveHighWaterMark ?? 4 << 20;
  if ("binaryType" in socket) socket.binaryType = "arraybuffer";

  const opened =
    socket.readyState === OPEN
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          socket.addEventListener("open", () => resolve(true));
          socket.addEventListener("close", () => resolve(false));
          socket.addEventListener("error", () => resolve(false));
        });

  const control = newMessagePipe(
    {
      send: (bytes) => socket.send(bytes),
      canSend: () => socket.readyState === OPEN,
      bufferedAmount: () => socket.bufferedAmount,
      close: (local) => {
        if (local && socket.readyState < 2) socket.close(1000);
      },
    },
    {
      name: "vcs-transport-websocket",
      drainLowWater: highWaterMark,
      ...(options.drainPollMs !== undefined ? { drainPollMs: options.drainPollMs } : {}),
    },
  );
  const pipe = control.pipe.target;

  const queue: Uint8Array[] = [];
  let queued = 0;
  let paused = false;
  let remoteEnded = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  pipe.addEventListener("message", (event) => {
    const bytes = event.data as Uint8Array;
    if (remoteEnded) return;
    if (bytes.length === 0) {
      remoteEnded = true;
    } else {
      queue.push(bytes);
      queued += bytes.length;
      if (!paused && queued > receiveHighWaterMark && socket.pause && socket.resume) {
        paused = true;
        socket.pause();
      }
    }
    notify();
  });
  control.pipe.signal.addEventListener("abort", notify);
  socket.addEventListener("message", (event) => control.deliver(event.data));
  socket.addEventListener("close", () => control.end(new Error("the WebSocket closed")));
  socket.addEventListener("error", () => control.end(new Error("the WebSocket failed")));

  let ended = false;
  async function* read(): AsyncGenerator<Uint8Array> {
    while (true) {
      const next = queue.shift();
      if (next) {
        queued -= next.length;
        if (paused && queued <= receiveHighWaterMark / 2) {
          paused = false;
          socket.resume?.();
        }
        yield next;
        continue;
      }
      if (remoteEnded || control.ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const incoming = read();
  const end = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    if (await opened) pipe.postMessage(EMPTY);
  };

  return {
    [Symbol.asyncIterator]: () => incoming,
    async write(data) {
      if (data.length === 0 || ended) return;
      if (!(await opened)) return;
      pipe.postMessage(data);
      if (pipe.needsDrain) await pipe.whenDrained();
    },
    end,
    async close() {
      await end();
      await pipe.close();
      if (socket.readyState < 2) socket.close(1000);
    },
  };
}

/** Options of {@link serveGitOverWebSocket}: `serveGitConnection`'s, bar the stream, and the socket's. */
export type ServeGitOverWebSocketOptions = Omit<ServeGitConnectionOptions, "duplex"> &
  WebSocketDuplexOptions;

/**
 * Serves one git session on an accepted WebSocket (the `ws` package's, or any
 * {@link WebSocketLike}): git-daemon's request line, then upload-pack or receive-pack; the
 * socket is closed once served (unless `closeDuplex: false`).
 */
export function serveGitOverWebSocket(
  socket: WebSocketLike,
  options: ServeGitOverWebSocketOptions,
): Promise<ServeGitConnectionResult> {
  const { highWaterMark, receiveHighWaterMark, drainPollMs, ...serve } = options;
  const duplex = webSocketDuplex(socket, {
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    ...(receiveHighWaterMark !== undefined ? { receiveHighWaterMark } : {}),
    ...(drainPollMs !== undefined ? { drainPollMs } : {}),
  });
  return serveGitConnection({ ...serve, duplex });
}

/** Options of {@link createWebSocketConnector}. */
export interface WebSocketConnectorOptions extends WebSocketDuplexOptions {
  /** Opens a socket to a URL (default: `new WebSocket(url)`, the global constructor) */
  createWebSocket?(url: string): WebSocketLike;
  /** The schemes it serves (default `ws` and `wss`) */
  schemes?: readonly string[];
  /** The URL the socket is opened to (default: the remote URL as written) */
  socketUrl?(url: GitUrl): string;
}

/**
 * `ws://` and `wss://` remotes: a socket per session ({@link webSocketDuplex}), git-daemon's
 * request line first, naming the URL's path and host.
 */
export function createWebSocketConnector(
  options: WebSocketConnectorOptions = {},
): GitTransportConnector {
  const { createWebSocket, schemes, socketUrl, ...duplexOptions } = options;
  const open =
    createWebSocket ??
    ((url: string): WebSocketLike => {
      const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
      if (!Ctor) throw new TransportError("fatal: no WebSocket in this environment");
      return new Ctor(url);
    });
  return createDuplexConnector({
    name: "websocket",
    schemes: schemes ?? ["ws", "wss"],
    async open(request) {
      const url = socketUrl ? socketUrl(request.url) : request.url.raw;
      const socket = open(url);
      if ("binaryType" in socket) socket.binaryType = "arraybuffer";
      if (socket.readyState !== OPEN) {
        const ok = await new Promise<boolean>((resolve) => {
          socket.addEventListener("open", () => resolve(true));
          socket.addEventListener("close", () => resolve(false));
          socket.addEventListener("error", () => resolve(false));
        });
        if (!ok) throw new TransportError(`fatal: unable to connect to ${request.url.raw}`);
      }
      return webSocketDuplex(socket, duplexOptions);
    },
  });
}
