import { describe, expect, it } from "vitest";
import { allocBytes, allocInt32 } from "../../src/streams/index.js";

describe("allocBytes", () => {
  it("carves small zeroed buffers from shared slabs, and gives large ones their own", () => {
    const a = allocBytes(100);
    const b = allocBytes(100);
    expect(a.length).toBe(100);
    expect(a.buffer).toBe(b.buffer); // one slab
    expect(a.every((x) => x === 0)).toBe(true);
    a.fill(1);
    expect(b.every((x) => x === 0)).toBe(true); // no overlap
    expect(b.byteOffset % 8).toBe(0);
    const big = allocBytes(100_000);
    expect(big.length).toBe(100_000);
    expect(big.byteOffset).toBe(0);
    expect(big.buffer.byteLength).toBe(100_000);
    expect(allocBytes(0).length).toBe(0);
    // a full slab is replaced, never reused
    const seen = new Set<ArrayBufferLike>();
    for (let i = 0; i < 100; i++) seen.add(allocBytes(2048).buffer);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("allocInt32", () => {
  it("carves small zeroed arrays from the slabs, aligned, and gives large ones their own", () => {
    const bytes = allocBytes(3); // leaves the slab at an odd offset
    const a = allocInt32(100);
    const b = allocInt32(100);
    expect(a.length).toBe(100);
    expect(a.buffer).toBe(b.buffer);
    expect(a.byteOffset % 4).toBe(0);
    a.fill(-1);
    bytes.fill(0xff);
    expect(b.every((x) => x === 0)).toBe(true);
    expect(allocBytes(8).every((x) => x === 0)).toBe(true);
    const big = allocInt32(10_000);
    expect(big.length).toBe(10_000);
    expect(big.byteOffset).toBe(0);
    expect(allocInt32(0).length).toBe(0);
  });
});
