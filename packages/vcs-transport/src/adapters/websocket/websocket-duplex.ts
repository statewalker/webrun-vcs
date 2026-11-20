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
 * mark (polled, as webrun-streams' `newMessagePipe` does), and goes out in frames of at most
 * `frameSize` bytes (64 KiB). Incoming frames queue until read; a socket that can pause (the
 * `ws` package's `pause()` / `resume()`) is paused while more than `receiveHighWaterMark`
 * bytes wait, so the sender's TCP window closes. A browser WebSocket cannot pause: its reader
 * must keep up. A frame over `maxFrameSize` (1 MiB) closes the socket (1009); a server also
 * bounds what the `ws` package buffers for one message with its `maxPayload`.
 *
 * A socket that fails, or closes without the end frame and with a code other than a normal
 * closure (1000, or 1005 for none), fails the read side with the reason; writes to a socket
 * that is not open fail.
 *
 * @example Client (browser or Node's global WebSocket) and server (the `ws` package)
 * ```ts
 * transports.register(createWebSocketConnector({ connectTimeout: 10_000 }));
 * await git.clone().setURI("wss://git.example.com/repo.git").setTransports(transports).call();
 *
 * new WebSocketServer({ port: 8080, maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE }).on(
 *   "connection",
 *   (socket) => serveGitOverWebSocket(socket, { resolveRepository, enableReceivePack: true }),
 * );
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

/** What a {@link WebSocketLike} hands its listeners: a message's data, a close's code and reason. */
export interface WebSocketLikeEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

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
  addEventListener(type: string, listener: (event: WebSocketLikeEvent) => void): void;
  removeEventListener?(type: string, listener: (event: WebSocketLikeEvent) => void): void;
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
  /** Writes go out in frames of at most this many bytes (default 64 KiB) */
  frameSize?: number;
  /**
   * A received frame larger than this closes the socket (1009, "message too big") and fails
   * the read side (default 1 MiB; a peer's `frameSize` must fit)
   */
  maxFrameSize?: number;
}

/** Default {@link WebSocketDuplexOptions.frameSize}. */
export const DEFAULT_WEBSOCKET_FRAME_SIZE = 64 * 1024;
/** Default {@link WebSocketDuplexOptions.maxFrameSize}; a fit for the `ws` server's `maxPayload`. */
export const DEFAULT_WEBSOCKET_MAX_FRAME_SIZE = 1 << 20;

const OPEN = 1;
const EMPTY = new Uint8Array(0);

/** The byte length of a received message, whatever its type (ArrayBuffer, view, Blob). */
function messageSize(data: unknown): number {
  if (data === null || typeof data !== "object") return 0;
  const sized = data as { byteLength?: number; size?: number };
  return sized.byteLength ?? sized.size ?? 0;
}

/** Whether a close event's code is an orderly closure. */
const isNormalClose = (code: number | undefined) => code === 1000 || code === 1005;

/**
 * A transport `Duplex` over an open WebSocket (a connecting one is waited for): binary frames
 * both ways, an empty frame for {@link Duplex.end}, `close` closes the socket (after what is
 * buffered, as a WebSocket closes) and removes the adapter's listeners.
 */
export function webSocketDuplex(
  socket: WebSocketLike,
  options: WebSocketDuplexOptions = {},
): Duplex {
  const highWaterMark = options.highWaterMark ?? 1 << 20;
  const receiveHighWaterMark = options.receiveHighWaterMark ?? 4 << 20;
  const frameSize = Math.max(1, options.frameSize ?? DEFAULT_WEBSOCKET_FRAME_SIZE);
  const maxFrameSize = options.maxFrameSize ?? DEFAULT_WEBSOCKET_MAX_FRAME_SIZE;
  if ("binaryType" in socket) socket.binaryType = "arraybuffer";

  const listeners: Array<[string, (event: WebSocketLikeEvent) => void]> = [];
  const listen = (type: string, listener: (event: WebSocketLikeEvent) => void) => {
    listeners.push([type, listener]);
    socket.addEventListener(type, listener);
  };
  const unlisten = () => {
    for (const [type, listener] of listeners.splice(0)) {
      socket.removeEventListener?.(type, listener);
    }
  };

  const opened =
    socket.readyState === OPEN
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          listen("open", () => resolve(true));
          listen("close", () => resolve(false));
          listen("error", () => resolve(false));
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
  /** Why the socket ended, or undefined while open / when it ended in order. */
  let abnormal: Error | undefined;
  const reason = (): Error => {
    const why = control.pipe.signal.reason;
    return abnormal ?? (why instanceof Error ? why : new Error("the WebSocket is closed"));
  };

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
  control.pipe.signal.addEventListener("abort", () => {
    unlisten();
    notify();
  });
  listen("message", (event) => {
    const size = messageSize(event.data);
    if (size > maxFrameSize) {
      abnormal = new TransportError(
        `fatal: a ${size}-byte WebSocket frame exceeds the limit of ${maxFrameSize} bytes`,
      );
      if (socket.readyState < 2) socket.close(1009, "message too big");
      control.end(abnormal);
      return;
    }
    control.deliver(event.data);
  });
  listen("close", (event) => {
    const detail =
      event.code !== undefined
        ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`
        : "";
    const error = new TransportError(`fatal: the WebSocket closed${detail}`);
    if (!isNormalClose(event.code)) abnormal ??= error;
    control.end(error);
  });
  listen("error", () => {
    const error = new TransportError("fatal: the WebSocket failed");
    abnormal ??= error;
    control.end(error);
  });

  let ended = false;
  let closedLocally = false;
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
      if (remoteEnded) return;
      if (control.ended) {
        // the end frame is the clean end; without it only an orderly close (or our own) is
        if (abnormal && !closedLocally) throw abnormal;
        return;
      }
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
      if (data.length === 0) return;
      if (ended) throw new TransportError("fatal: write after the end of the WebSocket stream");
      if (!(await opened)) throw new TransportError("fatal: the WebSocket did not open");
      for (let offset = 0; offset < data.length; offset += frameSize) {
        if (control.ended || socket.readyState !== OPEN) throw reason();
        pipe.postMessage(data.subarray(offset, offset + frameSize));
        if (pipe.needsDrain) await pipe.whenDrained();
      }
    },
    end,
    async close() {
      closedLocally = true;
      await end();
      await pipe.close();
      unlisten();
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
 * socket is closed once served (unless `closeDuplex: false`). Give the `ws` server a
 * `maxPayload` (e.g. {@link DEFAULT_WEBSOCKET_MAX_FRAME_SIZE}): its default lets one message
 * buffer 100 MiB before this adapter sees it.
 *
 * @example
 * ```ts
 * const server = new WebSocketServer({ port: 8080, maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE });
 * server.on("connection", (socket) =>
 *   serveGitOverWebSocket(socket, { resolveRepository, timeout: 600_000 }));
 * ```
 */
export function serveGitOverWebSocket(
  socket: WebSocketLike,
  options: ServeGitOverWebSocketOptions,
): Promise<ServeGitConnectionResult> {
  const { highWaterMark, receiveHighWaterMark, drainPollMs, frameSize, maxFrameSize, ...serve } =
    options;
  const duplex = webSocketDuplex(socket, {
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    ...(receiveHighWaterMark !== undefined ? { receiveHighWaterMark } : {}),
    ...(drainPollMs !== undefined ? { drainPollMs } : {}),
    ...(frameSize !== undefined ? { frameSize } : {}),
    ...(maxFrameSize !== undefined ? { maxFrameSize } : {}),
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
  /** Most milliseconds the socket may take to open (default: no limit) */
  connectTimeout?: number;
}

/**
 * `ws://` and `wss://` remotes: a socket per session ({@link webSocketDuplex}), git-daemon's
 * request line first, naming the URL's path and host.
 */
export function createWebSocketConnector(
  options: WebSocketConnectorOptions = {},
): GitTransportConnector {
  const { createWebSocket, schemes, socketUrl, connectTimeout, ...duplexOptions } = options;
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
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
    async open(request, { signal }) {
      const url = socketUrl ? socketUrl(request.url) : request.url.raw;
      const socket = open(url);
      if ("binaryType" in socket) socket.binaryType = "arraybuffer";
      if (socket.readyState !== OPEN) {
        const ok = await new Promise<boolean>((resolve) => {
          const settle = (value: boolean) => {
            socket.removeEventListener?.("open", onOpen);
            socket.removeEventListener?.("close", onFail);
            socket.removeEventListener?.("error", onFail);
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          };
          const onOpen = () => settle(true);
          const onFail = () => settle(false);
          const onAbort = () => {
            if (socket.readyState < 2) socket.close(1000);
            settle(false);
          };
          socket.addEventListener("open", onOpen);
          socket.addEventListener("close", onFail);
          socket.addEventListener("error", onFail);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        });
        if (!ok) throw new TransportError(`fatal: unable to connect to ${request.url.raw}`);
      }
      return webSocketDuplex(socket, duplexOptions);
    },
  });
}
