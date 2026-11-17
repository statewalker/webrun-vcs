import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex, Sha1, sha1Of, sha1Wasm } from "../../../src/hash/index.js";

/** Deterministic bytes that do not repeat within a block. */
function input(len: number, seed = 1): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const native = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

describe("Sha1", () => {
  it("has a WebAssembly block function on Node", () => {
    expect(sha1Wasm()).toBeDefined();
  });

  it("matches Node's SHA-1 for every length around block and padding edges", () => {
    const data = input(2100);
    for (let n = 0; n <= 2100; n++) {
      const bytes = data.subarray(0, n);
      expect(bytesToHex(sha1Of(bytes))).toBe(native(bytes));
      expect(bytesToHex(new Sha1().update(bytes).digest())).toBe(native(bytes));
    }
  });

  it("gives the same digest however the input is split (JavaScript and WebAssembly runs)", () => {
    const data = input(70000, 7);
    const want = native(data);
    // steps under 128 bytes keep every run of blocks in JavaScript, larger ones use WebAssembly
    for (const step of [1, 7, 63, 64, 65, 127, 128, 129, 1000, 4096, 65536, 70000]) {
      const h = new Sha1();
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
      expect(bytesToHex(h.digest())).toBe(want);
    }
  });

  it("hashes inputs larger than the WebAssembly memory in pieces", () => {
    const data = input(3 * 1024 * 1024 + 77, 3);
    expect(bytesToHex(new Sha1().update(data).digest())).toBe(native(data));
    const offset = data.subarray(5, data.length - 5);
    expect(bytesToHex(new Sha1().update(offset).digest())).toBe(native(offset));
  });

  it("sha1Of hashes a header and a body as one message, in one run or in pieces", () => {
    const data = input(3000, 11);
    for (let n = 0; n < 3000; n += 1 + (n >> 3)) {
      for (const h of [0, 1, 10, 25]) {
        const head = data.subarray(0, Math.min(h, n));
        const body = data.subarray(head.length, n);
        expect(bytesToHex(sha1Of(head, body))).toBe(native(data.subarray(0, n)));
      }
    }
    // larger than the WebAssembly memory: hashed incrementally
    const big = input(1024 * 1024 + 5, 13);
    expect(bytesToHex(sha1Of(big.subarray(0, 9), big.subarray(9)))).toBe(native(big));
  });

  it("clones an intermediate state", () => {
    const data = input(5000, 9);
    const a = new Sha1().update(data.subarray(0, 1000));
    const b = a.clone();
    a.update(data.subarray(1000));
    b.update(data.subarray(1000));
    expect(bytesToHex(a.digest())).toBe(native(data));
    expect(bytesToHex(b.digest())).toBe(native(data));
  });

  it("falls back to JavaScript where WebAssembly cannot be compiled", async () => {
    vi.resetModules();
    vi.stubGlobal("WebAssembly", undefined);
    try {
      const mod = await import("../../../src/hash/hasher/sha1-fast.js");
      const wasm = await import("../../../src/hash/hasher/sha1-wasm.js");
      expect(wasm.sha1Wasm()).toBeUndefined();
      const data = input(100000, 5);
      expect(bytesToHex(new mod.Sha1().update(data).digest())).toBe(native(data));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("is single-use: update or digest after digest throws", () => {
    const h = new Sha1().update(input(10));
    h.digest();
    expect(() => h.digest()).toThrow(/digest called twice/);
    expect(() => h.update(input(1))).toThrow(/update after digest/);
    // a clone taken before stays usable
    const a = new Sha1().update(input(100));
    const b = a.clone();
    expect(bytesToHex(a.digest())).toBe(bytesToHex(b.digest()));
  });
});
