/**
 * Edge-adapter between the transport's imperative object `Duplex` and the
 * functional `Duplex` of `@statewalker/webrun-streams`.
 *
 * The two shapes describe the same thing from opposite ends:
 *  - Transport `Duplex` — object with imperative `write(bytes)` + an
 *    async-iterator read side, used for an INTERACTIVE, multi-round git v1
 *    session (advertise → want/have rounds → pack → report-status).
 *  - Webrun `Duplex` — a single function `call(input) => AsyncGenerator`
 *    where `input` is the bytes flowing *into* this side and the yielded
 *    generator is the bytes flowing *out*.
 *
 * A webrun `call(input)` invoked ONCE, with `input` a live push-queue that the
 * transport feeds incrementally via `write(...)` and whose returned generator
 * the transport drains incrementally as it reads, is a full-duplex byte pipe —
 * exactly the shape the operations already consume from a real `git`
 * subprocess's stdio (`gitProcessDuplex`). The whole interactive negotiation
 * therefore rides one webrun exchange: writes are buffered and non-blocking
 * (the transport's `write` is fire-and-forget), so neither direction can
 * deadlock the other regardless of who speaks first.
 */

import type { Duplex as WebrunDuplex } from "@statewalker/webrun-streams";
import type { Duplex } from "../../api/duplex.js";
import {
  type ServeOverDuplexOptions,
  serveOverDuplex,
} from "../../operations/serve-over-duplex.js";

export type { WebrunDuplex };

/**
 * A simple, eager push/pull byte queue. Unlike `newAsyncGenerator`, `push` and
 * `done` are valid immediately — before the consumer starts iterating — because
 * the peer may write (e.g. a server writing its ref advertisement) before the
 * other side begins reading. No backpressure: the transport's `write` is
 * fire-and-forget, so an unbounded queue is the faithful model.
 */
function pushQueue(): {
  push: (chunk: Uint8Array) => void;
  done: (err?: Error) => void;
  stream: AsyncGenerator<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: Error | undefined;

  const push = (chunk: Uint8Array): void => {
    if (finished) return;
    chunks.push(chunk);
    wake?.();
    wake = null;
  };

  const done = (err?: Error): void => {
    if (finished) return;
    finished = true;
    failure = err;
    wake?.();
    wake = null;
  };

  async function* stream(): AsyncGenerator<Uint8Array> {
    while (true) {
      if (chunks.length > 0) {
        yield chunks.shift() as Uint8Array;
        continue;
      }
      if (finished) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return { push, done, stream: stream() };
}

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
 * exchange as a live queue; `call`'s yielded generator is exposed as the
 * transport's read side. One `call` carries the whole interactive session.
 *
 * @param call - A webrun caller `Duplex` (e.g. `connect(...).call`, or — for an
 *   in-process loopback — a server handler `Duplex` used directly).
 * @returns A transport `Duplex` the operations (`fetchOverDuplex`,
 *   `pushOverDuplex`, …) can run over unchanged.
 */
export function webrunClientDuplex(call: WebrunDuplex): Duplex {
  const outgoing = pushQueue();
  const incoming = call(outgoing.stream);
  return {
    [Symbol.asyncIterator]: () => incoming[Symbol.asyncIterator](),
    write: (data) => outgoing.push(data),
    close: async () => {
      outgoing.done();
    },
  };
}

/** Options for {@link serveRepoOverWebrun} — everything `serveOverDuplex` needs bar the duplex. */
export type ServeRepoOverWebrunOptions = Omit<ServeOverDuplexOptions, "duplex">;

/**
 * Builds a webrun-streams handler `Duplex` that serves a repository with the
 * transport's `serveOverDuplex`.
 *
 * The handler's `input` (incoming client bytes) becomes the read side of a
 * transport `Duplex`; the transport's `write` feeds a push-queue that is
 * returned as the handler's outgoing generator. `serveOverDuplex` runs against
 * that duplex; when it settles, the outgoing generator ends.
 *
 * @param options - Repository / refStore / service inputs for `serveOverDuplex`.
 * @returns A webrun `Duplex` handler suitable for a webrun `Serve`, or for an
 *   in-process loopback passed straight into {@link webrunClientDuplex}.
 */
export function serveRepoOverWebrun(options: ServeRepoOverWebrunOptions): WebrunDuplex {
  return (input) => {
    const outgoing = pushQueue();
    const incoming = toAsyncBytes(input);
    const duplex: Duplex = {
      [Symbol.asyncIterator]: () => incoming[Symbol.asyncIterator](),
      write: (data) => outgoing.push(data),
      close: async () => {
        outgoing.done();
      },
    };
    void serveOverDuplex({ ...options, duplex })
      .then(() => outgoing.done())
      .catch((err) => outgoing.done(err instanceof Error ? err : new Error(String(err))));
    return outgoing.stream;
  };
}
