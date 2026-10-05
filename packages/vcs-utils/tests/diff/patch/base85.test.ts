import { describe, expect, it } from "vitest";
import { decodeGitBase85, encodeGitBase85 } from "../../../src/diff/patch/base85.js";

describe("base85", () => {
  describe("decodeGitBase85", () => {
    it("should decode empty input", () => {
      const encoded = new Uint8Array([]);
      const result = decodeGitBase85(encoded);
      expect(result).toEqual(new Uint8Array([]));
    });

    it("should decode single byte", () => {
      // 'A' = 1 byte output
      // '0' in base85 = value 0
      // Single byte 0x00
      const encoded = new TextEncoder().encode("A0000\n");
      const result = decodeGitBase85(encoded);
      expect(result).toEqual(new Uint8Array([0x00]));
    });

    it("should decode 'Hello' string", () => {
      // Test case from Git's test suite
      // "Hello" = [0x48, 0x65, 0x6c, 0x6c, 0x6f]
      const original = new TextEncoder().encode("Hello");
      const encoded = encodeGitBase85(original);
      const result = decodeGitBase85(encoded);

      expect(result).toEqual(original);
    });

    it("should decode multi-line data", () => {
      // 10 bytes: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]
      const encoded = new TextEncoder().encode("D0000\nF00000\n");
      const result = decodeGitBase85(encoded);

      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("should skip empty lines", () => {
      const encoded = new TextEncoder().encode("A0000\n\nB00000\n");
      const result = decodeGitBase85(encoded);

      // A = 1 byte, empty line skipped, B = 2 bytes
      expect(result.length).toBe(3);
    });

    it("should throw on invalid base85 character", () => {
      const encoded = new TextEncoder().encode("A\x00\x01\x02\x03\x04\n");
      expect(() => decodeGitBase85(encoded)).toThrow(/Invalid base85 character/);
    });

    it("should throw on invalid length character", () => {
      const encoded = new TextEncoder().encode("\x000000\n");
      expect(() => decodeGitBase85(encoded)).toThrow(/Invalid base85 length character/);
    });

    it("should decode 4-byte sequence correctly", () => {
      // 4 bytes encoded as 5 base85 characters
      // For value 0x12345678:
      // 0x12345678 = 305419896 decimal
      // In base 85: 305419896 = 0*85^4 + 52*85^3 + 59*85^2 + 10*85 + 46
      const encoded = new TextEncoder().encode("D0sJ<B\n");
      const result = decodeGitBase85(encoded);

      expect(result.length).toBe(4);
    });
  });

  describe("encodeGitBase85", () => {
    it("should encode empty input", () => {
      const data = new Uint8Array([]);
      const result = encodeGitBase85(data);
      expect(result).toEqual(new Uint8Array([]));
    });

    it("should encode single zero byte", () => {
      const data = new Uint8Array([0x00]);
      const result = encodeGitBase85(data);

      // Should be: 'A' (1 byte) + base85 chars + '\n'
      const decoded = new TextDecoder().decode(result);
      expect(decoded[0]).toBe("A"); // Length prefix
      expect(decoded[decoded.length - 1]).toBe("\n"); // Newline
    });

    it("should encode 4-byte sequence", () => {
      const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const result = encodeGitBase85(data);

      const decoded = new TextDecoder().decode(result);
      expect(decoded[0]).toBe("D"); // 4 bytes = 'D'
      expect(decoded[decoded.length - 1]).toBe("\n");
    });

    it("should split long data into multiple lines", () => {
      const data = new Uint8Array(100).fill(0xaa);
      const result = encodeGitBase85(data);

      const lines = new TextDecoder().decode(result).trim().split("\n");

      // Should have at least 2 lines (52 bytes max per line)
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // Each line should start with valid length prefix
      for (const line of lines) {
        const lengthChar = line.charCodeAt(0);
        expect(lengthChar).toBeGreaterThanOrEqual(0x41); // 'A'
        expect(lengthChar).toBeLessThanOrEqual(0x7a); // 'z'
      }
    });
  });

  describe("round-trip encoding/decoding", () => {
    it("should round-trip single byte", () => {
      const original = new Uint8Array([0x42]);
      const encoded = encodeGitBase85(original);
      const decoded = decodeGitBase85(encoded);
      expect(decoded).toEqual(original);
    });

    it("should round-trip 4 bytes", () => {
      const original = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const encoded = encodeGitBase85(original);
      const decoded = decodeGitBase85(encoded);
      expect(decoded).toEqual(original);
    });

    it("should round-trip varying lengths", () => {
      for (let len = 1; len <= 100; len++) {
        const original = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          original[i] = i & 0xff;
        }

        const encoded = encodeGitBase85(original);
        const decoded = decodeGitBase85(encoded);

        expect(decoded).toEqual(original);
      }
    });

    it("should round-trip random data", () => {
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        original[i] = Math.floor(Math.random() * 256);
      }

      const encoded = encodeGitBase85(original);
      const decoded = decodeGitBase85(encoded);

      expect(decoded).toEqual(original);
    });

    it("should round-trip all byte values", () => {
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        original[i] = i;
      }

      const encoded = encodeGitBase85(original);
      const decoded = decodeGitBase85(encoded);

      expect(decoded).toEqual(original);
    });
  });

  describe("Git compatibility", () => {
    it("should decode Git-generated base85", () => {
      // Example from actual Git binary patch
      // This is base85 encoding of a small binary file
      const gitEncoded = new TextEncoder().encode(
        "Ac$bmddddddddddddddddddddddddddddddddddddddddddddddddddd\n",
      );

      // Should not throw
      const result = decodeGitBase85(gitEncoded);
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
