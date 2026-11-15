/**
 * The pkt-line readers behind TransportApi and the git:// request parser keep
 * received bytes as a queue of chunks, so a packet arriving in many small chunks
 * is read in time linear in its size (not by copying the whole buffer per chunk).
 *
 * Timing is compared as a ratio (4x the input must take less than ~9x as long),
 * not against a wall-clock bound a loaded machine could miss.
 */
import { describe, expect, it } from "vitest";
import type { Duplex } from "../src/api/duplex.js";
import { ProtocolState } from "../src/context/protocol-state.js";
import { createTransportApi } from "../src/factories/transport-api-factory.js";
import {
  encodeGitProtocolRequest,
  readGitProtocolRequest,
} from "../src/protocol/git-request-parser.js";
import { encodeFlush, encodePacket } from "../src/protocol/pkt-line-codec.js";

function* inChunks(data: Uint8Array, size: number): Generator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function duplexOf(chunks: Iterable<Uint8Array>): Duplex {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    write() {},
  };
}

/**
 * Bytes copied with `Uint8Array.prototype.set` while `fn` runs: a measure of the
 * work that does not depend on the machine. Copying the whole buffer per chunk
 * makes it grow with the square of the input.
 */
async function bytesCopied(fn: () => Promise<unknown>): Promise<number> {
  const original = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.set = function (this: Uint8Array, src: ArrayLike<number>, offset?: number) {
    copied += src.length;
    return original.call(this, src, offset);
  } as typeof original;
  try {
    await fn();
  } finally {
    Uint8Array.prototype.set = original;
  }
  return copied;
}

/** The best of a few runs, so one slow run (GC, a busy machine) does not decide. */
async function bestOf(runs: number, fn: () => Promise<void>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await fn();
    best = Math.min(best, performance.now() - started);
  }
  return Math.max(best, 0.5);
}

describe("TransportApi.readPktLine", () => {
  const wire = (size: number, count: number) =>
    join([
      ...Array.from({ length: count }, (_, i) =>
        encodePacket("z".repeat(size - 1) + String(i % 10)),
      ),
      encodeFlush(),
    ]);

  async function readAll(data: Uint8Array, chunk: number): Promise<number> {
    const api = createTransportApi(duplexOf(inChunks(data, chunk)), new ProtocolState());
    let n = 0;
    while (true) {
      const pkt = await api.readPktLine();
      if (pkt.type === "flush") return n;
      if (pkt.type !== "data") throw new Error(`unexpected ${pkt.type}`);
      n++;
    }
  }

  it("reads packets split across many chunks, and data left over for a raw stream", async () => {
    const data = join([encodePacket("hello\n"), encodePacket("world\n"), encodeFlush()]);
    const api = createTransportApi(duplexOf(inChunks(data, 3)), new ProtocolState());
    const first = await api.readPktLine();
    expect(first.type === "data" && first.text).toBe("hello");
    const second = await api.readPktLine();
    expect(second.type === "data" && second.text).toBe("world");
    expect((await api.readPktLine()).type).toBe("flush");
    expect((await api.readPktLine()).type).toBe("eof");
  });

  it("reports 0002 (response-end) clearly instead of as a bad length", async () => {
    const api = createTransportApi(
      duplexOf([new TextEncoder().encode("0002")]),
      new ProtocolState(),
    );
    await expect(api.readPktLine()).rejects.toThrow("response-end");
  });

  it("reads a large packet in small chunks in linear time", async () => {
    const small = wire(16_000, 8);
    const large = wire(64_000, 8);
    expect(await readAll(small, 16)).toBe(8);
    await readAll(small, 16); // warm up
    const t1 = await bestOf(3, async () => void (await readAll(small, 16)));
    const t4 = await bestOf(3, async () => void (await readAll(large, 16)));
    expect(t4 / t1).toBeLessThan(9);
  }, 60_000);

  it("copies each byte a bounded number of times, whatever the chunking", async () => {
    const c1 = await bytesCopied(() => readAll(wire(16_000, 2), 16));
    const c4 = await bytesCopied(() => readAll(wire(64_000, 2), 16));
    expect(c4 / c1).toBeLessThan(9);
  });
});

describe("readGitProtocolRequest", () => {
  const request = (size: number) =>
    encodeGitProtocolRequest({
      service: "git-upload-pack",
      path: "/repo.git",
      host: "example.com",
      extraParams: new Map([["pad", "p".repeat(size)]]),
    });

  it("parses a request split across many chunks", async () => {
    const parsed = await readGitProtocolRequest(duplexOf(inChunks(request(100), 3)));
    expect(parsed.path).toBe("/repo.git");
    expect(parsed.extraParams?.get("pad")).toBe("p".repeat(100));
  });

  it("reads a large request in small chunks in linear time", async () => {
    const small = request(16_000);
    const large = request(64_000);
    const run = (data: Uint8Array) => async () => {
      for (let i = 0; i < 8; i++) await readGitProtocolRequest(duplexOf(inChunks(data, 8)));
    };
    await run(small)(); // warm up
    const t1 = await bestOf(3, run(small));
    const t4 = await bestOf(3, run(large));
    expect(t4 / t1).toBeLessThan(9);
  }, 60_000);

  it("copies each byte a bounded number of times, whatever the chunking", async () => {
    const c1 = await bytesCopied(() =>
      readGitProtocolRequest(duplexOf(inChunks(request(16_000), 8))),
    );
    const c4 = await bytesCopied(() =>
      readGitProtocolRequest(duplexOf(inChunks(request(64_000), 8))),
    );
    expect(c4 / c1).toBeLessThan(9);
  });
});
