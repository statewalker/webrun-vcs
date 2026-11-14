import * as pako from "pako";
import { describe, expect, it } from "vitest";
import { deflatePako, inflatePako } from "../../../src/compression/compression/pako-compression.js";
import { CompressionError } from "../../../src/compression/compression/types.js";

/** Pseudo-random bytes (a fixed LCG), so the deflated stream stays about as long as the input. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Byte equality without vitest's element-by-element diffing of large arrays. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A source that counts how many of its chunks were pulled. */
function counted(chunks: Uint8Array[]) {
  const state = { pulled: 0 };
  async function* source() {
    for (const c of chunks) {
      state.pulled++;
      yield c;
    }
  }
  return { state, source: source() };
}

describe("deflatePako / inflatePako: push-based streaming", () => {
  const input = noise(1024 * 1024);
  const chunks = split(input, 10_000);

  it("deflate emits output before its input is consumed", async () => {
    const { state, source } = counted(chunks);
    const it = deflatePako(source)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(state.pulled).toBeLessThan(chunks.length);
    await it.return?.();
  });

  it("inflate emits output before its input is consumed", async () => {
    const compressed = split(pako.deflate(input), 10_000);
    const { state, source } = counted(compressed);
    const it = inflatePako(source)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(state.pulled).toBeLessThan(compressed.length);
    await it.return?.();
  });

  it("never emits one chunk holding the whole output", async () => {
    const out: Uint8Array[] = [];
    for await (const c of deflatePako(counted(chunks).source)) out.push(c);
    expect(out.length).toBeGreaterThan(1);
    expect(Math.max(...out.map((c) => c.length))).toBeLessThan(input.length / 4);

    const back: Uint8Array[] = [];
    for await (const c of inflatePako(counted(out).source)) back.push(c);
    expect(back.length).toBeGreaterThan(1);
    expect(Math.max(...back.map((c) => c.length))).toBeLessThan(input.length / 4);
    expect(same(concat(back), input)).toBe(true);
  });

  it("round-trips zlib and raw streams that pako's block API reads", async () => {
    const text = new TextEncoder().encode("hello hello hello hello\n".repeat(5000));
    for (const raw of [false, true]) {
      const out: Uint8Array[] = [];
      for await (const c of deflatePako(counted(split(text, 777)).source, { raw, level: 9 })) {
        out.push(c);
      }
      const block = concat(out);
      expect(same(raw ? pako.inflateRaw(block) : pako.inflate(block), text)).toBe(true);
      const back: Uint8Array[] = [];
      for await (const c of inflatePako(counted(split(block, 13)).source, { raw })) back.push(c);
      expect(same(concat(back), text)).toBe(true);
    }
  });

  it("deflates empty input to a valid empty stream", async () => {
    const out: Uint8Array[] = [];
    for await (const c of deflatePako(counted([]).source)) out.push(c);
    expect(pako.inflate(concat(out))).toEqual(new Uint8Array(0));
  });

  it("rejects corrupt and truncated input", async () => {
    const bad = (async function* () {
      yield new Uint8Array([1, 2, 3, 4, 5, 6]);
    })();
    await expect(
      (async () => {
        for await (const _ of inflatePako(bad));
      })(),
    ).rejects.toThrow(CompressionError);

    const whole = pako.deflate(noise(5000));
    await expect(
      (async () => {
        for await (const _ of inflatePako(counted([whole.subarray(0, 100)]).source));
      })(),
    ).rejects.toThrow(CompressionError);
  });
});
