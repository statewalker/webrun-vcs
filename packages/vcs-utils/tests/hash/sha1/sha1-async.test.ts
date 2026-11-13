import { describe, expect, it } from "vitest";
import { sha1 } from "../../../src/hash/sha1/sha1-async.js";
import { bytesToHex } from "../../../src/hash/utils/index.js";

describe("sha1 (async)", () => {
  it("hashes empty data", async () => {
    const result = await sha1(new Uint8Array([]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(20);
    expect(bytesToHex(result)).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("hashes 'hello'", async () => {
    const data = new TextEncoder().encode("hello");
    const result = await sha1(data);
    expect(bytesToHex(result)).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  it("hashes 'hello world'", async () => {
    const data = new TextEncoder().encode("hello world");
    const result = await sha1(data);
    expect(bytesToHex(result)).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("returns Uint8Array", async () => {
    const data = new TextEncoder().encode("test");
    const result = await sha1(data);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

describe("sha1 of a view", () => {
  it("hashes only the bytes of a subarray at a non-zero offset", async () => {
    const whole = new TextEncoder().encode("xxhelloyy");
    expect(bytesToHex(await sha1(whole.subarray(2, 7)))).toBe(
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    );
  });
});

describe("sha1 without Web Crypto", () => {
  it("falls back to the portable hasher with the same result", async () => {
    const data = new TextEncoder().encode("hello");
    const native = await sha1(data);
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(bytesToHex(await sha1(data))).toBe(bytesToHex(native));
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
  });
});
