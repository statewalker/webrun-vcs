import { randomBytes } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CompressionError,
  createInflater,
  createInflaterPool,
  decompressBlockPartial,
  InflateError,
  type InflaterPool,
  type StreamInflater,
  TruncatedStreamError,
} from "../../../src/compression/index.js";

const enc = new TextEncoder();
const CHUNK_SIZES = [1, 2, 7, 64, 4096, Number.MAX_SAFE_INTEGER];

function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Inflate `count` consecutive streams from `chunks`; returns outputs and exact compressed lengths. */
function inflateAll(
  acquire: () => StreamInflater,
  chunks: Iterable<Uint8Array>,
  count: number,
): Array<{ data: Uint8Array; compressedLength: number }> {
  const results: Array<{ data: Uint8Array; compressedLength: number }> = [];
  let inf: StreamInflater | undefined;
  let out: Uint8Array[] = [];
  let consumed = 0;
  for (let chunk of chunks) {
    while (chunk.length > 0 && results.length < count) {
      inf ??= acquire();
      const r = inf.push(chunk);
      out.push(...r.out);
      consumed += r.consumed;
      chunk = chunk.subarray(r.consumed);
      if (r.done) {
        inf.end();
        results.push({ data: concat(out), compressedLength: consumed });
        inf = undefined;
        out = [];
        consumed = 0;
      }
    }
  }
  return results;
}

// Mixed sizes and compressibility, as in a pack: empty, tiny, text, random, 64 KiB.
const inputs = Array.from({ length: 70 }, (_, i) => {
  const size = [0, 1, 37, 200, 1000, 4096, 65536][i % 7] ?? 0;
  return i % 3 === 0 ? new Uint8Array(randomBytes(size)) : enc.encode("x".repeat(size));
});
const streams = inputs.map((b) => new Uint8Array(deflateSync(b)));
const all = concat([...streams, enc.encode("TRAILING")]);

describe("createInflater: exact stream ends under every chunking", () => {
  for (const size of CHUNK_SIZES) {
    it(`chunk size ${size === Number.MAX_SAFE_INTEGER ? "whole" : size}`, () => {
      const results = inflateAll(() => createInflater(), chunked(all, size), streams.length);
      expect(results).toHaveLength(streams.length);
      results.forEach((r, i) => {
        expect(eq(r.data, inputs[i] ?? new Uint8Array()), `stream ${i}`).toBe(true);
        expect(r.compressedLength, `stream ${i}`).toBe(streams[i]?.length);
      });
    });
  }
});

describe("createInflater: truncation is never reported as done", () => {
  const z = new Uint8Array(deflateSync(enc.encode("payload ".repeat(2000))));
  for (const cut of [1, 2, Math.floor(z.length / 2), z.length - 4, z.length - 1]) {
    it(`cut at ${cut} of ${z.length}`, () => {
      const inf = createInflater();
      let done = false;
      for (const c of chunked(z.subarray(0, cut), 7)) done = inf.push(c).done || done;
      expect(done).toBe(false);
      expect(() => inf.end()).toThrow(TruncatedStreamError);
    });
  }
});

describe("createInflater: corruption is an error", () => {
  const z = new Uint8Array(deflateSync(enc.encode("payload ".repeat(2000))));
  it("a flipped byte in the Adler-32 trailer", () => {
    const bad = z.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const inf = createInflater();
    expect(() => {
      for (const c of chunked(bad, 64)) inf.push(c);
      inf.end();
    }).toThrow(InflateError);
  });
  it("a garbage body", () => {
    const bad = concat([z.subarray(0, 2), new Uint8Array(200).fill(0xff)]);
    const inf = createInflater();
    expect(() => {
      for (const c of chunked(bad, 64)) inf.push(c);
      inf.end();
    }).toThrow(InflateError);
  });
  it("both errors are CompressionErrors", () => {
    expect(new InflateError("x")).toBeInstanceOf(CompressionError);
    expect(new TruncatedStreamError("x")).toBeInstanceOf(CompressionError);
  });
});

describe("createInflater: raw deflate", () => {
  it("finds the exact end of a raw stream followed by other bytes", () => {
    const input = enc.encode("raw deflate ".repeat(300));
    const z = new Uint8Array(deflateRawSync(input));
    const [r] = inflateAll(
      () => createInflater({ raw: true }),
      chunked(concat([z, Uint8Array.of(7, 7, 7)]), 5),
      1,
    );
    expect(r?.compressedLength).toBe(z.length);
    expect(r && eq(r.data, input)).toBe(true);
  });
  it("keeps raw and zlib states apart in the pool", () => {
    const pool = createInflaterPool();
    const zlibIn = enc.encode("zlib ".repeat(100));
    const rawIn = enc.encode("raw ".repeat(100));
    for (let i = 0; i < 3; i++) {
      const [a] = inflateAll(() => pool.acquire(), [new Uint8Array(deflateSync(zlibIn))], 1);
      const [b] = inflateAll(
        () => pool.acquire({ raw: true }),
        [new Uint8Array(deflateRawSync(rawIn))],
        1,
      );
      expect(a && eq(a.data, zlibIn)).toBe(true);
      expect(b && eq(b.data, rawIn)).toBe(true);
    }
    expect(pool.allocated).toBe(2);
  });
});

describe("createInflater: output is copied, never a view of a shared buffer", () => {
  it("4 KiB of incompressible output pushed a byte at a time keeps arrayBuffers small", () => {
    const input = new Uint8Array(randomBytes(4096));
    const z = new Uint8Array(deflateSync(input));
    const base = process.memoryUsage().arrayBuffers;
    const kept: Uint8Array[] = [];
    const inf = createInflater();
    for (const c of chunked(z, 1)) kept.push(...inf.push(c).out);
    inf.end();
    // Views of a 64 KiB buffer per push would pin ~256 MiB here.
    expect(process.memoryUsage().arrayBuffers - base).toBeLessThan(32 * 1024 * 1024);
    expect(eq(concat(kept), input)).toBe(true);
  });
});

describe("createInflaterPool: state reuse (JGit InflaterCache)", () => {
  it("one state serves many sequential streams", () => {
    const pool = createInflaterPool();
    const results = inflateAll(() => pool.acquire(), [all], streams.length);
    expect(results).toHaveLength(streams.length);
    expect(pool.allocated).toBe(1);
  });

  it("keeps at most 4 idle states", () => {
    const pool = createInflaterPool();
    const held = Array.from({ length: 6 }, () => pool.acquire());
    for (const inf of held) {
      inf.push(streams[1] ?? new Uint8Array());
      inf.end();
    }
    expect(pool.idle).toBe(4);
    for (let i = 0; i < 6; i++) pool.acquire();
    expect(pool.allocated).toBe(8);
  });

  const good = streams[4] ?? new Uint8Array();
  const goodInput = inputs[4] ?? new Uint8Array();

  it("reuses a clean state after truncation", () => {
    const pool = createInflaterPool();
    const a = pool.acquire();
    a.push(good.subarray(0, Math.floor(good.length / 2)));
    expect(() => a.end()).toThrow(TruncatedStreamError);
    const [r] = inflateAll(() => pool.acquire(), [good], 1);
    expect(r && eq(r.data, goodInput)).toBe(true);
    expect(r?.compressedLength).toBe(good.length);
    expect(pool.allocated).toBe(1);
  });

  it("reuses a clean state after corruption", () => {
    const pool = createInflaterPool();
    const bad = good.slice();
    bad[0] = (bad[0] ?? 0) ^ 0xff;
    const a = pool.acquire();
    expect(() => a.push(bad)).toThrow(InflateError);
    const [r] = inflateAll(() => pool.acquire(), [good], 1);
    expect(r && eq(r.data, goodInput)).toBe(true);
    expect(pool.allocated).toBe(1);
  });

  it("gives concurrent inflaters distinct states", () => {
    const pool = createInflaterPool();
    const [s1, s2] = [streams[5] ?? new Uint8Array(), streams[6] ?? new Uint8Array()];
    const a = pool.acquire();
    const b = pool.acquire();
    const outA: Uint8Array[] = [];
    const outB: Uint8Array[] = [];
    const ca = [...chunked(s1, 3)];
    const cb = [...chunked(s2, 3)];
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
      const x = ca[i];
      const y = cb[i];
      if (x) outA.push(...a.push(x).out);
      if (y) outB.push(...b.push(y).out);
    }
    a.end();
    b.end();
    expect(eq(concat(outA), inputs[5] ?? new Uint8Array())).toBe(true);
    expect(eq(concat(outB), inputs[6] ?? new Uint8Array())).toBe(true);
    expect(pool.allocated).toBe(2);
  });

  it("refuses a push after the stream ended, even when the state now serves another", () => {
    const pool = createInflaterPool();
    const a = pool.acquire();
    a.push(streams[1] ?? new Uint8Array());
    a.end();
    expect(() => a.push(Uint8Array.of(1))).toThrow(/inflater is closed/);
    const b = pool.acquire(); // reuses a's state
    const parts = [...chunked(good, 5)];
    const out: Uint8Array[] = [...b.push(parts[0] ?? new Uint8Array()).out];
    expect(() => a.push(Uint8Array.of(0x78, 0x9c))).toThrow(/inflater is closed/);
    for (const p of parts.slice(1)) out.push(...b.push(p).out);
    b.end();
    expect(eq(concat(out), goodInput)).toBe(true);
  });

  it("does not keep the caller's last input alive in an idle state", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const pool = createInflaterPool();
    const ref = (() => {
      const big = concat([good, new Uint8Array(4 << 20)]);
      const inf = pool.acquire();
      inf.push(big); // the stream ends inside `big`; the rest is someone else's data
      inf.end();
      return new WeakRef(big);
    })();
    expect(pool.idle).toBe(1);
    for (let i = 0; i < 5 && ref.deref(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

describe("createInflater: closing and edge cases", () => {
  const z = new Uint8Array(deflateSync(enc.encode("edge ".repeat(500))));

  it("detects truncation of a raw stream", () => {
    const raw = new Uint8Array(deflateRawSync(enc.encode("raw ".repeat(500))));
    const inf = createInflater({ raw: true });
    expect(inf.push(raw.subarray(0, raw.length - 1)).done).toBe(false);
    expect(() => inf.end()).toThrow(TruncatedStreamError);
  });

  it("treats an empty chunk as a no-op", () => {
    const inf = createInflater();
    expect(inf.push(new Uint8Array(0))).toEqual({ out: [], done: false, consumed: 0 });
    const r = inf.push(z);
    expect(r.done).toBe(true);
    expect(r.consumed).toBe(z.length);
  });

  it("is closed after a failed push: end() is quiet, push() throws a CompressionError", () => {
    const pool = createInflaterPool();
    const inf = pool.acquire();
    const bad = z.slice();
    bad[0] = 0;
    expect(() => inf.push(bad)).toThrow(InflateError);
    expect(() => inf.end()).not.toThrow();
    const err = (() => {
      try {
        inf.push(z);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CompressionError);
    expect(err).not.toBeInstanceOf(InflateError);
    expect(String(err)).toMatch(/inflater is closed/);
    expect(pool.idle).toBe(1);
  });

  it("abort() returns the state without an error, and closes the inflater", () => {
    const pool = createInflaterPool();
    const inf = pool.acquire();
    inf.push(z.subarray(0, 10));
    expect(() => inf.abort()).not.toThrow();
    expect(() => inf.abort()).not.toThrow();
    expect(() => inf.push(z)).toThrow(/inflater is closed/);
    const [r] = inflateAll(() => pool.acquire(), [z], 1);
    expect(r?.compressedLength).toBe(z.length);
    expect(pool.allocated).toBe(1);
  });

  it("caps idle states per format: 4 zlib and 4 raw", () => {
    const pool = createInflaterPool();
    const raw = new Uint8Array(deflateRawSync(enc.encode("r")));
    const held = [
      ...Array.from({ length: 5 }, () => [pool.acquire(), z] as const),
      ...Array.from({ length: 5 }, () => [pool.acquire({ raw: true }), raw] as const),
    ];
    for (const [inf, bytes] of held) {
      inf.push(bytes);
      inf.end();
    }
    expect(pool.idle).toBe(8);
  });

  it("names a stream that needs a preset dictionary", () => {
    // zlib header with FDICT set (0x78 0xbb) followed by a dictionary id.
    const inf = createInflater();
    expect(() => inf.push(Uint8Array.of(0x78, 0xbb, 0, 0, 0, 1, 3, 0))).toThrow(
      /preset dictionary/,
    );
  });
});

describe("decompressBlockPartial on the push inflater", () => {
  const data = enc.encode("hello world ".repeat(1000));
  const z = new Uint8Array(deflateSync(data));

  it("returns the data and the exact compressed length, ignoring what follows", async () => {
    const r = await decompressBlockPartial(concat([z, enc.encode("NEXT OBJECT")]));
    expect(eq(r.data, data)).toBe(true);
    expect(r.bytesRead).toBe(z.length);
  });

  it("rejects truncated input instead of returning short data", async () => {
    await expect(decompressBlockPartial(z.subarray(0, Math.floor(z.length / 2)))).rejects.toThrow(
      TruncatedStreamError,
    );
  });

  it("rejects corrupt input", async () => {
    const bad = z.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    await expect(decompressBlockPartial(bad)).rejects.toThrow(InflateError);
  });
});

/** Keeps the pool type referenced so the export is checked by the typecheck run. */
export type _PoolType = InflaterPool;
