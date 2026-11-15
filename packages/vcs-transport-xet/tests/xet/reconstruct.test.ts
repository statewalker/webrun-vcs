import { describe, expect, it } from "vitest";
import {
  bg4Regroup,
  bg4Split,
  type ChunkRef,
  chunkHash,
  chunkStream,
  fileHash,
  hashToString,
  type ReconstructionAnswer,
  type ReconstructionVerifier,
  rangeHash,
  readXorbChunks,
  reconstruct,
  type Shard,
  verifierFromShard,
  writeXorb,
  XetIntegrityError,
  XORB_MAX_CHUNKS,
  xorbHash,
} from "../../src/index.js";
import { memoryRanges, syntheticData, syntheticXorb } from "./helpers.js";

// Offline counterparts of H3/H4/H6/H8/U3/U5 on a generated file (the reference xorb is not
// committed; tests/xet/reference.test.ts runs the same checks on it when it is available).

describe("H3 + H4 (synthetic) reconstruction of a generated file", () => {
  for (const compression of ["lz4", "bg4-lz4", "none"] as const)
    it(`${compression}: rebuilt chunk by chunk, same chunk hashes and file hash`, async () => {
      const data = syntheticData(1_500_000, 7);
      const { refs, xorb, answer } = await syntheticXorb(data, { compression });
      expect(refs.length).toBeGreaterThan(10);
      if (compression !== "none") expect(xorb.length).toBeLessThan(data.length);
      const got: ChunkRef[] = [];
      for await (const c of chunkStream(reconstruct(answer, memoryRanges(xorb, 4096))))
        got.push({ hash: chunkHash(c), length: c.length });
      expect(got.map((c) => hashToString(c.hash))).toEqual(refs.map((c) => hashToString(c.hash)));
      expect(hashToString(fileHash(got))).toBe(hashToString(fileHash(refs)));
    });

  it("streams: the first bytes come out before the fetched range is read to its end", async () => {
    const data = syntheticData(2_000_000, 3);
    const { xorb, answer } = await syntheticXorb(data);
    let served = 0;
    const ranges = async function* (_u: string, start: number, end: number) {
      for (let at = start; at <= end; at += 1024) {
        served = Math.min(end + 1, at + 1024) - start;
        yield xorb.subarray(at, Math.min(end + 1, at + 1024));
      }
    };
    const it = reconstruct(answer, ranges)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value?.length).toBeLessThanOrEqual(128 * 1024);
    // one chunk's compressed bytes and a piece, not the xorb
    expect(served).toBeLessThan(xorb.length / 4);
    await it.return?.(undefined);
  });
});

describe("H6 + H8 (synthetic) ranges, lengths, tails", () => {
  it("a term over a chunk sub-range with an offset into it: the matching slice", async () => {
    const data = syntheticData(1_200_000, 11);
    const { refs, xorb, answer } = await syntheticXorb(data);
    const startByte = refs.slice(0, 3).reduce((n, c) => n + c.length, 0);
    const length = refs.slice(3, 8).reduce((n, c) => n + c.length, 0);
    const term = { ...answer.terms[0], unpacked_length: length, range: { start: 3, end: 8 } };
    const parts: Uint8Array[] = [];
    for await (const p of reconstruct(
      { ...answer, offset_into_first_range: 1234, terms: [term] } as ReconstructionAnswer,
      memoryRanges(xorb),
    ))
      parts.push(p);
    const got = Buffer.concat(parts);
    expect(got.equals(Buffer.from(data.subarray(startByte + 1234, startByte + length)))).toBe(true);
  });

  it("a fetch range taking in a XETB tail; a requested length truncating the last term", async () => {
    const data = syntheticData(600_000, 5);
    const { xorb, answer } = await syntheticXorb(data);
    const tailed = new Uint8Array(xorb.length + 8);
    tailed.set(xorb);
    tailed.set([0x58, 0x45, 0x54, 0x42, 1, 2, 3, 4], xorb.length);
    const entry = answer.fetch_info[answer.terms[0]?.hash as string]?.[0];
    if (entry) entry.url_range = { start: 0, end: tailed.length - 1 };
    let size = 0;
    for await (const p of reconstruct(answer, memoryRanges(tailed))) size += p.length;
    expect(size).toBe(data.length);
    size = 0;
    for await (const p of reconstruct(answer, memoryRanges(tailed), { length: 100_003 }))
      size += p.length;
    expect(size).toBe(100_003);
  });

  it("the fetched body is closed when a term ends before its fetch range", async () => {
    const data = syntheticData(800_000, 9);
    const { refs, xorb, answer } = await syntheticXorb(data);
    let closed = 0;
    const ranges = async function* (_u: string, start: number, end: number) {
      try {
        yield* memoryRanges(xorb, 4096)(_u, start, end);
      } finally {
        closed++;
      }
    };
    const length = refs.slice(0, 2).reduce((n, c) => n + c.length, 0);
    const term = { ...answer.terms[0], unpacked_length: length, range: { start: 0, end: 2 } };
    let size = 0;
    for await (const p of reconstruct({ ...answer, terms: [term] } as ReconstructionAnswer, ranges))
      size += p.length;
    expect(size).toBe(length);
    expect(closed).toBe(1);
  });

  it("readXorbChunks without a count: every chunk to the end of the stream or a XETB footer", async () => {
    const data = syntheticData(500_000, 13);
    const { chunks, xorb } = await syntheticXorb(data);
    const read = async (bytes: Uint8Array) => {
      const out: Uint8Array[] = [];
      for await (const c of readXorbChunks(memoryRanges(bytes, 777)("", 0, bytes.length - 1)))
        out.push(c);
      return out;
    };
    expect((await read(xorb)).length).toBe(chunks.length);
    const tailed = new Uint8Array(xorb.length + 4);
    tailed.set(xorb);
    tailed.set([0x58, 0x45, 0x54, 0x42], xorb.length);
    expect((await read(tailed)).length).toBe(chunks.length);
    await expect(read(xorb.subarray(0, xorb.length - 1))).rejects.toThrow(/truncated/);
  });
});

describe("U3 (synthetic) xorbs written and read back", () => {
  it("bg4Split is bg4Regroup's inverse", () => {
    for (const n of [0, 1, 5, 4096, 4099]) {
      const d = syntheticData(n, n + 1);
      expect(Buffer.from(bg4Regroup(bg4Split(d))).equals(Buffer.from(d))).toBe(true);
    }
  });

  it("refuses more chunks than a xorb may hold, an empty chunk, more than 64 MiB", () => {
    expect(() =>
      writeXorb(Array.from({ length: XORB_MAX_CHUNKS + 1 }, () => new Uint8Array(1))),
    ).toThrow(/at most 8192/);
    expect(() => writeXorb([new Uint8Array(0)])).toThrow(/empty chunk/);
    const mib = new Uint8Array(1024 * 1024);
    expect(() =>
      writeXorb(
        Array.from({ length: 65 }, () => mib),
        { compression: "none" },
      ),
    ).toThrow(/64 MiB/);
  });
});

describe("U5 (synthetic) chunks checked against a shard as they stream", () => {
  it("a damaged chunk stops the stream at that chunk; unchecked, it passes", async () => {
    const data = syntheticData(1_000_000, 17);
    const { chunks, refs, answer, name } = await syntheticXorb(data, { compression: "none" });
    const xorb = writeXorb(chunks, { compression: "none" });
    const k = Math.floor(chunks.length / 2);
    let at = 0;
    for (let i = 0; i < k; i++) at += 8 + (chunks[i] as Uint8Array).length;
    xorb[at + 8 + 100] = (xorb[at + 8 + 100] as number) ^ 0x20;
    const shard: Shard = { files: [], xorbs: [{ xorbHash: xorbHash(refs), chunks: refs }] };
    // the answer names the xorb by its real hash so the shard knows it
    const real = hashToString(xorbHash(refs));
    const a = JSON.parse(JSON.stringify(answer).replaceAll(name, real)) as ReconstructionAnswer;
    const run = async (verify?: ReconstructionVerifier) => {
      let yielded = 0;
      try {
        for await (const _ of reconstruct(a, memoryRanges(xorb, 65536), { verify })) yielded++;
        return { yielded };
      } catch (e) {
        return { yielded, error: e as Error };
      }
    };
    const unchecked = await run();
    expect(unchecked.error).toBeUndefined();
    expect(unchecked.yielded).toBe(chunks.length);
    const checked = await run(verifierFromShard(shard));
    expect(checked.error).toBeInstanceOf(XetIntegrityError);
    expect(checked.error?.message).toMatch(new RegExp(`chunk ${k} `));
    expect(checked.yielded).toBe(k);
    // the term's verification hash alone: caught at the term's end
    const wrongRange = { rangeHash: () => rangeHash(refs.slice(1).map((c) => c.hash)) };
    expect((await run(wrongRange)).error).toBeInstanceOf(XetIntegrityError);
  });
});

describe("H6 ByteGrouping4", () => {
  it("ByteGrouping4: groups split as xet-core's bg4_split_together come back in order", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 1000, 1001, 1002, 1003]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      // bg4_split_together: bytes 4i+g into group g, the groups one after another
      const groups = [0, 1, 2, 3].map((g) => data.filter((_, i) => i % 4 === g));
      const grouped = Uint8Array.from(groups.flatMap((g) => [...g]));
      expect([...bg4Regroup(grouped)], `${n}`).toEqual([...data]);
    }
  });
});

describe("U6 (review of #123) verification over several terms, range requests and partial shards", () => {
  // 8 chunks of about 1 KB in one xorb; a file of two terms, [0,4) and [4,8)
  const data = Array.from({ length: 8 }, (_, k) => {
    const c = new Uint8Array(1000 + k);
    let x = k + 1;
    for (let i = 0; i < c.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      c[i] = x >>> 24;
    }
    return c;
  });
  const refs: ChunkRef[] = data.map((c) => ({ hash: chunkHash(c), length: c.length }));
  const xh = xorbHash(refs);
  const X = hashToString(xh);
  const bytesOf = (a: number, b: number) => refs.slice(a, b).reduce((n, c) => n + c.length, 0);
  const term = (a: number, b: number) => ({
    xorbHash: xh,
    bytes: bytesOf(a, b),
    start: a,
    end: b,
    rangeHash: rangeHash(refs.slice(a, b).map((c) => c.hash)),
  });
  const file = fileHash(refs);
  const shard: Shard = {
    files: [{ fileHash: file, terms: [term(0, 4), term(4, 8)] }],
    xorbs: [{ xorbHash: xh, chunks: refs }],
  };
  const xorbOf = (damage?: number) => {
    const x = writeXorb(data, { compression: "none" });
    if (damage !== undefined) {
      let at = 0;
      for (let k = 0; k < damage; k++) at += 8 + (data[k] as Uint8Array).length;
      x[at + 8 + 10] = (x[at + 8 + 10] as number) ^ 1;
    }
    return x;
  };
  /** an answer of `terms` ([start, end) of the xorb), named `name` */
  const go = async (
    terms: [number, number][],
    verify: ReconstructionVerifier | undefined,
    o: { damage?: number; name?: string; offset?: number; length?: number } = {},
  ) => {
    const xorb = xorbOf(o.damage);
    const name = o.name ?? X;
    const answer: ReconstructionAnswer = {
      offset_into_first_range: o.offset ?? 0,
      terms: terms.map(([a, b]) => ({
        hash: name,
        unpacked_length: bytesOf(a, b),
        range: { start: a, end: b },
      })),
      fetch_info: {
        [name]: [
          { range: { start: 0, end: 8 }, url: "x", url_range: { start: 0, end: xorb.length - 1 } },
        ],
      },
    };
    let n = 0;
    try {
      for await (const p of reconstruct(
        answer,
        async function* (_u, a, b) {
          yield xorb.subarray(a, b + 1);
        },
        { verify, length: o.length },
      ))
        n += p.length;
      return { n };
    } catch (e) {
      return { n, error: e as Error };
    }
  };
  const termsOnly = (o: { wholeFile?: boolean } = {}): ReconstructionVerifier => {
    const v = verifierFromShard(shard, file, { wholeFile: false, ...o }); // explicit: the default is on
    return { rangeHash: v.rangeHash, done: v.done };
  };

  it("the whole file, both checks and wholeFile: passes; damage in its second term is caught", async () => {
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          verifierFromShard(shard, file, { wholeFile: true }),
        )
      ).error,
    ).toBeUndefined();
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      termsOnly(),
      { damage: 6 },
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(r.error?.message).toMatch(/4-8 does not match/);
  });

  it("range requests and other term splits: no false alarm on correct data; wholeFile refuses them", async () => {
    for (const terms of [
      [[4, 8]],
      [[5, 8]],
      [
        [0, 2],
        [2, 8],
      ],
      [
        [0, 4],
        [4, 6],
      ],
    ] as [number, number][][]) {
      expect((await go(terms, termsOnly())).error, JSON.stringify(terms)).toBeUndefined();
      expect(
        (await go(terms, termsOnly({ wholeFile: true }))).error,
        JSON.stringify(terms),
      ).toBeInstanceOf(XetIntegrityError);
    }
    // a range request over the second term is checked against it
    expect((await go([[4, 8]], termsOnly(), { damage: 5 })).error).toBeInstanceOf(
      XetIntegrityError,
    );
  });

  it("wholeFile: a dropped trailing term and an extra term are refused", async () => {
    expect((await go([[0, 4]], termsOnly({ wholeFile: true }))).error?.message).toMatch(
      /not the file's/,
    );
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
            [4, 8],
          ],
          termsOnly({ wholeFile: true }),
        )
      ).error,
    ).toBeInstanceOf(XetIntegrityError);
  });

  it("a length ending exactly at the file's end still checks its last term", async () => {
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      termsOnly({ wholeFile: true }),
      {
        damage: 6,
        length: bytesOf(0, 8),
      },
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          termsOnly({ wholeFile: true }),
          { length: bytesOf(0, 8) },
        )
      ).error,
    ).toBeUndefined();
  });

  it("an upper-case xorb name, a chunk past what the shard lists, an unlisted xorb under strict", async () => {
    const r = await go([[0, 8]], verifierFromShard(shard), { damage: 3, name: X.toUpperCase() });
    expect(r.error?.message).toMatch(/chunk 3 /);
    const short: Shard = { files: [], xorbs: [{ xorbHash: xh, chunks: refs.slice(0, 3) }] };
    expect((await go([[0, 8]], verifierFromShard(short))).error?.message).toMatch(/chunk 3 /);
    const none: Shard = { files: [], xorbs: [] };
    expect((await go([[0, 8]], verifierFromShard(none))).error).toBeUndefined();
    expect(
      (await go([[0, 8]], verifierFromShard(none, undefined, { strict: true }))).error?.message,
    ).toMatch(/xorb .* is not in the shard/); // refused before its first chunk
    expect(() => verifierFromShard({ ...shard, chunkHashesKeyed: true })).toThrow(
      /without the footer key/,
    );
  });

  it("a short term (fewer bytes than the answer says) is an integrity failure under verify", async () => {
    const xorb = xorbOf();
    const answer: ReconstructionAnswer = {
      offset_into_first_range: 0,
      terms: [{ hash: X, unpacked_length: bytesOf(0, 4) + 1, range: { start: 0, end: 4 } }],
      fetch_info: {
        [X]: [
          { range: { start: 0, end: 8 }, url: "x", url_range: { start: 0, end: xorb.length - 1 } },
        ],
      },
    };
    const consume = async (verify?: ReconstructionVerifier) => {
      for await (const _ of reconstruct(
        answer,
        async function* (_u, a, b) {
          yield xorb.subarray(a, b + 1);
        },
        { verify },
      ));
    };
    await expect(consume(verifierFromShard(shard))).rejects.toThrow(XetIntegrityError);
    await expect(consume()).rejects.toThrow(/expected/);
  });
});

describe("U7 (X11b) several terms of one fetch range in one request", () => {
  const data = Array.from({ length: 8 }, (_, k) => {
    const c = new Uint8Array(500 + k);
    let x = k + 11;
    for (let i = 0; i < c.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      c[i] = x >>> 24;
    }
    return c;
  });
  const refs: ChunkRef[] = data.map((c) => ({ hash: chunkHash(c), length: c.length }));
  const xh = xorbHash(refs);
  const X = hashToString(xh);
  const bytesOf = (a: number, b: number) => refs.slice(a, b).reduce((n, c) => n + c.length, 0);
  const concat = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  /** fetch entries: [chunk range, as a list]; the xorb's byte offsets computed from the chunks */
  const offsets = [0];
  for (const c of data) offsets.push((offsets[offsets.length - 1] as number) + 8 + c.length);
  const entry = (a: number, b: number) => ({
    range: { start: a, end: b },
    url: `xorb://${a}-${b}`,
    url_range: { start: offsets[a] as number, end: (offsets[b] as number) - 1 },
  });
  const go = async (
    terms: [number, number][],
    entries: [number, number][],
    o: { damage?: number; offset?: number; length?: number; verify?: ReconstructionVerifier } = {},
  ) => {
    const xorb = writeXorb(data, { compression: "none" });
    if (o.damage !== undefined) {
      const at = (offsets[o.damage] as number) + 8 + 3;
      xorb[at] = (xorb[at] as number) ^ 1;
    }
    const answer: ReconstructionAnswer = {
      offset_into_first_range: o.offset ?? 0,
      terms: terms.map(([a, b]) => ({
        hash: X,
        unpacked_length: bytesOf(a, b),
        range: { start: a, end: b },
      })),
      fetch_info: { [X]: entries.map(([a, b]) => entry(a, b)) },
    };
    const fetches: string[] = [];
    const out: Uint8Array[] = [];
    let error: Error | undefined;
    try {
      for await (const p of reconstruct(
        answer,
        async function* (url, a, b) {
          fetches.push(url);
          yield xorb.subarray(a, b + 1);
        },
        { length: o.length, verify: o.verify },
      ))
        out.push(p);
    } catch (e) {
      error = e as Error;
    }
    return { fetches, out: concat(out), error };
  };
  const want = (terms: [number, number][]) => concat(terms.flatMap(([a, b]) => data.slice(a, b)));

  it("consecutive terms of one fetch range: one fetch, their bytes in order", async () => {
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
    );
    expect(r.fetches).toEqual(["xorb://0-8"]);
    expect(
      r.out.equals(
        want([
          [0, 4],
          [4, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("a gap between terms: still one fetch; the chunks between are not output", async () => {
    const r = await go(
      [
        [0, 2],
        [5, 8],
      ],
      [[0, 8]],
    );
    expect(r.fetches).toEqual(["xorb://0-8"]);
    expect(
      r.out.equals(
        want([
          [0, 2],
          [5, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("terms going backwards, a term twice, terms of different fetch ranges: a fetch each", async () => {
    expect(
      (
        await go(
          [
            [4, 8],
            [0, 4],
          ],
          [[0, 8]],
        )
      ).fetches.length,
    ).toBe(2);
    const twice = await go(
      [
        [0, 4],
        [0, 4],
      ],
      [[0, 8]],
    );
    expect(twice.fetches.length).toBe(2);
    expect(
      twice.out.equals(
        want([
          [0, 4],
          [0, 4],
        ]),
      ),
    ).toBe(true);
    const split = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [
        [0, 4],
        [4, 8],
      ],
    );
    expect(split.fetches).toEqual(["xorb://0-4", "xorb://4-8"]);
    expect(
      split.out.equals(
        want([
          [0, 4],
          [4, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("each term of a shared fetch is checked when it ends, before the next term's bytes", async () => {
    const shard: Shard = {
      files: [
        {
          fileHash: fileHash(refs),
          terms: [
            {
              xorbHash: xh,
              bytes: bytesOf(0, 4),
              start: 0,
              end: 4,
              rangeHash: rangeHash(refs.slice(0, 4).map((c) => c.hash)),
            },
            {
              xorbHash: xh,
              bytes: bytesOf(4, 8),
              start: 4,
              end: 8,
              rangeHash: rangeHash(refs.slice(4, 8).map((c) => c.hash)),
            },
          ],
        },
      ],
      xorbs: [],
    };
    const termsOnly = () => {
      const v = verifierFromShard(shard, fileHash(refs), { wholeFile: true });
      return { rangeHash: v.rangeHash, done: v.done };
    };
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          [[0, 8]],
          { verify: termsOnly() },
        )
      ).error,
    ).toBeUndefined();
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { verify: termsOnly(), damage: 2 },
    );
    expect(r.error?.message).toMatch(/0-4 does not match/);
    expect(r.out.length).toBe(bytesOf(0, 4)); // nothing of the second term
    const late = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { verify: termsOnly(), damage: 6 },
    );
    expect(late.error?.message).toMatch(/4-8 does not match/);
  });

  it("(review of #125) empty terms: alone, first, or between grouped terms; checked at once", async () => {
    for (const terms of [
      [
        [0, 2],
        [2, 2],
        [2, 4],
      ],
      [
        [0, 0],
        [0, 4],
      ],
      [
        [0, 4],
        [4, 4],
      ],
    ] as [number, number][][]) {
      const r = await go(terms, [[0, 8]]);
      expect(r.error, JSON.stringify(terms)).toBeUndefined();
      expect(r.out.equals(want(terms))).toBe(true);
    }
    // an empty term's verification hash is that of no chunks: checked, a wrong one refused
    const lone = async (expected: Uint8Array) =>
      (await go([[3, 3]], [[0, 8]], { verify: { rangeHash: () => expected } })).error;
    expect(await lone(rangeHash([]))).toBeUndefined();
    expect(await lone(new Uint8Array(32))).toBeInstanceOf(XetIntegrityError);
  });

  it("(review of #125) gap chunks are checked by chunk though not output; done over grouped terms", async () => {
    const chunkOnly = verifierFromShard({ files: [], xorbs: [{ xorbHash: xh, chunks: refs }] });
    const r = await go(
      [
        [0, 2],
        [5, 8],
      ],
      [[0, 8]],
      { verify: chunkOnly, damage: 3 },
    );
    expect(r.error?.message).toMatch(/chunk 3 /);
    const shard: Shard = {
      files: [
        {
          fileHash: fileHash(refs),
          terms: [
            {
              xorbHash: xh,
              bytes: bytesOf(0, 4),
              start: 0,
              end: 4,
              rangeHash: rangeHash(refs.slice(0, 4).map((c) => c.hash)),
            },
            {
              xorbHash: xh,
              bytes: bytesOf(4, 8),
              start: 4,
              end: 8,
              rangeHash: rangeHash(refs.slice(4, 8).map((c) => c.hash)),
            },
          ],
        },
      ],
      xorbs: [],
    };
    const whole = () => verifierFromShard(shard, fileHash(refs), { wholeFile: true });
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          [[0, 8]],
          { verify: whole() },
        )
      ).error,
    ).toBeUndefined();
    expect((await go([[0, 4]], [[0, 8]], { verify: whole() })).error?.message).toMatch(
      /not the file's/,
    );
  });

  it("an offset into the first term and a length ending inside, or exactly at the end of, a later term", async () => {
    const all = want([
      [0, 4],
      [4, 8],
    ]);
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { offset: 700, length: 1500 },
    );
    expect(r.fetches.length).toBe(1);
    expect(r.out.equals(all.subarray(700, 2200))).toBe(true);
    const exact = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { length: bytesOf(0, 8) },
    );
    expect(exact.out.equals(all)).toBe(true);
  });
});
