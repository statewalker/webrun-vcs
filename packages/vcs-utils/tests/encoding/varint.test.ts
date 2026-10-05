import { describe, expect, it } from "vitest";
import {
  appendVarint,
  readOfsVarint,
  readPackHeader,
  readVarint,
  varintSize,
  writeOfsVarint,
  writePackHeader,
  writeVarint,
} from "../../src/encoding/varint.js";

describe("varint encoding", () => {
  describe("standard varint", () => {
    it("encodes and decodes single-byte values (0-127)", () => {
      for (const value of [0, 1, 63, 127]) {
        const encoded = writeVarint(value);
        expect(encoded.length).toBe(1);
        expect(encoded[0]).toBe(value);

        const decoded = readVarint(encoded, 0);
        expect(decoded.value).toBe(value);
        expect(decoded.bytesRead).toBe(1);
      }
    });

    it("encodes and decodes two-byte values (128-16383)", () => {
      for (const value of [128, 255, 1000, 16383]) {
        const encoded = writeVarint(value);
        expect(encoded.length).toBe(2);

        const decoded = readVarint(encoded, 0);
        expect(decoded.value).toBe(value);
        expect(decoded.bytesRead).toBe(2);
      }
    });

    it("encodes and decodes three-byte values", () => {
      for (const value of [16384, 100000, 2097151]) {
        const encoded = writeVarint(value);
        expect(encoded.length).toBe(3);

        const decoded = readVarint(encoded, 0);
        expect(decoded.value).toBe(value);
        expect(decoded.bytesRead).toBe(3);
      }
    });

    it("encodes and decodes large values", () => {
      const values = [0x10000, 0x100000, 0xffffff, 0x7fffffff];
      for (const value of values) {
        const encoded = writeVarint(value);
        const decoded = readVarint(encoded, 0);
        expect(decoded.value).toBe(value);
      }
    });

    it("handles offset parameter correctly", () => {
      const prefix = new Uint8Array([0xaa, 0xbb]);
      const encoded = writeVarint(1000);
      const combined = new Uint8Array([...prefix, ...encoded]);

      const decoded = readVarint(combined, 2);
      expect(decoded.value).toBe(1000);
    });

    it("throws on truncated varint", () => {
      // Varint with continuation bit set but no more bytes
      const truncated = new Uint8Array([0x80]);
      expect(() => readVarint(truncated, 0)).toThrow("Truncated varint");
    });

    it("throws on overly long varint", () => {
      // 10 continuation bytes would exceed 63 bits
      const tooLong = new Uint8Array(10).fill(0x80);
      expect(() => readVarint(tooLong, 0)).toThrow("Varint too long");
    });

    it("round-trips boundary values", () => {
      const boundaries = [
        0,
        0x7f, // 127 - max 1-byte
        0x80, // 128 - min 2-byte
        0x3fff, // 16383 - max 2-byte
        0x4000, // 16384 - min 3-byte
        0x1fffff, // 2097151 - max 3-byte
        0x200000, // 2097152 - min 4-byte
      ];

      for (const value of boundaries) {
        const encoded = writeVarint(value);
        const decoded = readVarint(encoded, 0);
        expect(decoded.value).toBe(value);
      }
    });
  });

  describe("appendVarint", () => {
    it("appends to existing array", () => {
      const output: number[] = [0xaa, 0xbb];
      appendVarint(output, 1000);

      // Verify original bytes preserved
      expect(output[0]).toBe(0xaa);
      expect(output[1]).toBe(0xbb);

      // Verify varint appended
      const decoded = readVarint(new Uint8Array(output.slice(2)), 0);
      expect(decoded.value).toBe(1000);
    });

    it("produces same output as writeVarint", () => {
      const values = [0, 127, 128, 1000, 16384, 0x100000];
      for (const value of values) {
        const output: number[] = [];
        appendVarint(output, value);
        const fromWrite = writeVarint(value);
        expect(new Uint8Array(output)).toEqual(fromWrite);
      }
    });

    it("works with empty array", () => {
      const output: number[] = [];
      appendVarint(output, 42);
      expect(output).toEqual([42]);
    });
  });

  describe("varintSize", () => {
    it("calculates correct sizes for single-byte values", () => {
      expect(varintSize(0)).toBe(1);
      expect(varintSize(1)).toBe(1);
      expect(varintSize(127)).toBe(1);
    });

    it("calculates correct sizes for multi-byte values", () => {
      expect(varintSize(128)).toBe(2);
      expect(varintSize(16383)).toBe(2);
      expect(varintSize(16384)).toBe(3);
      expect(varintSize(2097151)).toBe(3);
      expect(varintSize(2097152)).toBe(4);
    });

    it("matches actual encoded length", () => {
      const values = [0, 127, 128, 1000, 16384, 0x100000, 0x7fffffff];
      for (const value of values) {
        const encoded = writeVarint(value);
        expect(varintSize(value)).toBe(encoded.length);
      }
    });
  });

  describe("OFS varint", () => {
    it("round-trips offset values", () => {
      const values = [1, 127, 128, 1000, 0x10000, 0x100000];
      for (const value of values) {
        const encoded = writeOfsVarint(value);
        const decoded = readOfsVarint(encoded, 0);
        expect(decoded.value).toBe(value);
      }
    });

    it("handles offset parameter correctly", () => {
      const prefix = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const encoded = writeOfsVarint(5000);
      const combined = new Uint8Array([...prefix, ...encoded]);

      const decoded = readOfsVarint(combined, 3);
      expect(decoded.value).toBe(5000);
    });

    it("throws on truncated OFS varint", () => {
      const truncated = new Uint8Array([0x80]); // continuation but no next byte
      expect(() => readOfsVarint(truncated, 0)).toThrow("Truncated OFS varint");
    });

    it("throws when offset is beyond data length", () => {
      const data = new Uint8Array([0x10]);
      expect(() => readOfsVarint(data, 5)).toThrow("Truncated OFS varint");
    });

    it("encodes in big-endian order", () => {
      // Value 128 should need 2 bytes in OFS encoding
      const encoded = writeOfsVarint(128);
      expect(encoded.length).toBe(2);
      // First byte has continuation bit set
      expect(encoded[0] & 0x80).toBe(0x80);
      // Last byte has no continuation bit
      expect(encoded[1] & 0x80).toBe(0);
    });
  });

  describe("pack header", () => {
    it("round-trips type and size", () => {
      const testCases = [
        { type: 1, size: 0 },
        { type: 1, size: 15 },
        { type: 2, size: 16 },
        { type: 3, size: 15 },
        { type: 4, size: 100 },
        { type: 6, size: 1000 },
        { type: 7, size: 1000 },
        { type: 6, size: 0x10000 },
      ];

      for (const { type, size } of testCases) {
        const encoded = writePackHeader(type, size);
        const decoded = readPackHeader(encoded, 0);
        expect(decoded.type).toBe(type);
        expect(decoded.size).toBe(size);
      }
    });

    it("handles all valid object types (1-7)", () => {
      for (let type = 1; type <= 7; type++) {
        const encoded = writePackHeader(type, 42);
        const decoded = readPackHeader(encoded, 0);
        expect(decoded.type).toBe(type);
        expect(decoded.size).toBe(42);
      }
    });

    it("handles offset parameter correctly", () => {
      const prefix = new Uint8Array([0xaa, 0xbb]);
      const encoded = writePackHeader(3, 1000);
      const combined = new Uint8Array([...prefix, ...encoded]);

      const decoded = readPackHeader(combined, 2);
      expect(decoded.type).toBe(3);
      expect(decoded.size).toBe(1000);
    });

    it("throws on truncated header", () => {
      // Empty data
      expect(() => readPackHeader(new Uint8Array([]), 0)).toThrow("Truncated pack header");

      // Offset beyond data
      expect(() => readPackHeader(new Uint8Array([0x10]), 5)).toThrow("Truncated pack header");

      // Continuation bit set but no next byte
      const truncated = new Uint8Array([0x80 | (1 << 4) | 0x0f]);
      expect(() => readPackHeader(truncated, 0)).toThrow("Truncated pack header");
    });

    it("returns correct bytesRead", () => {
      // Size 0-15 fits in 4 bits, so single byte
      let header = writePackHeader(1, 15);
      let decoded = readPackHeader(header, 0);
      expect(decoded.bytesRead).toBe(1);

      // Size 16 needs second byte
      header = writePackHeader(1, 16);
      decoded = readPackHeader(header, 0);
      expect(decoded.bytesRead).toBe(2);

      // Larger sizes need more bytes
      header = writePackHeader(1, 0x10000);
      decoded = readPackHeader(header, 0);
      expect(decoded.bytesRead).toBeGreaterThan(2);
    });

    it("encodes type in bits 4-6 of first byte", () => {
      for (let type = 1; type <= 7; type++) {
        const encoded = writePackHeader(type, 0);
        const typeBits = (encoded[0] >> 4) & 0x07;
        expect(typeBits).toBe(type);
      }
    });

    it("encodes low 4 bits of size in first byte", () => {
      for (let size = 0; size <= 15; size++) {
        const encoded = writePackHeader(1, size);
        const sizeBits = encoded[0] & 0x0f;
        expect(sizeBits).toBe(size);
      }
    });
  });

  describe("integration", () => {
    it("multiple varints can be read sequentially", () => {
      const values = [100, 200, 300];
      const combined: number[] = [];

      for (const v of values) {
        appendVarint(combined, v);
      }

      const data = new Uint8Array(combined);
      let offset = 0;
      const decoded: number[] = [];

      for (let i = 0; i < values.length; i++) {
        const result = readVarint(data, offset);
        decoded.push(result.value);
        offset += result.bytesRead;
      }

      expect(decoded).toEqual(values);
    });

    it("pack header followed by data can be read correctly", () => {
      const type = 3;
      const size = 1000;
      const header = writePackHeader(type, size);

      // Simulate compressed data following header
      const compressedData = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
      const combined = new Uint8Array(header.length + compressedData.length);
      combined.set(header, 0);
      combined.set(compressedData, header.length);

      const decoded = readPackHeader(combined, 0);
      expect(decoded.type).toBe(type);
      expect(decoded.size).toBe(size);

      // Verify we can find where data starts
      const dataStart = decoded.bytesRead;
      expect(combined.subarray(dataStart)).toEqual(compressedData);
    });
  });
});
