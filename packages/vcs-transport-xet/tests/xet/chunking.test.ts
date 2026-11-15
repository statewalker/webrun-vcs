import { describe, expect, it } from "vitest";
import { chunkStream, GEAR_TABLE } from "../../src/index.js";

/** the specification's chunker, literally: every byte hashed (BigInt), the mask tested from 8 KiB */
function specLengths(data: Uint8Array): number[] {
  const MASK = 0xffff000000000000n;
  const M = (1n << 64n) - 1n;
  const out: number[] = [];
  let h = 0n;
  let size = 0;
  for (const b of data) {
    h = ((h << 1n) + (GEAR_TABLE[b] as bigint)) & M;
    size++;
    if ((size >= 8192 && (h & MASK) === 0n) || size >= 131072) {
      out.push(size);
      h = 0n;
      size = 0;
    }
  }
  if (size) out.push(size);
  return out;
}

describe("H7 chunk boundaries at the minimum size, against the specification's own steps", () => {
  /** 64 bytes after which the hash has its top 16 bits clear: a candidate boundary */
  function matchingWindow(): Uint8Array {
    for (let seed = 1; ; seed++) {
      const w = new Uint8Array(64);
      let x = seed;
      for (let i = 0; i < 64; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        w[i] = x >>> 24;
      }
      let h = 0n;
      for (const b of w) h = ((h << 1n) + (GEAR_TABLE[b] as bigint)) & ((1n << 64n) - 1n);
      if (h >> 48n === 0n) return w;
    }
  }

  it("a match one byte before 8 KiB is no boundary; one at 8 KiB is", async () => {
    const w = matchingWindow();
    for (const end of [8191, 8192, 8193]) {
      // filler that the window's 64 bytes wash out, then the window ending at byte `end`
      const data = new Uint8Array(end + 20_000);
      for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 7) & 255;
      data.set(w, end - 64);
      const ours: number[] = [];
      for await (const c of chunkStream([data] as unknown as AsyncIterable<Uint8Array>))
        ours.push(c.length);
      expect(ours, `window ending at ${end}`).toEqual(specLengths(data));
    }
  }, 120_000);
});

describe("H8 chunking in any piece size", () => {
  it("random data in every piece size chunks as the specification's chunker does", async () => {
    let x = 12345;
    const data = new Uint8Array(1_500_000);
    for (let i = 0; i < data.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      data[i] = x & 255;
    }
    const want = specLengths(data);
    for (const piece of [1, 7, 8127, 8128, 65_536, 131_072, 1_048_579]) {
      const src = (async function* () {
        for (let at = 0; at < data.length; at += piece) yield data.subarray(at, at + piece);
      })();
      const got: number[] = [];
      for await (const c of chunkStream(src)) got.push(c.length);
      expect(got, `pieces of ${piece}`).toEqual(want);
    }
  }, 300_000);
});
