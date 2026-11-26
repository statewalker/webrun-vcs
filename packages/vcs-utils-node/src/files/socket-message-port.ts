/**
 * Sockets as `MessagePort`s: the one place where a byte transport of the host (a TCP or
 * Unix-domain `net.Socket`) is turned into the web-standard port portable code talks to.
 *
 * ```typescript
 * import { duplexOverPort } from "@statewalker/webrun-rpc";
 * import { connectSocketPort } from "@statewalker/vcs-utils-node/files";
 *
 * const port = await connectSocketPort("/repo/.git/fsmonitor--daemon.ipc");
 * const call = duplexOverPort(port);
 * port.start();
 * for await (const chunk of call([request])) handle(chunk);
 * port.close();
 * ```
 *
 * The port speaks webrun-rpc's stream tier (`duplexOverPort` on the caller's side,
 * `serveDuplexOverPort` here): one stream per port, `Uint8Array` chunks both ways, each
 * direction confirmed chunk by chunk, so a slow reader on either side throttles the other
 * instead of filling a queue. What the caller sends is written to the socket, waiting for
 * `drain` whenever the socket's own buffer is full; what the socket receives is read only as
 * fast as the caller pulls it (the socket is paused in between, and TCP pushes back on the
 * peer). The ends are explicit: the end of the caller's input is the socket's half-close
 * (`end()`, a FIN: the peer reads end of file and may still answer), the peer's FIN is the
 * end of the output; once both are over the port is closed. A socket error, or the caller
 * closing its port or abandoning the output, destroys the socket and closes the port, so
 * each side sees the failure; once the caller's input has ended (the socket half-closed),
 * what it sent is still flushed to the peer before the socket is destroyed (a server that
 * abandons the client's input after writing its whole answer loses none of it).
 *
 * Library code never imports this module: it receives such a port from the host (a
 * `GitHostEnvironment` function), and a `MessageChannel`, a worker, or a WebSocket bridge
 * serve it the same way.
 */

import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { serveDuplexOverPort } from "@statewalker/webrun-rpc";

/** A Unix-domain socket's path, or a TCP address. */
export type SocketTarget = string | { host?: string; port: number };

/** Options of {@link socketMessagePort}, {@link connectSocketPort}, {@link listenSocketPorts}. */
export interface SocketMessagePortOptions {
  /**
   * Abort the stream after this many milliseconds without a chunk either way (webrun-rpc's
   * stream timeout; default: none)
   */
  timeout?: number;
}

/**
 * One end of a `MessageChannel` carrying `socket`'s bytes (see the module comment). The
 * socket should be half-open capable (`allowHalfOpen: true`), or the peer's FIN also ends
 * what the caller still sends. The returned port is not started: the caller starts it once
 * its listeners are installed (`duplexOverPort`, then `start()`).
 */
export function socketMessagePort(
  socket: Socket,
  options: SocketMessagePortOptions = {},
): MessagePort {
  const { port1, port2 } = new MessageChannel();
  let closed = false;
  let inputDone = false;
  let outputDone = false;
  // an error before (or between) reads must not crash the process: the read loop rethrows it
  let failure: Error | undefined;
  socket.on("error", (error) => {
    failure ??= error;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) {
      if (inputDone && !socket.writableFinished && !failure) {
        // half-closed already (all the caller sent is written): let it reach the peer
        // before the socket goes, then destroy it; a peer that never reads gets no longer
        // than a stream timeout's worth (or 30 s)
        const timer = setTimeout(() => socket.destroy(), options.timeout ?? 30000);
        timer.unref?.();
        socket.once("finish", () => {
          clearTimeout(timer);
          socket.destroy();
        });
      } else socket.destroy();
    }
    try {
      // abandons the stream and tells the peer; posting may fail on a port already closed
      teardown();
    } catch {
      // the caller's port is gone already
    }
    port1.close();
  };
  const settle = () => {
    // the last chunk of the output goes out in the promise turns after its end was pulled
    if (inputDone && outputDone) setTimeout(close, 0);
  };

  const handler = (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) =>
    (async function* () {
      void (async () => {
        try {
          for await (const chunk of input) {
            if (chunk.byteLength === 0) continue;
            if (!socket.write(chunk)) await drained(socket);
          }
          // half-close: the peer reads end of file, its answer goes on
          if (!socket.destroyed) socket.end();
          inputDone = true;
          settle();
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      try {
        if (failure) throw failure;
        // destroyOnReturn off: the peer's end of file must not destroy a socket still
        // carrying the caller's input (a half-close); an abandoned output is closed below
        for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
          // a copy: a socket's buffer may be a view of a larger one the clone would carry
          yield Uint8Array.prototype.slice.call(chunk);
        }
        if (failure) throw failure;
        outputDone = true;
        settle();
      } finally {
        // a failure, or the caller abandoning the output: both sides are closed
        if (!outputDone) close();
      }
    })();

  const teardown = serveDuplexOverPort(
    port1,
    handler,
    options.timeout !== undefined ? { timeout: options.timeout } : {},
  );
  // the caller closing its end (an entangled MessageChannel port closes both)
  port1.addEventListener("close", close, { once: true });
  socket.once("close", () => {
    // a socket destroyed by the peer (a reset) before anyone read it: fail the stream
    if (!outputDone && failure && !closed) close();
  });
  port1.start();
  return port2;
}

/** Resolves once `socket` drained its write buffer; rejects if it closes first. */
function drained(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      socket.off("close", onClose);
      resolve();
    };
    const onClose = () => {
      socket.off("drain", onDrain);
      reject(new Error("the socket closed while writing"));
    };
    socket.once("drain", onDrain);
    socket.once("close", onClose);
  });
}

/**
 * Connects to a Unix-domain socket (a path) or a TCP address and gives the connection as a
 * port ({@link socketMessagePort}). Rejects when the connection cannot be made (the error
 * of `net.connect`: `ENOENT`, `ECONNREFUSED`...).
 */
export function connectSocketPort(
  target: SocketTarget,
  options: SocketMessagePortOptions = {},
): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const socket =
      typeof target === "string"
        ? connect({ path: target, allowHalfOpen: true })
        : connect({ host: target.host ?? "127.0.0.1", port: target.port, allowHalfOpen: true });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socketMessagePort(socket, options));
    });
  });
}

/**
 * Who an accepted connection comes from (`net.Socket`'s `remoteAddress`/`remotePort`; both
 * absent for a Unix-domain socket), as git-daemon's `--max-connections` and access hook use it.
 */
export interface SocketPeer {
  remoteAddress?: string;
  remotePort?: number;
}

/** A listening socket handing each connection over as a port (see {@link listenSocketPorts}). */
export interface SocketPortServer {
  /** The socket's path, or its TCP address (the port chosen when `port` was 0) */
  readonly address: string | AddressInfo;
  /** Stops listening and destroys the connections still open */
  close(): Promise<void>;
}

/**
 * Listens on a Unix-domain socket (a path) or a TCP address and calls `onPort` with each
 * accepted connection as a port ({@link socketMessagePort}), the serving side's view: its
 * input is what the client sends, its output goes back to the client. `peer` names the
 * client's address and port (TCP only).
 *
 * @example
 * ```typescript
 * const daemon = createGitDaemon({ resolveRepository }); // vcs-transport
 * const server = await listenSocketPorts({ port: 9418 }, (port, peer) =>
 *   void daemon.serve(port, {
 *     ...(peer.remoteAddress !== undefined ? { remoteAddress: peer.remoteAddress } : {}),
 *     ...(peer.remotePort !== undefined ? { remotePort: String(peer.remotePort) } : {}),
 *   }),
 * );
 * ```
 */
export function listenSocketPorts(
  target: SocketTarget,
  onPort: (port: MessagePort, peer: SocketPeer) => void,
  options: SocketMessagePortOptions = {},
): Promise<SocketPortServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const peer: SocketPeer = {
      ...(socket.remoteAddress !== undefined ? { remoteAddress: socket.remoteAddress } : {}),
      ...(socket.remotePort !== undefined ? { remotePort: socket.remotePort } : {}),
    };
    onPort(socketMessagePort(socket, options), peer);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const listening = () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        address: address ?? (typeof target === "string" ? target : ""),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    };
    if (typeof target === "string") server.listen(target, listening);
    else server.listen(target.port, target.host ?? "127.0.0.1", listening);
  });
}
