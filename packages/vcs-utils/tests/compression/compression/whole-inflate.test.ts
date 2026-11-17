import { constants, deflateSync, inflateSync } from "node:zlib";
import { inflate as pakoInflate } from "pako";
import { describe, expect, it } from "vitest";
import {
  createInflaterPool,
  InflateError,
  InflateOverflowError,
  inflateWhole,
  TruncatedStreamError,
} from "../../../src/compression/index.js";

/** A deterministic generator, so a failing case can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** Text-like bytes (repeats and a small alphabet), random bytes, or runs. */
function sample(r: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const kind = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    if (kind === 0) out[i] = 97 + Math.floor(r() * 8);
    else if (kind === 1) out[i] = Math.floor(r() * 256);
    else out[i] = i > 4 && r() < 0.9 ? (out[i - 4] as number) : Math.floor(r() * 256);
  }
  return out;
}

const deflaters: { name: string; opts: object }[] = [
  { name: "default", opts: {} },
  { name: "level 0 (stored)", opts: { level: 0 } },
  { name: "level 1", opts: { level: 1 } },
  { name: "level 9", opts: { level: 9 } },
  { name: "fixed Huffman", opts: { strategy: constants.Z_FIXED } },
  { name: "Huffman only", opts: { strategy: constants.Z_HUFFMAN_ONLY } },
  { name: "RLE", opts: { strategy: constants.Z_RLE } },
  { name: "small window", opts: { windowBits: 9 } },
];

/** pako's verdict: the output, or an error */
function viaPako(z: Uint8Array): Uint8Array | Error {
  try {
    const out = pakoInflate(z);
    return out ?? new Error("pako: no output");
  } catch (e) {
    return e as Error;
  }
}

function viaWhole(z: Uint8Array): Uint8Array | Error {
  try {
    const r = inflateWhole(z, { maxSize: 1 << 22 });
    return r.data.subarray(0, r.length);
  } catch (e) {
    return e as Error;
  }
}

describe("inflateWhole", () => {
  it("inflates what zlib deflates, at every level and strategy, sizes 0 to 70000", () => {
    const r = rng(7);
    for (const { name, opts } of deflaters) {
      for (const n of [0, 1, 2, 3, 100, 257, 258, 259, 1000, 5000, 33000, 70000]) {
        const raw = sample(r, n);
        const z = new Uint8Array(deflateSync(raw, opts));
        const got = inflateWhole(z, { size: n });
        expect(got.length, `${name} ${n}`).toBe(n);
        expect(Buffer.from(got.data).equals(Buffer.from(raw)), `${name} ${n}`).toBe(true);
        expect(got.consumed, `${name} ${n}`).toBe(z.length);
      }
    }
  });

  it("writes into a given buffer, grows when the size is unknown, reports where the stream ends", () => {
    const raw = new TextEncoder().encode("tree 1234\nparent 5678\n\nmessage\n".repeat(20));
    const z = new Uint8Array(deflateSync(raw));
    const withTail = new Uint8Array(z.length + 5);
    withTail.set(z);
    const into = new Uint8Array(raw.length);
    const a = inflateWhole(withTail, { into });
    expect(a.data).toBe(into);
    expect(a.consumed).toBe(z.length);
    const b = inflateWhole(z);
    expect(Buffer.from(b.data.subarray(0, b.length)).equals(Buffer.from(raw))).toBe(true);
  });

  it("refuses output past the expected size, and past maxSize when growing", () => {
    const raw = new Uint8Array(1000).fill(7);
    const z = new Uint8Array(deflateSync(raw));
    expect(() => inflateWhole(z, { size: 999 })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { into: new Uint8Array(10) })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { maxSize: 999 })).toThrow(InflateOverflowError);
    // a shorter stream is reported by its length, for the caller to judge
    expect(inflateWhole(z, { size: 2000 }).length).toBe(1000);
  });

  it("fails on truncation (TruncatedStreamError) and on a bad checksum or header (InflateError)", () => {
    const raw = sample(rng(3), 3000);
    const z = new Uint8Array(deflateSync(raw));
    for (const cut of [0, 1, 2, 3, 10, z.length - 5, z.length - 1]) {
      expect(() => inflateWhole(z.subarray(0, cut), { size: 3000 })).toThrow(TruncatedStreamError);
    }
    const badSum = z.slice();
    badSum[badSum.length - 1] = (badSum[badSum.length - 1] as number) ^ 1;
    expect(() => inflateWhole(badSum, { size: 3000 })).toThrow(/incorrect data check/);
    const badHeader = z.slice();
    badHeader[1] = (badHeader[1] as number) ^ 1;
    expect(() => inflateWhole(badHeader, { size: 3000 })).toThrow(InflateError);
    const dict = new Uint8Array(deflateSync(raw, { dictionary: Buffer.from("abc") }));
    expect(() => inflateWhole(dict, { size: 3000 })).toThrow(/preset dictionary/);
  });

  it("agrees with pako on damaged streams: same bytes, or both fail", () => {
    const r = rng(11);
    let failures = 0;
    for (let round = 0; round < 1500; round++) {
      const { opts } = deflaters[round % deflaters.length] as { opts: object };
      const raw = sample(r, Math.floor(r() * 2000));
      const z = new Uint8Array(deflateSync(raw, opts));
      const bad = z.slice();
      const flips = 1 + Math.floor(r() * 3);
      for (let k = 0; k < flips; k++) {
        // damage the deflate data (past the 2-byte header), or the trailer
        const at = 2 + Math.floor(r() * (bad.length - 2));
        bad[at] = (bad[at] as number) ^ (1 << Math.floor(r() * 8));
      }
      const want = viaPako(bad);
      const got = viaWhole(bad);
      if (want instanceof Error) {
        expect(got, `round ${round}`).toBeInstanceOf(Error);
        failures++;
      } else {
        expect(got, `round ${round}: ${(got as Error).message}`).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(got as Uint8Array).equals(Buffer.from(want)), `round ${round}`).toBe(
          true,
        );
      }
    }
    expect(failures).toBeGreaterThan(1000);
  });

  it("decodes the same as the pooled stream inflater for a handcrafted single-code distance set", () => {
    // a stream from a deflater that uses one distance code (zlib allows the incomplete set)
    const raw = new Uint8Array(600);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 3 === 0 ? 1 : 2;
    const z = new Uint8Array(deflateSync(raw, { level: 9 }));
    const pool = createInflaterPool();
    const viaPool = pool.acquire().push(z);
    expect(viaPool.done).toBe(true);
    const got = inflateWhole(z, { size: raw.length });
    expect(Buffer.from(got.data).equals(Buffer.from(raw))).toBe(true);
  });

  it("stops at a full output without an error when partial (to read a header)", () => {
    const raw = new TextEncoder().encode(`blob 5000\0${"x".repeat(5000)}`);
    const z = new Uint8Array(deflateSync(raw));
    const probe = new Uint8Array(300);
    const r = inflateWhole(z, { into: probe, partial: true });
    expect(r.ended).toBe(false);
    expect(r.consumed).toBe(-1);
    expect(r.length).toBeGreaterThan(32);
    expect(new TextDecoder().decode(probe.subarray(0, 10))).toBe("blob 5000\0");
    // a stream that fits ends as usual
    const small = new Uint8Array(deflateSync(raw.subarray(0, 100)));
    const whole = inflateWhole(small, { into: probe, partial: true });
    expect(whole).toMatchObject({ length: 100, consumed: small.length, ended: true });
    // corrupt data still throws
    const bad = small.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => inflateWhole(bad, { into: probe, partial: true })).toThrow(InflateError);
  });
});

describe("inflateWhole differential fuzz against node zlib", () => {
  /** node zlib's verdict, as inflateWhole's error classes: "ok", "truncated" or "corrupt" */
  function zlibVerdict(z: Uint8Array): { kind: string; out?: Uint8Array } {
    try {
      return { kind: "ok", out: new Uint8Array(inflateSync(z)) };
    } catch (e) {
      return { kind: (e as { code?: string }).code === "Z_BUF_ERROR" ? "truncated" : "corrupt" };
    }
  }

  function wholeVerdict(
    z: Uint8Array,
    options: Parameters<typeof inflateWhole>[1],
  ): { kind: string; out?: Uint8Array; consumed?: number; ended?: boolean } {
    try {
      const r = inflateWhole(z, options);
      return {
        kind: "ok",
        out: r.data.subarray(0, r.length),
        consumed: r.consumed,
        ended: r.ended,
      };
    } catch (e) {
      if (e instanceof InflateOverflowError) return { kind: "overflow" };
      if (e instanceof TruncatedStreamError) return { kind: "truncated" };
      if (e instanceof InflateError) return { kind: "corrupt" };
      throw e;
    }
  }

  /** A stream to inflate: zlib's output damaged by flips, cuts or a random byte, or random data. */
  function damagedStream(r: () => number, round: number): Uint8Array {
    const { opts } = deflaters[round % deflaters.length] as { opts: object };
    let z = new Uint8Array(deflateSync(sample(r, Math.floor(r() ** 2 * 3000)), opts));
    const damage = Math.floor(r() * 6);
    if (damage === 1 || damage === 4) {
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const at = 2 + Math.floor(r() * (z.length - 2));
        z[at] = (z[at] as number) ^ (1 << Math.floor(r() * 8));
      }
    }
    if (damage === 2 || damage === 4) z = z.subarray(0, Math.floor(r() * z.length));
    if (damage === 3) {
      // a block header or code lengths, most likely
      z[2 + Math.floor(r() * Math.min(z.length - 2, 64))] = Math.floor(r() * 256);
    }
    if (damage === 5) {
      // a valid zlib header and random bits: random block types and code sets
      z = new Uint8Array(2 + Math.floor(r() * 200));
      z[0] = 0x78;
      z[1] = 0x9c;
      for (let i = 2; i < z.length; i++) z[i] = Math.floor(r() * 256);
    }
    return z;
  }

  it("decodes the same bytes, or fails as zlib fails (truncated or corrupt), for 4000 seeded streams", () => {
    const r = rng(20261117);
    const seen = { ok: 0, truncated: 0, corrupt: 0 };
    for (let round = 0; round < 4000; round++) {
      const z = damagedStream(r, round);
      const want = zlibVerdict(z);
      const got = wholeVerdict(z, { maxSize: 1 << 22 });
      expect(got.kind, `round ${round}`).toBe(want.kind);
      seen[want.kind as keyof typeof seen]++;
      if (want.out) {
        expect(
          Buffer.from(got.out as Uint8Array).equals(Buffer.from(want.out)),
          `round ${round}`,
        ).toBe(true);
        // the same stream into an exact buffer, a short one, and a short one read partially
        const n = want.out.length;
        expect(wholeVerdict(z, { size: n }).out?.length, `round ${round}`).toBe(n);
        if (n > 0) {
          const cut = Math.floor(r() * n);
          expect(wholeVerdict(z, { size: cut }).kind, `round ${round}`).toBe("overflow");
          const part = wholeVerdict(z, { into: new Uint8Array(cut), partial: true });
          expect(part.kind, `round ${round}`).toBe("ok");
          expect(part.ended, `round ${round}`).toBe(false);
          expect(
            Buffer.from(part.out as Uint8Array).equals(
              Buffer.from(want.out.subarray(0, part.out?.length)),
            ),
            `round ${round}`,
          ).toBe(true);
        }
      }
    }
    // every outcome is exercised
    expect(seen.ok).toBeGreaterThan(400);
    expect(seen.truncated).toBeGreaterThan(400);
    expect(seen.corrupt).toBeGreaterThan(400);
  });
});

describe("inflateWhole on a code set zlib accepts oddly", () => {
  it("reads a code length code without codes as zlib does: lengths of 0, one bit each, until the input ends", () => {
    // a dynamic block whose 4 code length code lengths are all 0: zlib's table then decodes
    // every bit as a length of 0, and the input runs out before the 258 lengths
    const z = Uint8Array.from([0x78, 0x9c, 0xad, 0x00, 0x00, 0x00, 0x00, 0x01]);
    expect(() => inflateSync(z)).toThrow(/unexpected end of file/);
    expect(() => inflateWhole(z, { maxSize: 1000 })).toThrow(TruncatedStreamError);
  });
});

describe("inflateWhole partial: the part of a block or match that fits", () => {
  it("copies the start of a stored block longer than the output, as zlib does", () => {
    // incompressible content: zlib stores it, so the header is the start of a stored block
    const r = rng(7);
    for (const n of [10, 31, 32, 33, 100, 5000, 65535, 65536, 70000, 200000]) {
      const body = new Uint8Array(n);
      for (let i = 0; i < n; i++) body[i] = Math.floor(r() * 256);
      const raw = new Uint8Array([...new TextEncoder().encode(`blob ${n}\0`), ...body]);
      for (const opts of [{ level: 0 }, {}]) {
        const z = new Uint8Array(deflateSync(raw, opts));
        const probe = new Uint8Array(32);
        const got = inflateWhole(z, { into: probe, partial: true });
        const want = Math.min(32, raw.length);
        expect(got.length, `n ${n}`).toBe(want);
        expect(got.ended, `n ${n}`).toBe(raw.length <= 32);
        expect(
          Buffer.from(probe.subarray(0, want)).equals(Buffer.from(raw.subarray(0, want))),
        ).toBe(true);
      }
    }
  });

  it("fills a growable buffer up to maxSize with the start of a stored block", () => {
    const raw = new Uint8Array(1000).map((_, i) => (i * 7919) & 255);
    const z = new Uint8Array(deflateSync(raw, { level: 0 }));
    const got = inflateWhole(z, { maxSize: 600, partial: true });
    expect(got).toMatchObject({ length: 600, ended: false, consumed: -1 });
    expect(Buffer.from(got.data.subarray(0, 600)).equals(Buffer.from(raw.subarray(0, 600)))).toBe(
      true,
    );
    // without partial, the overflow is still an error
    expect(() => inflateWhole(z, { maxSize: 600 })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { size: 999 })).toThrow(InflateOverflowError);
  });

  it("copies the start of a match longer than the output", () => {
    // "abc" then a long run: one literal triple then matches of 258
    const raw = new TextEncoder().encode(`abc${"abc".repeat(400)}`);
    const z = new Uint8Array(deflateSync(raw));
    for (const cut of [4, 5, 32, 100, 259, 1000]) {
      const got = inflateWhole(z, { into: new Uint8Array(cut), partial: true });
      expect(got.length).toBe(cut);
      expect(new TextDecoder().decode(got.data.subarray(0, cut))).toBe(
        new TextDecoder().decode(raw.subarray(0, cut)),
      );
    }
  });

  it("stops after a truncated stored block only when the part that fits is there", () => {
    const raw = new Uint8Array(500).map((_, i) => (i * 31) & 255);
    const z = new Uint8Array(deflateSync(raw, { level: 0 }));
    // zlib header (2) + block header (1) + LEN/NLEN (4) + 40 bytes of the block
    const cutInput = z.subarray(0, 7 + 40);
    expect(inflateWhole(cutInput, { into: new Uint8Array(32), partial: true }).length).toBe(32);
    expect(() => inflateWhole(cutInput, { into: new Uint8Array(64), partial: true })).toThrow(
      TruncatedStreamError,
    );
  });

  it("gives exactly the prefix node zlib produces, for every output length shorter than the stream", () => {
    const r = rng(20261118);
    for (let round = 0; round < 600; round++) {
      const { opts } = deflaters[round % deflaters.length] as { opts: object };
      const raw = sample(r, 1 + Math.floor(r() ** 2 * 80000));
      const z = new Uint8Array(deflateSync(raw, opts));
      // a truncated input too: zlib's sync flush gives what the bytes there inflate to
      const input = r() < 0.5 ? z : z.subarray(0, 2 + Math.floor(r() * (z.length - 2)));
      const want = new Uint8Array(inflateSync(input, { finishFlush: constants.Z_SYNC_FLUSH }));
      if (want.length === 0) continue;
      for (let k = 0; k < 3; k++) {
        const cut = Math.floor(r() * want.length);
        const got = inflateWhole(input, { into: new Uint8Array(cut), partial: true });
        expect(got.length, `round ${round} cut ${cut}`).toBe(cut);
        expect(got.ended, `round ${round}`).toBe(false);
        expect(
          Buffer.from(got.data.subarray(0, cut)).equals(Buffer.from(want.subarray(0, cut))),
          `round ${round} cut ${cut}`,
        ).toBe(true);
      }
    }
  });
});
