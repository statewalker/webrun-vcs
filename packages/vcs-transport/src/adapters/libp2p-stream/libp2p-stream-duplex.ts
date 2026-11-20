/**
 * git's native protocol over a libp2p stream, duck-typed (no libp2p dependency): anything with
 * a `source` to read and a `sink` to write, as libp2p's `Stream` (and any it-style duplex) has.
 * The dialer opens a stream with {@link GIT_LIBP2P_PROTOCOL} and sends git-daemon's request
 * line first; the listener's protocol handler serves it with {@link serveGitOverLibp2pStream}.
 * `Duplex.end` ends the write side (`closeWrite`), a real half-close.
 *
 * @example
 * ```ts
 * // the serving peer
 * await node.handle(GIT_LIBP2P_PROTOCOL, ({ stream }) =>
 *   serveGitOverLibp2pStream(stream, { resolveRepository, enableReceivePack: true }));
 *
 * // the client: libp2p://<peer id>/<repository path>
 * transports.register(createLibp2pConnector({
 *   dial: (peer, protocol) => node.dialProtocol(peerIdFromString(peer), protocol),
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

/** What this adapter needs of a libp2p stream. */
export interface Libp2pStreamLike {
  /** The bytes from the peer */
  source: AsyncIterable<Libp2pChunk>;
  /** Writes the bytes of `source` to the peer; the write side ends when `source` does */
  sink(source: AsyncIterable<Uint8Array>): Promise<void>;
  /** Ends the write side, keeping the read side open */
  closeWrite?(): Promise<void> | void;
  /** Closes both sides */
  close?(): Promise<void> | void;
}

/** Options of {@link libp2pStreamDuplex}: how much waits for the sink before `write` does. */
export type Libp2pStreamDuplexOptions = ByteQueueOptions;

/**
 * A transport `Duplex` over a libp2p stream: writes go through a bounded queue the stream's
 * `sink` pulls (a promise once `highWaterMark` bytes wait), `end` ends the queue and, once the
 * sink has taken it, the write side (`closeWrite`); `close` waits for that, then closes the
 * stream.
 */
export function libp2pStreamDuplex(
  stream: Libp2pStreamLike,
  options: Libp2pStreamDuplexOptions = {},
): Duplex {
  const outgoing = createByteQueue(options);
  const sinkDone = stream.sink(outgoing.stream).then(
    () => undefined,
    (error: unknown) => error,
  );
  async function* read(): AsyncGenerator<Uint8Array> {
    for await (const chunk of stream.source) {
      const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
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
      await writeClosed;
      void incoming.return(undefined).catch(() => {});
      try {
        await stream.close?.();
      } catch {
        // the stream is gone already
      }
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
  const { highWaterMark, coalesce, ...serve } = options;
  const duplex = libp2pStreamDuplex(stream, {
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    ...(coalesce !== undefined ? { coalesce } : {}),
  });
  return serveGitConnection({ ...serve, duplex });
}

/** Options of {@link createLibp2pConnector}. */
export interface Libp2pConnectorOptions extends Libp2pStreamDuplexOptions {
  /** Opens a stream to a peer (the URL's host: a peer id) with a protocol */
  dial(peer: string, protocol: string): Promise<Libp2pStreamLike>;
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
  const { dial, protocol, schemes, ...queue } = options;
  return createDuplexConnector({
    name: "libp2p",
    schemes: schemes ?? ["libp2p"],
    async open(request) {
      const peer = request.url.host;
      if (!peer) throw new TransportError(`fatal: no peer in '${request.url.raw}'`);
      return libp2pStreamDuplex(await dial(peer, protocol ?? GIT_LIBP2P_PROTOCOL), queue);
    },
  });
}
