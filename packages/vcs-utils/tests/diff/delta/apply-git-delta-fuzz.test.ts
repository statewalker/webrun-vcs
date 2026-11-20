/**
 * applyGitDelta against a plain reading of git's patch-delta.c, over random deltas: copies
 * of every size around the byte-loop threshold (and the 0x10000 of a size 0), offsets of one
 * to three bytes, inserts of 1 to 127 bytes, results above and below the 64 KiB first-pass
 * limit. A loose bound keeps applying many small instructions fast (it decoded each operand
 * byte with a floating-point power before).
 */
import { describe, expect, it } from "vitest";
import { applyGitDelta, DeltaError } from "../../../src/diff/delta/index.js";

/** mulberry32 */
function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function varint(n: number, out: number[]): void {
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
}

/** A copy instruction: only the non-zero operand bytes present, as git writes them. */
function copy(offset: number, size: number, out: number[]): void {
  let cmd = 0x80;
  const operands: number[] = [];
  for (let i = 0; i < 4; i++) {
    const b = Math.floor(offset / 2 ** (8 * i)) & 0xff;
    if (b) {
      cmd |= 1 << i;
      operands.push(b);
    }
  }
  const s = size === 0x10000 ? 0 : size;
  for (let i = 0; i < 3; i++) {
    const b = (s >> (8 * i)) & 0xff;
    if (b) {
      cmd |= 0x10 << i;
      operands.push(b);
    }
  }
  out.push(cmd, ...operands);
}

/** git's patch_delta, read literally. */
function reference(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const header = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = delta[p++] as number;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return v;
    }
  };
  header();
  const out = new Uint8Array(header());
  let o = 0;
  while (p < delta.length) {
    const cmd = delta[p++] as number;
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) off += (delta[p++] as number) * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) size += (delta[p++] as number) << (8 * i);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else {
      out.set(delta.subarray(p, p + cmd), o);
      p += cmd;
      o += cmd;
    }
  }
  return out;
}

/** A random delta over `base` producing about `target` bytes. */
function randomDelta(base: Uint8Array, target: number, next: (n: number) => number): Uint8Array {
  const body: number[] = [];
  let size = 0;
  while (size < target) {
    if (next(3) > 0) {
      const sizes = [1, 15, 16, 17, 63, 64, 65, 200, 4096, 0x10000];
      let len = next(4) === 0 ? (sizes[next(sizes.length)] as number) : 1 + next(300);
      len = Math.min(len, base.length);
      const off = next(base.length - len + 1);
      copy(off, len, body);
      size += len;
    } else {
      const len = 1 + next(127);
      body.push(len);
      for (let k = 0; k < len; k++) body.push(next(256));
      size += len;
    }
  }
  const head: number[] = [];
  varint(base.length, head);
  varint(size, head);
  return Uint8Array.from([...head, ...body]);
}

const same = (a: Uint8Array, b: Uint8Array) => {
  expect(a.length).toBe(b.length);
  let diff = -1;
  for (let i = 0; i < a.length && diff < 0; i++) if (a[i] !== b[i]) diff = i;
  expect(diff).toBe(-1);
};

describe("applyGitDelta, fuzzed against git's patch_delta", () => {
  it("applies random deltas of small and large results", () => {
    const next = rng(42);
    for (let round = 0; round < 200; round++) {
      const base = new Uint8Array(1 + next(round % 10 === 0 ? 0x30000 : 5000));
      for (let i = 0; i < base.length; i++) base[i] = next(256);
      const delta = randomDelta(base, round % 7 === 0 ? 100_000 : 1 + next(3000), next);
      same(applyGitDelta(base, delta), reference(base, delta));
    }
  });

  it("names the operand that is cut short", () => {
    const base = new Uint8Array(300);
    // copy with two offset bytes and one size byte, cut inside the offset, then the size
    expect(() => applyGitDelta(base, Uint8Array.of(0xac, 0x02, 0x10, 0x93, 0x01))).toThrow(
      /copy offset truncated/,
    );
    expect(() => applyGitDelta(base, Uint8Array.of(0xac, 0x02, 0x10, 0x93, 0x01, 0x01))).toThrow(
      /copy size truncated/,
    );
    expect(() => applyGitDelta(base, Uint8Array.of(0xac, 0x02, 0x10, 0x93, 0x01, 0x01))).toThrow(
      DeltaError,
    );
  });

  it("applies many small instructions quickly", () => {
    const next = rng(7);
    const base = new Uint8Array(200_000);
    for (let i = 0; i < base.length; i++) base[i] = next(256);
    // a line-level delta: copies of 20 to 80 bytes with short inserts between them
    const body: number[] = [];
    let size = 0;
    while (size < 1_000_000) {
      const len = 20 + next(60);
      copy(next(base.length - len), len, body);
      body.push(8, 1, 2, 3, 4, 5, 6, 7, 8);
      size += len + 8;
    }
    const head: number[] = [];
    varint(base.length, head);
    varint(size, head);
    const delta = Uint8Array.from([...head, ...body]);
    same(applyGitDelta(base, delta), reference(base, delta));
    const started = performance.now();
    for (let k = 0; k < 20; k++) applyGitDelta(base, delta);
    // about 20 MB from some 400k instructions: well under a second on any machine
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
