/**
 * Tests for varint encoding/decoding utilities
 */

import { describe, expect, it } from "vitest";
import {
  readOfsVarint,
  readPackHeader,
  readVarint,
  writeOfsVarint,
  writePackHeader,
  writeVarint,
} from "../../src/pack/varint.js";

describe("readVarint / writeVarint", () => {
  it("encodes and decodes single-byte values", () => {
    for (const value of [0, 1, 127]) {
      const encoded = writeVarint(value);
      expect(encoded.length).toBe(1);

      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
      expect(result.bytesRead).toBe(1);
    }
  });

  it("encodes and decodes two-byte values", () => {
    for (const value of [128, 255, 16383]) {
      const encoded = writeVarint(value);
      expect(encoded.length).toBe(2);

      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
      expect(result.bytesRead).toBe(2);
    }
  });

  it("encodes and decodes three-byte values", () => {
    for (const value of [16384, 65535, 2097151]) {
      const encoded = writeVarint(value);
      expect(encoded.length).toBe(3);

      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
      expect(result.bytesRead).toBe(3);
    }
  });

  it("encodes and decodes larger values", () => {
    const values = [2097152, 0xffffff, 0x7fffffff];
    for (const value of values) {
      const encoded = writeVarint(value);
      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
    }
  });

  it("reads from offset correctly", () => {
    const padding = new Uint8Array([0xff, 0xff, 0xff]);
    const encoded = writeVarint(1000);
    const combined = new Uint8Array(padding.length + encoded.length);
    combined.set(padding, 0);
    combined.set(encoded, padding.length);

    const result = readVarint(combined, 3);
    expect(result.value).toBe(1000);
  });

  it("throws on truncated varint", () => {
    const truncated = new Uint8Array([0x80]); // continuation bit set but no more bytes
    expect(() => readVarint(truncated, 0)).toThrow("Truncated varint");
  });

  it("throws on empty input", () => {
    expect(() => readVarint(new Uint8Array(0), 0)).toThrow("Truncated varint");
  });
});

describe("readOfsVarint / writeOfsVarint", () => {
  it("encodes and decodes single-byte values", () => {
    for (const value of [0, 1, 127]) {
      const encoded = writeOfsVarint(value);
      expect(encoded.length).toBe(1);

      const result = readOfsVarint(encoded, 0);
      expect(result.value).toBe(value);
      expect(result.bytesRead).toBe(1);
    }
  });

  it("encodes and decodes two-byte values", () => {
    // OFS varint has different encoding - continuation adds 1
    const encoded = writeOfsVarint(128);
    const result = readOfsVarint(encoded, 0);
    expect(result.value).toBe(128);
  });

  it("encodes and decodes larger values", () => {
    const values = [1000, 10000, 100000, 1000000];
    for (const value of values) {
      const encoded = writeOfsVarint(value);
      const result = readOfsVarint(encoded, 0);
      expect(result.value).toBe(value);
    }
  });

  it("reads from offset correctly", () => {
    const padding = new Uint8Array([0x00, 0x00]);
    const encoded = writeOfsVarint(500);
    const combined = new Uint8Array(padding.length + encoded.length);
    combined.set(padding, 0);
    combined.set(encoded, padding.length);

    const result = readOfsVarint(combined, 2);
    expect(result.value).toBe(500);
  });

  it("throws on truncated OFS varint", () => {
    const truncated = new Uint8Array([0x80]); // continuation bit set but no more bytes
    expect(() => readOfsVarint(truncated, 0)).toThrow("Truncated OFS varint");
  });

  it("throws on empty input", () => {
    expect(() => readOfsVarint(new Uint8Array(0), 0)).toThrow("Truncated OFS varint");
  });
});

describe("readPackHeader / writePackHeader", () => {
  it("encodes and decodes small objects", () => {
    const type = 1; // commit
    const size = 10;

    const encoded = writePackHeader(type, size);
    expect(encoded.length).toBe(1);

    const result = readPackHeader(encoded, 0);
    expect(result.type).toBe(type);
    expect(result.size).toBe(size);
    expect(result.bytesRead).toBe(1);
  });

  it("encodes and decodes objects with size > 15", () => {
    const type = 2; // tree
    const size = 100;

    const encoded = writePackHeader(type, size);
    expect(encoded.length).toBe(2);

    const result = readPackHeader(encoded, 0);
    expect(result.type).toBe(type);
    expect(result.size).toBe(size);
    expect(result.bytesRead).toBe(2);
  });

  it("encodes and decodes large objects", () => {
    const type = 3; // blob
    const sizes = [1000, 10000, 100000, 1000000];

    for (const size of sizes) {
      const encoded = writePackHeader(type, size);
      const result = readPackHeader(encoded, 0);
      expect(result.type).toBe(type);
      expect(result.size).toBe(size);
    }
  });

  it("handles all object types", () => {
    for (let type = 1; type <= 7; type++) {
      const size = 256;
      const encoded = writePackHeader(type, size);
      const result = readPackHeader(encoded, 0);
      expect(result.type).toBe(type);
      expect(result.size).toBe(size);
    }
  });

  it("reads from offset correctly", () => {
    const padding = new Uint8Array([0x00, 0x00, 0x00]);
    const encoded = writePackHeader(4, 500);
    const combined = new Uint8Array(padding.length + encoded.length);
    combined.set(padding, 0);
    combined.set(encoded, padding.length);

    const result = readPackHeader(combined, 3);
    expect(result.type).toBe(4);
    expect(result.size).toBe(500);
  });

  it("handles zero size", () => {
    const type = 1;
    const size = 0;

    const encoded = writePackHeader(type, size);
    const result = readPackHeader(encoded, 0);
    expect(result.type).toBe(type);
    expect(result.size).toBe(0);
  });

  it("throws on truncated header", () => {
    const truncated = new Uint8Array([0x91]); // continuation bit set but no more bytes
    expect(() => readPackHeader(truncated, 0)).toThrow("Truncated pack header");
  });

  it("throws on empty input", () => {
    expect(() => readPackHeader(new Uint8Array(0), 0)).toThrow("Truncated pack header");
  });
});

describe("varint edge cases", () => {
  it("roundtrips power of 2 values", () => {
    for (let i = 0; i < 28; i++) {
      const value = 1 << i;
      const encoded = writeVarint(value);
      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
    }
  });

  it("roundtrips power of 2 minus 1 values", () => {
    for (let i = 1; i < 28; i++) {
      const value = (1 << i) - 1;
      const encoded = writeVarint(value);
      const result = readVarint(encoded, 0);
      expect(result.value).toBe(value);
    }
  });

  it("handles boundary values between byte sizes", () => {
    // 127 = max 1-byte value, 128 = min 2-byte value
    const encoded127 = writeVarint(127);
    const encoded128 = writeVarint(128);

    expect(encoded127.length).toBe(1);
    expect(encoded128.length).toBe(2);

    expect(readVarint(encoded127, 0).value).toBe(127);
    expect(readVarint(encoded128, 0).value).toBe(128);
  });
});
