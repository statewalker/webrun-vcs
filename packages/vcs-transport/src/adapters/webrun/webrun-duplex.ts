/**
 * Edge-adapter between the transport's imperative object `Duplex` and the
 * functional `Duplex` of `@statewalker/webrun-streams`.
 *
 * The two shapes describe the same thing from opposite ends:
 *  - Transport `Duplex` — object with imperative `write(bytes)` + an
 *    async-iterator read side, used for an INTERACTIVE, multi-round git
 *    session (advertise → want/have rounds → pack → report-status).
 *  - Webrun `Duplex` — a single function `call(input) => AsyncGenerator`
 *    where `input` is the bytes flowing *into* this side and the yielded
 *    generator is the bytes flowing *out*.
 *
 * A webrun `call(input)` invoked ONCE, with `input` a live queue that the
 * transport feeds incrementally via `write(...)` and whose returned generator
 * the transport drains incrementally as it reads, is a full-duplex byte pipe.
 * The whole interactive negotiation therefore rides one webrun exchange.
 *
 * The queue is bounded ({@link createByteQueue}): `write` returns a promise once
 * a mebibyte (by default) waits, resolved as the peer pulls, so a large pack
 * moves at the pace of its reader. Ending the input (`Duplex.end`) is
 * webrun-streams' half-close: the peer's input ends while its output goes on.
 *
 * @example A git server and a client over one webrun channel
 * ```ts
 * const handler = serveGitOverWebrun({ resolveRepository, enableReceivePack: true });
 * // register `handler` with a webrun-streams `serve`, then on the client:
 * transports.register(createWebrunConnector({ name: "peer", schemes: ["peer"], call: () => call }));
 * await git.clone().setURI("peer://host/repo.git").setTransports(transports).call();
 * ```
 */

import type { Duplex as WebrunDuplex } from "@statewalker/webrun-streams";
import type { Duplex } from "../../api/duplex.js";
import type { GitConnectRequest, GitTransportConnector } from "../../connect/index.js";
import { createDuplexConnector } from "../../connect/index.js";
import {
  type ServeGitConnectionOptions,
  type ServeGitConnectionResult,
  type ServeOverDuplexOptions,
  serveGitConnection,
  serveOverDuplex,
} from "../../operations/index.js";
import { type ByteQueueOptions, createByteQueue } from "../../utils/index.js";

export type { WebrunDuplex };

/** Options of the webrun adapters: how much each direction's queue holds before `write` waits. */
export type WebrunDuplexOptions = ByteQueueOptions;

/** Coerce a webrun `input` (sync or async iterable) into a single async byte stream. */
async function* toAsyncBytes(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of input) yield chunk;
}

/**
 * Wraps a webrun-streams caller `Duplex` as a transport `Duplex`.
 *
 * The transport's outgoing bytes (`write`) feed the single `call(input)`
 * exchange through a bounded queue; `call`'s yielded generator is exposed as
 * the transport's read side. `end` ends the input (the peer's handler sees its
 * input end, its output carries on); `close` also abandons the output.
 *
 * @param call - A webrun caller `Duplex` (e.g. `connect(...).call`, or — for an
 *   in-process loopback — a server handler `Duplex` used directly).
 * @returns A transport `Duplex` the operations (`fetchOverDuplex`,
 *   `pushOverDuplex`, …) can run over unchanged.
 */
export function webrunClientDuplex(call: WebrunDuplex, options: WebrunDuplexOptions = {}): Duplex {
  const outgoing = createByteQueue(options);
  const incoming = call(outgoing.stream);
  let closed = false;
  return {
    [Symbol.asyncIterator]: () => incoming,
    write: (data) => outgoing.push(data),
    end: async () => {
      outgoing.end();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      outgoing.end();
      // a finished output is a no-op; one still running is abandoned (the peer is told)
      void incoming.return(undefined).catch(() => {});
    },
  };
}

/** Options of {@link webrunServerDuplex}. */
export interface WebrunServerDuplexOptions<T> extends WebrunDuplexOptions {
  /**
   * Called once `run` has settled and its output has been taken by the peer (or abandoned,
   * before its first pull too):
   * the moment a transport under the call may be released without losing the answer.
   */
  onSettled?(result: T | undefined, error?: unknown): void;
}

/**
 * Builds a webrun handler `Duplex` that runs `run` against a transport `Duplex` per call:
 * the call's input is the duplex's read side, its writes (through a bounded queue) are the
 * call's output, which ends when `run` settles (with its error, when it fails).
 *
 * @example
 * ```ts
 * const handler = webrunServerDuplex((duplex) => serveGitConnection({ duplex, resolveRepository }));
 * ```
 */
export function webrunServerDuplex<T>(
  run: (duplex: Duplex) => Promise<T>,
  options: WebrunServerDuplexOptions<T> = {},
): WebrunDuplex {
  return (input) => {
    const outgoing = createByteQueue(options);
    const incoming = toAsyncBytes(input);
    const duplex: Duplex = {
      [Symbol.asyncIterator]: () => incoming,
      write: (data) => outgoing.push(data),
      end: async () => {
        outgoing.end();
      },
      close: async () => {
        outgoing.end();
        void incoming.return(undefined).catch(() => {});
      },
    };
    let result: T | undefined;
    let failure: unknown;
    let outputDone: () => void = () => {};
    const outputFinished = new Promise<void>((resolve) => {
      outputDone = resolve;
    });
    const settled = run(duplex).then(
      (value) => {
        result = value;
        outgoing.end();
      },
      (error) => {
        failure = error;
        outgoing.end(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (options.onSettled) {
      const notify = options.onSettled;
      // once `run` settled and nothing it wrote waits any more: taken, or abandoned (a call
      // whose output is dropped before its first pull never runs the generator's `finally`)
      void settled
        .then(() => (outgoing.queuedBytes > 0 ? outputFinished : undefined))
        .then(() => notify(result, failure));
    }
    async function* output(): AsyncGenerator<Uint8Array> {
      try {
        yield* outgoing.stream;
      } finally {
        outputDone();
        // nobody takes the answer any more: the input is not wanted either
        void incoming.return(undefined).catch(() => {});
      }
    }
    const generator = output();
    const abandon = generator.return.bind(generator);
    generator.return = (value) => {
      outputDone();
      // before the first pull the generators never ran: tell the writers and the input here
      outgoing.end(new Error("the peer abandoned the answer"));
      void incoming.return(undefined).catch(() => {});
      return abandon(value);
    };
    return generator;
  };
}

/** Options of {@link serveGitOverWebrun}: `serveGitConnection`'s, bar the stream. */
export type ServeGitOverWebrunOptions = Omit<ServeGitConnectionOptions, "duplex"> &
  WebrunServerDuplexOptions<ServeGitConnectionResult>;

/**
 * A webrun handler `Duplex` serving git's native protocol on every call: git-daemon's request
 * line first (service, path, protocol version), then upload-pack or receive-pack over
 * `serveGitConnection`. Register it with any webrun-streams `serve` (a MessagePort mux, a
 * WebRTC data channel, LiveKit), and reach it with {@link createWebrunConnector}.
 *
 * @example
 * ```ts
 * const stop = await serve({ mux: overPipe(port, { codec: structuredCodec, side: "responder" }) },
 *   serveGitOverWebrun({ resolveRepository, enableReceivePack: true }));
 * ```
 */
export function serveGitOverWebrun(options: ServeGitOverWebrunOptions): WebrunDuplex {
  const { highWaterMark, coalesce, onSettled, ...serve } = options;
  return webrunServerDuplex((duplex) => serveGitConnection({ ...serve, duplex }), {
    ...(highWaterMark !== undefined ? { highWaterMark } : {}),
    ...(coalesce !== undefined ? { coalesce } : {}),
    ...(onSettled ? { onSettled } : {}),
  });
}

/** Options of {@link createWebrunConnector}. */
export interface WebrunConnectorOptions extends WebrunDuplexOptions {
  /** Names the connector */
  name: string;
  /** URL schemes it serves */
  schemes: readonly string[];
  /**
   * The webrun caller for a request: each session is one invocation of it (a mux's `call`
   * opens a port per invocation, so one channel carries any number of sessions)
   */
  call(request: GitConnectRequest): WebrunDuplex | Promise<WebrunDuplex>;
}

/**
 * A connector whose sessions are webrun calls to a {@link serveGitOverWebrun} handler, with
 * git-daemon's request line first.
 *
 * @example
 * ```ts
 * const { call } = await connect({ mux: overPipe(port, { codec: structuredCodec }) });
 * transports.register(createWebrunConnector({ name: "worker", schemes: ["worker"], call: () => call }));
 * ```
 */
export function createWebrunConnector(options: WebrunConnectorOptions): GitTransportConnector {
  const { name, schemes, call, ...queue } = options;
  return createDuplexConnector({
    name,
    schemes,
    open: async (request) => webrunClientDuplex(await call(request), queue),
  });
}

/** Options for {@link serveRepoOverWebrun} — everything `serveOverDuplex` needs bar the duplex. */
export type ServeRepoOverWebrunOptions = Omit<ServeOverDuplexOptions, "duplex">;

/**
 * Builds a webrun-streams handler `Duplex` that serves one repository with the
 * transport's `serveOverDuplex` (no request line: the service is fixed or detected).
 * {@link serveGitOverWebrun} serves many repositories, as git-daemon does.
 *
 * @param options - Repository / refStore / service inputs for `serveOverDuplex`.
 * @returns A webrun `Duplex` handler suitable for a webrun `Serve`, or for an
 *   in-process loopback passed straight into {@link webrunClientDuplex}.
 */
export function serveRepoOverWebrun(options: ServeRepoOverWebrunOptions): WebrunDuplex {
  return webrunServerDuplex((duplex) => serveOverDuplex({ ...options, duplex }));
}
