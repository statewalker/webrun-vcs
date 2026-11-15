import { describe, expect, it } from "vitest";
import {
  chunkHash,
  chunkStream,
  downloadXetFile,
  type FetchRange,
  fileHash,
  hashFromString,
  hashToString,
  httpRanges,
  lz4FrameDecode,
  lz4FrameEncode,
  rangeHash,
  readXorbChunks,
  reconstruct,
  type Shard,
  verifierFromShard,
  writeXorb,
  type XetFetch,
  XetIntegrityError,
  type XetToken,
  xetTokenSource,
} from "../../src/index.js";
import { collect, fixture, fixtureBytes, rangedResponse, syntheticXorb } from "./helpers.js";

// Regression tests for the P3.9 review findings (reviewer repros ported).

const rnd = (n: number, seed: number) => {
  const d = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    d[i] = x & 255;
  }
  return d;
};
/** fetchRange over xorbs named by their `xorb://<name>` URL */
const mem = (xorbs: Record<string, Uint8Array>): FetchRange =>
  async function* (url, s, e) {
    yield (xorbs[url.slice(7)] as Uint8Array).subarray(s, e + 1);
  };

describe("review 1: downloadXetFile checks a whole file against its Xet hash and size", () => {
  /** a fake Hub + CAS + CDN that answers for `fileHash` with the xorb of `served` */
  async function hub(o: { claimed: Uint8Array; served: Uint8Array; size?: number }) {
    const want = await syntheticXorb(o.claimed);
    const got = await syntheticXorb(o.served);
    const F = hashToString(fileHash(want.refs));
    const n = got.chunks.length;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/paths-info/"))
        return Response.json([
          { path: "f", type: "file", size: o.size ?? o.claimed.length, xetHash: F },
        ]);
      if (url.includes("/xet-read-token/"))
        return Response.json({ casUrl: "https://cas.test", accessToken: "t", exp: 0 });
      if (url.startsWith("https://cas.test/v2/"))
        return Response.json({
          offset_into_first_range: 0,
          terms: [
            { hash: got.name, unpacked_length: o.served.length, range: { start: 0, end: n } },
          ],
          xorbs: {
            [got.name]: [
              {
                url: "https://cdn.test/x",
                ranges: [
                  { chunks: { start: 0, end: n }, bytes: { start: 0, end: got.xorb.length - 1 } },
                ],
              },
            ],
          },
        });
      return rangedResponse(got.xorb, new Headers(init?.headers).get("range"));
    }) as typeof fetch;
    return { fetch: f, F };
  }

  it("a CAS serving another file: refused at the end by default; passes only with verifyFile: false", async () => {
    const { fetch } = await hub({ claimed: rnd(300_000, 1), served: rnd(300_000, 2) });
    await expect(collect(downloadXetFile({ repo: "a/b", fetch }, "f"))).rejects.toThrow(
      XetIntegrityError,
    );
    const out = await collect(downloadXetFile({ repo: "a/b", fetch }, "f", { verifyFile: false }));
    expect(out.length).toBe(300_000);
  });

  it("the right file passes; a size the Hub did not announce is refused", async () => {
    const data = rnd(300_000, 3);
    const ok = await hub({ claimed: data, served: data });
    expect((await collect(downloadXetFile({ repo: "a/b", fetch: ok.fetch }, "f"))).length).toBe(
      300_000,
    );
    const wrong = await hub({ claimed: data, served: data, size: 299_999 });
    await expect(
      collect(downloadXetFile({ repo: "a/b", fetch: wrong.fetch }, "f")),
    ).rejects.toThrow(/size/);
    // with only the hash given (no paths-info), the hash is still checked
    const other = await hub({ claimed: data, served: rnd(300_000, 4) });
    await expect(
      collect(downloadXetFile({ repo: "a/b", fetch: other.fetch }, "f", { xetHash: other.F })),
    ).rejects.toThrow(XetIntegrityError);
  });
});

describe("review 2: verifierFromShard with a file hash is strict and whole-file by default", () => {
  async function setup() {
    const real = await syntheticXorb(rnd(300_000, 1), { name: "aa".repeat(32) });
    const fake = await syntheticXorb(rnd(300_000, 2), { name: "bb".repeat(32) });
    const fh = fileHash(real.refs);
    const shard: Shard = {
      files: [
        {
          fileHash: fh,
          terms: [
            {
              xorbHash: hashFromString(real.name),
              bytes: 300_000,
              start: 0,
              end: real.chunks.length,
              rangeHash: rangeHash(real.refs.map((r) => r.hash)),
            },
          ],
        },
      ],
      xorbs: [{ xorbHash: hashFromString(real.name), chunks: real.refs }],
    };
    return { real, fake, fh, shard };
  }
  const run = async (it: AsyncIterable<Uint8Array>) => {
    let got = 0;
    try {
      for await (const p of it) got += p.length;
      return { got };
    } catch (e) {
      return { got, error: e as Error };
    }
  };

  it("a foreign xorb is refused before any of its bytes", async () => {
    const { fake, fh, shard } = await setup();
    const r = await run(
      reconstruct(fake.answer, mem({ [fake.name]: fake.xorb }), {
        verify: verifierFromShard(shard, fh),
      }),
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(r.got).toBe(0);
  });

  it("an answer of no terms is refused, not an empty file", async () => {
    const { real, fh, shard } = await setup();
    const r = await run(
      reconstruct({ ...real.answer, terms: [] }, mem({ [real.name]: real.xorb }), {
        verify: verifierFromShard(shard, fh),
      }),
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(r.error?.message).toMatch(/0 terms.*1/);
  });

  it("a term list that differs is refused up front, with a message naming the difference", async () => {
    const { real, fh, shard } = await setup();
    const shifted = {
      ...real.answer,
      terms: [
        {
          ...(real.answer.terms[0] as (typeof real.answer.terms)[0]),
          range: { start: 1, end: real.chunks.length },
        },
      ],
    };
    const r = await run(
      reconstruct(shifted, mem({ [real.name]: real.xorb }), {
        verify: verifierFromShard(shard, fh),
      }),
    );
    expect(r.got).toBe(0);
    expect(r.error?.message).toMatch(/term 0/);
    expect(r.error?.message).not.toMatch(/1 terms are not the file's 1/);
  });

  it("the right answer passes; explicit options still allow range requests", async () => {
    const { real, fh, shard } = await setup();
    expect(
      (
        await run(
          reconstruct(real.answer, mem({ [real.name]: real.xorb }), {
            verify: verifierFromShard(shard, fh),
          }),
        )
      ).error,
    ).toBeUndefined();
    const part = {
      ...real.answer,
      terms: [
        {
          hash: real.name,
          unpacked_length: real.refs.slice(1).reduce((n, c) => n + c.length, 0),
          range: { start: 1, end: real.chunks.length },
        },
      ],
    };
    expect(
      (
        await run(
          reconstruct(part, mem({ [real.name]: real.xorb }), {
            verify: verifierFromShard(shard, fh, { wholeFile: false }),
          }),
        )
      ).error,
    ).toBeUndefined();
  });
});

describe("review 4: xet-core's chunk limits", () => {
  const one = (b: Uint8Array) =>
    (async function* () {
      yield b;
    })();
  const header = (csize: number, type: number, usize: number) =>
    Uint8Array.from([
      0,
      csize & 255,
      (csize >> 8) & 255,
      (csize >> 16) & 255,
      type,
      usize & 255,
      (usize >> 8) & 255,
      (usize >> 16) & 255,
    ]);

  it("a chunk over 128 KiB uncompressed is refused (stored, or an LZ4 bomb), and never written", async () => {
    const big = rnd(1_000_000, 3);
    const stored = new Uint8Array(8 + big.length);
    stored.set(header(big.length, 0, big.length));
    stored.set(big, 8);
    await expect(collect(readXorbChunks(one(stored)))).rejects.toThrow(/128 KiB/);
    const zeros = lz4FrameEncode(new Uint8Array((1 << 24) - 1));
    const bomb = new Uint8Array(8 + zeros.length);
    bomb.set(header(zeros.length, 1, (1 << 24) - 1));
    bomb.set(zeros, 8);
    await expect(collect(readXorbChunks(one(bomb)))).rejects.toThrow(/128 KiB/);
    expect(() => writeXorb([new Uint8Array(128 * 1024 + 1)])).toThrow(/128 KiB/);
    expect(writeXorb([new Uint8Array(128 * 1024)]).length).toBeGreaterThan(8);
  });

  it("a payload over 256 KiB is refused before it is buffered", async () => {
    const h = header(256 * 1024 + 1, 1, 1000);
    let pulled = 0;
    const src = (async function* () {
      yield h;
      for (;;) {
        pulled += 65536;
        yield new Uint8Array(65536);
      }
    })();
    await expect(collect(readXorbChunks(src))).rejects.toThrow(/256 KiB/);
    expect(pulled).toBe(0);
  });
});

describe("review 5: bounded retries, Retry-After dates, token requests without one caller's signal", () => {
  it("a peer cutting the body every few bytes ends in an error after a bounded number of requests", async () => {
    const data = rnd(1_000_000, 5);
    let calls = 0;
    const f = (async (_u: string, init?: RequestInit) => {
      calls++;
      return rangedResponse(data, new Headers(init?.headers).get("range"), { cutAfter: 10 });
    }) as typeof fetch;
    await expect(
      collect(httpRanges({ fetch: f, backoffMs: 0, retries: 3 })("u", 0, data.length - 1)),
    ).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(64);
  });

  it("a cut every 100 KiB still completes (progress resets the count)", async () => {
    const data = rnd(1_000_000, 6);
    let calls = 0;
    const f = (async (_u: string, init?: RequestInit) => {
      calls++;
      return rangedResponse(data, new Headers(init?.headers).get("range"), {
        cutAfter: 100 * 1024,
      });
    }) as typeof fetch;
    const got = await collect(
      httpRanges({ fetch: f, backoffMs: 0, retries: 2 })("u", 0, data.length - 1),
    );
    expect(got.length).toBe(data.length);
    expect(calls).toBe(10);
  });

  it("Retry-After as an HTTP date is honoured", async () => {
    const data = rnd(100, 7);
    let calls = 0;
    const f = (async (_u: string, init?: RequestInit) =>
      calls++ === 0
        ? new Response("", {
            status: 503,
            headers: { "retry-after": new Date(Date.now() + 2000).toUTCString() },
          })
        : rangedResponse(data, new Headers(init?.headers).get("range"))) as typeof fetch;
    const t0 = Date.now();
    await collect(httpRanges({ fetch: f, backoffMs: 1 })("u", 0, 9));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("one caller aborting does not abort the token request others wait for", async () => {
    let seen: AbortSignal | undefined;
    let release: (t: XetToken) => void = () => {};
    const source = xetTokenSource(
      (signal) =>
        new Promise<XetToken>((resolve) => {
          seen = signal;
          release = resolve;
        }),
    );
    const ac = new AbortController();
    const a = source.token(ac.signal);
    const b = source.token();
    ac.abort(new Error("stop A"));
    await expect(a).rejects.toThrow(/stop A/);
    expect(seen?.aborted).toBe(false);
    release({ casUrl: "c", accessToken: "t", exp: 0 });
    expect((await b).accessToken).toBe("t");
  });

  it("when every caller gives up, the token request is aborted", async () => {
    let seen: AbortSignal | undefined;
    const source = xetTokenSource((signal) => {
      seen = signal;
      return new Promise<XetToken>(() => {});
    });
    const ac = new AbortController();
    const a = source.token(ac.signal);
    ac.abort(new Error("stop"));
    await expect(a).rejects.toThrow(/stop/);
    expect(seen?.aborted).toBe(true);
  });
});

describe("review: streaming hygiene (reviewer repros)", () => {
  it("a consumer that breaks off cancels the HTTP body", async () => {
    const s = await syntheticXorb(rnd(2_000_000, 7), { compression: "none" });
    let cancelled = 0;
    const f: XetFetch = async (_u, init) => {
      const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
      const [a, b] = [Number(m?.[1]), Number(m?.[2])];
      const slice = s.xorb.subarray(a, b + 1);
      let at = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (at >= slice.length) return c.close();
            c.enqueue(slice.subarray(at, at + 4096));
            at += 4096;
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 206, headers: { "content-range": `bytes ${a}-${b}/${s.xorb.length}` } },
      );
    };
    for await (const _ of reconstruct(s.answer, httpRanges({ fetch: f }))) break;
    expect(cancelled).toBe(1);
  });

  it("20,000 mutated LZ4 frames only throw lz4 errors, never hang", { timeout: 60_000 }, () => {
    const base = rnd(50_000, 4);
    for (let i = 0; i < base.length; i++) if (i % 7) base[i] = base[i - (i % 7)] as number;
    const f = lz4FrameEncode(base);
    let x = 99;
    const r = () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return x >>> 0;
    };
    for (let k = 0; k < 20_000; k++) {
      const m = f.slice();
      const n = 1 + (r() % 4);
      for (let j = 0; j < n; j++) m[7 + (r() % (m.length - 7))] = r() & 255;
      try {
        lz4FrameDecode(m, base.length);
      } catch (e) {
        if (!(e instanceof Error) || e.constructor !== Error || !e.message.startsWith("lz4"))
          throw e;
      }
    }
  });
});

describe("review 7: real xet-core output committed (runs in CI without the reference xorb)", () => {
  const meta = JSON.parse(fixture("eea25d6e-chunks-18-21.json")) as {
    referenceChunks: { hash: string; length: number }[];
  };
  const bytes = fixtureBytes("eea25d6e-chunks-18-21.xorb-range");

  it("chunks 18-20 of the reference xorb (lz4_flex frames) decode to the reference chunk hashes", async () => {
    const chunks = await collect(
      readXorbChunks(
        (async function* () {
          for (let at = 0; at < bytes.length; at += 1000) yield bytes.subarray(at, at + 1000);
        })(),
      ),
    );
    expect(chunks.length).toBe(18_717 + 15_399 + 12_618);
    const got: string[] = [];
    for await (const c of readXorbChunks(
      (async function* () {
        yield bytes;
      })(),
    ))
      got.push(`${hashToString(chunkHash(c))} ${c.length}`);
    expect(got).toEqual(meta.referenceChunks.map((c) => `${c.hash} ${c.length}`));
  });

  it("chunking their bytes finds xet-core's boundaries (independent of our gear table copy)", async () => {
    const parts: Uint8Array[] = [];
    for await (const c of readXorbChunks(
      (async function* () {
        yield bytes;
      })(),
    ))
      parts.push(c);
    const lengths: number[] = [];
    for await (const c of chunkStream(parts)) lengths.push(c.length);
    expect(lengths).toEqual(meta.referenceChunks.map((c) => c.length));
  });
});
