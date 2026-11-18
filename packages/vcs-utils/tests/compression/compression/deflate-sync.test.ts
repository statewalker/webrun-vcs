import { inflateSync, deflateSync as zlibDeflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  deflateSync,
  LOOSE_OBJECT_COMPRESSION_LEVEL,
} from "../../../src/compression/compression/deflate-sync.js";
import { inflateWhole } from "../../../src/compression/compression/whole-inflate.js";

/** Pseudo-random bytes (a fixed LCG). */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const enc = new TextEncoder();

describe("deflateSync", () => {
  const inputs: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["small text", enc.encode("blob 6\0hello\n")],
    ["repetitive", enc.encode("line of text\n".repeat(5000))],
    ["noise", noise(70_000)],
  ];

  for (const [name, data] of inputs) {
    it(`writes what zlib writes, at levels 1 and 6 (${name})`, () => {
      for (const level of [1, 6]) {
        const ours = deflateSync([data], { level });
        expect(Buffer.from(ours).equals(zlibDeflateSync(data, { level }))).toBe(true);
        expect(Buffer.from(inflateSync(ours)).equals(Buffer.from(data))).toBe(true);
      }
    });
  }

  it("takes its input in pieces, as one stream", () => {
    const data = enc.encode("tree 100\0".repeat(300));
    const pieces = [data.subarray(0, 7), data.subarray(7, 1000), data.subarray(1000)];
    expect(
      Buffer.from(deflateSync(pieces, { level: 1 })).equals(zlibDeflateSync(data, { level: 1 })),
    ).toBe(true);
  });

  it("reuses its pooled state across calls without mixing them", () => {
    const a = enc.encode("first object\n".repeat(50));
    const b = enc.encode("second\n");
    const da = deflateSync([a], { level: LOOSE_OBJECT_COMPRESSION_LEVEL });
    const db = deflateSync([b], { level: LOOSE_OBJECT_COMPRESSION_LEVEL });
    expect(inflateWhole(da).data.subarray(0, a.length)).toEqual(a);
    expect(Buffer.from(inflateSync(db)).toString()).toBe("second\n");
    expect(Buffer.from(deflateSync([a], { level: 1 })).equals(Buffer.from(da))).toBe(true);
  });

  it("refuses a level zlib does not have", () => {
    expect(() => deflateSync([new Uint8Array(1)], { level: 10 })).toThrow(RangeError);
  });

  it("writes loose objects at git's default level (Z_BEST_SPEED)", () => {
    expect(LOOSE_OBJECT_COMPRESSION_LEVEL).toBe(1);
    // zlib's header for level 1: 0x78 0x01
    const out = deflateSync([enc.encode("blob 0\0")], { level: LOOSE_OBJECT_COMPRESSION_LEVEL });
    expect([out[0], out[1]]).toEqual([0x78, 0x01]);
  });
});
