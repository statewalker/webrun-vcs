import { constants, deflateSync } from "node:zlib";
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
