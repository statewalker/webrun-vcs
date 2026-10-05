import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../../src/hash/utils/index.js";

describe("hexToBytes", () => {
  it("converts empty string", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array([]));
  });

  it("converts 'deadbeef'", () => {
    expect(hexToBytes("deadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles lowercase", () => {
    expect(hexToBytes("abcdef")).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it("handles uppercase", () => {
    expect(hexToBytes("ABCDEF")).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it("converts SHA-1 hash", () => {
    const sha1Hex = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const result = hexToBytes(sha1Hex);
    expect(result.length).toBe(20);
  });
});

describe("bytesToHex", () => {
  it("converts empty array", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });

  it("converts bytes to lowercase hex", () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("pads single digits with zero", () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0x0b, 0x0c]))).toBe("0a0b0c");
  });

  it("roundtrips with hexToBytes", () => {
    const original = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    expect(bytesToHex(hexToBytes(original))).toBe(original);
  });
});
