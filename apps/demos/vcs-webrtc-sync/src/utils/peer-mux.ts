/**
 * One multiplexer per peer pipe that both calls and serves.
 *
 * `webrun-rpc`'s `connect` and `serve` each expect to own the mux their
 * factory builds. A P2P peer needs both over the same pipe: it serves Git to
 * the other participant and calls it to sync. Two `overPipe` muxes on one pipe
 * would both read every message, so this module builds one `multiplexPort`,
 * routes inbound ports to whichever handler `serve` registered, and hands
 * `connect` / `serve` a view whose `close()` does nothing: only
 * `PeerMux.close()` releases the pipe.
 */

import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  connect,
  type MessageTarget,
  multiplexPort,
  type OnPort,
  type PortMux,
  serve,
} from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";

/** The calling and serving halves of one peer connection. */
export interface PeerMux {
  /** Opens a fresh logical call (one port) to the peer. */
  call: Duplex;
  /** Answers the peer's calls with `handler`. Returns the teardown. */
  serve(handler: Duplex): () => Promise<void>;
  /** Fails every call in flight and stops using the pipe. */
  close(): Promise<void>;
}

export interface PeerMuxOptions {
  /** The two ends of one pipe must pick opposite sides. */
  side: "initiator" | "responder";
  /** Aborts when the transport goes; closes the mux. */
  signal?: AbortSignal;
  /** Payload ceiling of the transport; bodies are chunked under it. */
  maxMessageSize?: number;
}

/** Wrap a pipe of bytes (a `messageTargetOver…` target) as a {@link PeerMux}. */
export function createPeerMux(pipe: MessageTarget, options: PeerMuxOptions): PeerMux {
  let inbound: OnPort | undefined;
  const mux = multiplexPort(pipe, {
    codec: msgpackCodec,
    side: options.side,
    signal: options.signal,
    maxMessageSize: options.maxMessageSize,
    onPort: (port, meta) => (inbound ? inbound(port, meta) : false),
  });
  const shared: PortMux = {
    openPort: (meta, openOptions) => mux.openPort(meta, openOptions),
    close: async () => {},
    ports: () => mux.ports?.() ?? [],
    maxMessageSize: mux.maxMessageSize,
  };

  const client = connect({ mux: () => shared });
  const call: Duplex = (input) =>
    (async function* () {
      const { call: inner } = await client;
      yield* inner(input);
    })();

  return {
    call,
    serve(handler) {
      const stop = serve(
        {
          mux: (onPort) => {
            inbound = onPort;
            return shared;
          },
        },
        handler,
      );
      return async () => {
        inbound = undefined;
        await (await stop)();
      };
    },
    async close() {
      inbound = undefined;
      await mux.close();
    },
  };
}
