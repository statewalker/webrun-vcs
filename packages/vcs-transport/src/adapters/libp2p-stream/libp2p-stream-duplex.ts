/**
 * git's native protocol over a libp2p stream, duck-typed (no libp2p dependency). Both stream
 * shapes libp2p has had are taken:
 * - libp2p 3 (`@libp2p/interface` 3): a message stream, async iterable for the bytes from the
 *   peer, `send()` returning false while its buffer is full (then `onDrain()`), `close()`
 *   ending the write side and `abort(err)` dropping the stream;
 * - libp2p 1 and 2 (and any it-style duplex): `source` to read, `sink` to write, `closeWrite`,
 *   `close` and `abort`.
 *
 * The dialer opens a stream with {@link GIT_LIBP2P_PROTOCOL} and sends git-daemon's request
 * line first; the listener's protocol handler serves it with {@link serveGitOverLibp2pStream}.
 * `Duplex.end` ends the write side (a real half-close) without waiting for the peer to read;
 * `Duplex.close` gives what is written `closeTimeout` milliseconds to go out, then aborts the
 * stream, so a peer that stopped reading cannot hold a session (or `serveGitConnection`'s
 * `timeout`) open.
 *
 * @example
 * ```ts
 * // the serving peer
 * await node.handle(GIT_LIBP2P_PROTOCOL, ({ stream }) =>
 *   serveGitOverLibp2pStream(stream, { resolveRepository, enableReceivePack: true }));
 *
 * // the client: libp2p://<peer id>/<repository path>
 * transports.register(createLibp2pConnector({
 *   dial: (peer, protocol, { signal }) =>
 *     node.dialProtocol(peerIdFromString(peer), protocol, { signal }),
 * }));
 * await git.clone().setURI(`libp2p://${peerId}/repo.git`).setTransports(transports).call();
 * ```
 */

import type { Duplex } from "../../api/duplex.js";
import { createDuplexConnector, type GitTransportConnector } from "../../connect/index.js";
import {
  type ServeGitConnectionOptions,
  type ServeGitConnectionResult,
  serveGitConnection,
} from "../../operations/index.js";
import { TransportError } from "../../protocol/index.js";
import { type ByteQueueOptions, createByteQueue } from "../../utils/index.js";

/** The libp2p protocol id git sessions are opened with. */
export const GIT_LIBP2P_PROTOCOL = "/git/1.0.0";

/** A chunk a libp2p stream yields: bytes, or a list of them (`Uint8ArrayList`). */
export type Libp2pChunk = Uint8Array | { subarray(): Uint8Array };

/** What this adapter needs of a libp2p 1/2 stream (an it-style duplex). */
export interface Libp2pSinkStreamLike {
  /** The bytes from the peer */
  source: AsyncIterable<Libp2pChunk>;
  /** Writes the bytes of `source` to the peer; the write side ends when `source` does */
  sink(source: AsyncIterable<Uint8Array>): Promise<void>;
  /** Ends the write side, keeping the read side open */
  closeWrite?(): Promise<void> | void;
  /** Closes both sides */
  close?(): Promise<void> | void;
  /** Drops the stream at once (a reset) */
  abort?(error: Error): void;
}

/** What this adapter needs of a libp2p 3 stream (`@libp2p/interface`'s `MessageStream`). */
export interface Libp2pMessageStreamLike extends AsyncIterable<Libp2pChunk> {
  /** Sends bytes; false when the stream's buffer is full (wait for {@link onDrain}) */
  send(data: Uint8Array): boolean;
  /** Resolves once the stream takes more; rejects when it closes first */
  onDrain?(options?: { signal?: AbortSignal }): Promise<void>;
  /** Ends the write side once what is buffered went out; the read side stays open */
  close(options?: { signal?: AbortSignal }): Promise<void>;
  /** Drops the stream at once (a reset) */
  abort(error: Error): void;
}

/** A libp2p stream of either shape. */
export type Libp2pStreamLike = Libp2pSinkStreamLike | Libp2pMessageStreamLike;

/** Options of {@link libp2pStreamDuplex}. */
export interface Libp2pStreamDuplexOptions extends ByteQueueOptions {
  /**
   * How long `close` lets what is written go out before it aborts the stream, in
   * milliseconds (default 1000)
   */
  closeTimeout?: number;
}

/** Default {@link Libp2pStreamDuplexOptions.closeTimeout}. */
export const DEFAULT_LIBP2P_CLOSE_TIMEOUT = 1000;

const toBytes = (chunk: Libp2pChunk): Uint8Array =>
  chunk instanceof Uint8Array ? chunk : chunk.subarray();
const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Whether `promise` settles within `ms` (a rejection counts as settled). */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isSinkStream(stream: Libp2pStreamLike): stream is Libp2pSinkStreamLike {
  return typeof (stream as Libp2pSinkStreamLike).sink === "function";
}

/**
 * A transport `Duplex` over a libp2p stream (either shape, see above). Over a libp2p 1/2
 * stream, writes go through a bounded queue the stream's `sink` pulls (a promise once
 * `highWaterMark` bytes wait); a sink that fails (a closed or reset stream) fails the waiting
 * and later writes with its error. Over a libp2p 3 stream, a write waits for `onDrain` when
 * `send` says the buffer is full. `end` ends the write side without waiting for the peer;
 * `close` waits at most `closeTimeout` for it, then aborts the stream.
 */
export function libp2pStreamDuplex(
  stream: Libp2pStreamLike,
  options: Libp2pStreamDuplexOptions = {},
): Duplex {
  const { closeTimeout = DEFAULT_LIBP2P_CLOSE_TIMEOUT, ...queue } = options;
  return isSinkStream(stream)
    ? sinkStreamDuplex(stream, queue, closeTimeout)
    : messageStreamDuplex(stream, closeTimeout);
}

function sinkStreamDuplex(
  stream: Libp2pSinkStreamLike,
  options: ByteQueueOptions,
  closeTimeout: number,
): Duplex {
  const outgoing = createByteQueue(options);
  let sinkFailure: Error | undefined;
  const sinkDone: Promise<void> = Promise.resolve()
    .then(() => stream.sink(outgoing.stream))
    .then(
      () => {
        // a sink that returns without taking the queue to its end takes nothing more
        if (!outgoing.ended) outgoing.end(new Error("the libp2p stream stopped taking data"));
      },
      (error: unknown) => {
        // libp2p throws (StreamStateError, a reset) on a closed stream, possibly before it
        // pulled anything: the queue's writers would wait forever
        sinkFailure = toError(error);
        outgoing.end(sinkFailure);
      },
    );
  async function* read(): AsyncGenerator<Uint8Array> {
    for await (const chunk of stream.source) {
      const bytes = toBytes(chunk);
      if (bytes.length > 0) yield bytes;
    }
  }
  const incoming = read();
  // the write side ends once the sink has taken everything queued (not waited for: a peer
  // that never reads must not hang the writer's `end`)
  let writeClosed: Promise<void> | undefined;
  const end = async (): Promise<void> => {
    outgoing.end();
    writeClosed ??= sinkDone.then(async () => {
      if (sinkFailure) return;
      try {
        await stream.closeWrite?.();
      } catch {
        // the stream is gone already
      }
    });
  };
  let closed = false;
  return {
    [Symbol.asyncIterator]: () => incoming,
    write: (data) => outgoing.push(data),
    end,
    async close() {
      if (closed) return;
      closed = true;
      await end();
      if (!(await settlesWithin(writeClosed ?? sinkDone, closeTimeout))) {
        // the peer stopped reading: drop the stream rather than wait for it
        const error = new Error("the libp2p stream was closed before the peer took its data");
        outgoing.end(error);
        try {
          stream.abort?.(error);
        } catch {
          // gone already
        }
      }
      void incoming.return(undefined).catch(() => {});
      try {
        const closing = stream.close?.();
        if (closing && !(await settlesWithin(closing, closeTimeout))) {
          stream.abort?.(new Error("the libp2p stream did not close"));
        }
      } catch {
        // the stream is gone already
      }
    },
  };
}

function messageStreamDuplex(stream: Libp2pMessageStreamLike, closeTimeout: number): Duplex {
  async function* read(): AsyncGenerator<Uint8Array> {
    for await (const chunk of stream) {
      const bytes = toBytes(chunk);
      if (bytes.length > 0) yield bytes;
    }
  }
  const incoming = read();
  let writeClosed: Promise<void> | undefined;
  let failure: Error | undefined;
  const end = async (): Promise<void> => {
    // libp2p 3's `close` ends the write side once what is buffered went out (not waited
    // for, as above)
    writeClosed ??= Promise.resolve()
      .then(() => stream.close())
      .catch(() => undefined);
  };
  let closed = false;
  return {
    [Symbol.asyncIterator]: () => incoming,
    async write(data) {
      if (failure) throw failure;
      if (writeClosed) throw new Error("write after the end of the stream");
      if (data.length === 0) return;
      // `send` throws on a stream closed for writing, locally or by a reset
      if (!stream.send(data)) await stream.onDrain?.();
      if (failure) throw failure;
    },
    end,
    async close() {
      if (closed) return;
      closed = true;
      await end();
      if (!(await settlesWithin(writeClosed ?? Promise.resolve(), closeTimeout))) {
        failure = new Error("the libp2p stream was closed before the peer took its data");
        try {
          stream.abort(failure);
        } catch {
          // gone already
        }
      }
      void incoming.return(undefined).catch(() => {});
    },
  };
}

/** Options of {@link serveGitOverLibp2pStream}: `serveGitConnection`'s, bar the stream. */
export type ServeGitOverLibp2pStreamOptions = Omit<ServeGitConnectionOptions, "duplex"> &
  Libp2pStreamDuplexOptions;

/**
 * Serves one git session on an incoming libp2p stream (a {@link GIT_LIBP2P_PROTOCOL} handler):
 * git-daemon's request line, then upload-pack or receive-pack; the stream is closed once served.
 */
export function serveGitOverLibp2pStream(
  stream: Libp2pStreamLike,
  options: ServeGitOverLibp2pStreamOptions,
): Promise<ServeGitConnectionResult> {
  const { highWaterMark, coalesce, closeTimeout, ...serve } = options;
  const duplex = libp2pStreamDuplex(stream, {
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    ...(coalesce !== undefined ? { coalesce } : {}),
    ...(closeTimeout !== undefined ? { closeTimeout } : {}),
  });
  return serveGitConnection({ ...serve, duplex });
}

/** Options of {@link createLibp2pConnector}. */
export interface Libp2pConnectorOptions extends Libp2pStreamDuplexOptions {
  /**
   * Opens a stream to a peer (the URL's host: a peer id) with a protocol; `signal` aborts
   * once `connectTimeout` passes (libp2p's `dialProtocol` takes it as is)
   */
  dial(
    peer: string,
    protocol: string,
    options: { signal?: AbortSignal },
  ): Promise<Libp2pStreamLike>;
  /** Most milliseconds a dial may take (default: no limit) */
  connectTimeout?: number;
  /** The protocol id (default {@link GIT_LIBP2P_PROTOCOL}) */
  protocol?: string;
  /** The schemes it serves (default `libp2p`) */
  schemes?: readonly string[];
}

/**
 * `libp2p://<peer>/<path>` remotes: a stream per session dialed with the git protocol id,
 * git-daemon's request line first (the path, `host=<peer>`).
 */
export function createLibp2pConnector(options: Libp2pConnectorOptions): GitTransportConnector {
  const { dial, protocol, schemes, connectTimeout, ...queue } = options;
  return createDuplexConnector({
    name: "libp2p",
    schemes: schemes ?? ["libp2p"],
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
    async open(request, { signal }) {
      const peer = request.url.host;
      if (!peer) throw new TransportError(`fatal: no peer in '${request.url.raw}'`);
      const stream = await dial(peer, protocol ?? GIT_LIBP2P_PROTOCOL, signal ? { signal } : {});
      return libp2pStreamDuplex(stream, queue);
    },
  });
}
