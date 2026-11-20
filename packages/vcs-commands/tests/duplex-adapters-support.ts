/**
 * Test plumbing for the duplex adapters' conformance matrix: an in-memory transport `Duplex`
 * pair, an in-memory libp2p-shaped stream pair, a meter of the bytes in flight between two
 * duplexes, and the `ext::` bridge that lets native git reach a WebSocket server.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Duplex, Libp2pStreamLike } from "@statewalker/vcs-transport";

/** A one-way bounded channel of chunks: `push` waits while `limit` bytes wait. */
function channel(limit = 1 << 20): {
  push(chunk: Uint8Array): Promise<void>;
  end(): void;
  iterate(): AsyncGenerator<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  let queued = 0;
  let ended = false;
  let wakeReader: (() => void) | undefined;
  let wakeWriters: Array<() => void> = [];
  const notify = () => {
    wakeReader?.();
    wakeReader = undefined;
  };
  return {
    async push(chunk) {
      if (ended || chunk.length === 0) return;
      chunks.push(chunk);
      queued += chunk.length;
      notify();
      while (queued >= limit && !ended) {
        await new Promise<void>((resolve) => wakeWriters.push(resolve));
      }
    },
    end() {
      ended = true;
      notify();
      for (const w of wakeWriters) w();
      wakeWriters = [];
    },
    async *iterate() {
      while (true) {
        const next = chunks.shift();
        if (next) {
          queued -= next.length;
          const waiting = wakeWriters;
          wakeWriters = [];
          for (const w of waiting) w();
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wakeReader = resolve;
        });
      }
    },
  };
}

/** Two connected transport duplexes, bounded each way, `end` a half-close. */
export function duplexPair(): [Duplex, Duplex] {
  const ab = channel();
  const ba = channel();
  const side = (out: ReturnType<typeof channel>, inp: ReturnType<typeof channel>): Duplex => {
    const incoming = inp.iterate();
    return {
      [Symbol.asyncIterator]: () => incoming,
      write: (data) => out.push(data.slice()),
      end: async () => out.end(),
      close: async () => {
        out.end();
        inp.end();
      },
    };
  };
  return [side(ab, ba), side(ba, ab)];
}

/** Two connected libp2p-shaped streams (`source`, `sink`, `closeWrite`, `close`). */
export function libp2pStreamPair(): [
  Libp2pStreamLike & { writeClosed: boolean },
  Libp2pStreamLike,
] {
  const ab = channel();
  const ba = channel();
  const side = (out: ReturnType<typeof channel>, inp: ReturnType<typeof channel>) => {
    const stream = {
      writeClosed: false,
      // a Uint8ArrayList-like chunk, as libp2p's yamux yields
      source: (async function* () {
        for await (const chunk of inp.iterate()) yield { subarray: () => chunk };
      })(),
      async sink(source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) await out.push(chunk.slice());
        out.end();
      },
      async closeWrite() {
        stream.writeClosed = true;
        out.end();
      },
      async close() {
        out.end();
        inp.end();
      },
    };
    return stream;
  };
  return [side(ab, ba), side(ba, ab)];
}

/**
 * Counts the bytes written to and read from two duplexes, the ends of one session, and keeps
 * the most that were ever in flight each way (written by one, not yet read by the other): what
 * the adapters between them buffered.
 */
export function bytesInFlightMeter() {
  const counts = { clientWritten: 0, clientRead: 0, serverWritten: 0, serverRead: 0 };
  const peak = { upstream: 0, downstream: 0 };
  const update = () => {
    peak.upstream = Math.max(peak.upstream, counts.clientWritten - counts.serverRead);
    peak.downstream = Math.max(peak.downstream, counts.serverWritten - counts.clientRead);
  };
  const wrap = (
    duplex: Duplex,
    written: "clientWritten" | "serverWritten",
    read: "clientRead" | "serverRead",
  ): Duplex => {
    const source = duplex[Symbol.asyncIterator]();
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        const r = await source.next();
        if (!r.done) {
          counts[read] += r.value.length;
          update();
        }
        return r;
      },
      return: async () => (await source.return?.()) ?? { done: true, value: undefined },
    };
    return {
      [Symbol.asyncIterator]: () => iterator,
      write(data) {
        counts[written] += data.length;
        update();
        return duplex.write(data);
      },
      ...(duplex.end ? { end: () => duplex.end?.() ?? Promise.resolve() } : {}),
      ...(duplex.close ? { close: () => duplex.close?.() ?? Promise.resolve() } : {}),
    };
  };
  return {
    counts,
    peak,
    client: (duplex: Duplex) => wrap(duplex, "clientWritten", "clientRead"),
    server: (duplex: Duplex) => wrap(duplex, "serverWritten", "serverRead"),
  };
}

/**
 * A script for git's `ext::` remote helper: connects git's stdio to a WebSocket (Node's
 * global one), raw binary frames, an empty frame for the end of either direction (the
 * adapter's half-close). `ext::node <script> ws://host/ %G/<repo>` makes git send the
 * git-daemon request line itself.
 */
export function writeWebSocketBridge(dir: string): string {
  const path = join(dir, "ws-bridge.mjs");
  writeFileSync(
    path,
    `const ws = new WebSocket(process.argv[2]);
ws.binaryType = "arraybuffer";
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  process.stdout.end(() => process.exit(code));
};
ws.addEventListener("open", () => {
  process.stdin.on("data", (d) => ws.send(d));
  process.stdin.on("end", () => ws.send(new Uint8Array(0)));
});
ws.addEventListener("message", (e) => {
  const bytes = new Uint8Array(e.data);
  if (bytes.length === 0) finish(0);
  else process.stdout.write(bytes);
});
ws.addEventListener("close", () => finish(0));
ws.addEventListener("error", () => finish(1));
`,
  );
  chmodSync(path, 0o755);
  return path;
}
