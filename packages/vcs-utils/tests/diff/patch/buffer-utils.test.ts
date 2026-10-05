import { describe, expect, it } from "vitest";
import {
  decode,
  encodeASCII,
  isHunkHdr,
  match,
  nextLF,
  parseBase10,
  prevLF,
} from "../../../src/diff/patch/buffer-utils.js";

describe("buffer-utils", () => {
  describe("match", () => {
    it("should match pattern at beginning", () => {
      const buffer = new TextEncoder().encode("hello world");
      const pattern = new TextEncoder().encode("hello");
      expect(match(buffer, 0, pattern)).toBe(5);
    });

    it("should match pattern at offset", () => {
      const buffer = new TextEncoder().encode("hello world");
      const pattern = new TextEncoder().encode("world");
      expect(match(buffer, 6, pattern)).toBe(5);
    });

    it("should return -1 when pattern does not match", () => {
      const buffer = new TextEncoder().encode("hello world");
      const pattern = new TextEncoder().encode("foo");
      expect(match(buffer, 0, pattern)).toBe(-1);
    });

    it("should return -1 when pattern extends beyond buffer", () => {
      const buffer = new TextEncoder().encode("hello");
      const pattern = new TextEncoder().encode("hello world");
      expect(match(buffer, 0, pattern)).toBe(-1);
    });
  });

  describe("nextLF", () => {
    it("should find next newline", () => {
      const buffer = new TextEncoder().encode("line1\nline2\n");
      expect(nextLF(buffer, 0)).toBe(6); // After first \n
    });

    it("should find subsequent newlines", () => {
      const buffer = new TextEncoder().encode("line1\nline2\nline3\n");
      expect(nextLF(buffer, 6)).toBe(12); // After second \n
    });

    it("should return buffer length when no newline found", () => {
      const buffer = new TextEncoder().encode("no newline");
      expect(nextLF(buffer, 0)).toBe(buffer.length);
    });
  });

  describe("prevLF", () => {
    it("should find previous newline", () => {
      const buffer = new TextEncoder().encode("line1\nline2\nline3");
      expect(prevLF(buffer, 12)).toBe(12); // After second \n (at index 11)
    });

    it("should return 0 when no previous newline", () => {
      const buffer = new TextEncoder().encode("no newline");
      expect(prevLF(buffer, 5)).toBe(0);
    });
  });

  describe("isHunkHdr", () => {
    it("should recognize valid hunk header", () => {
      const buffer = new TextEncoder().encode("@@ -10,7 +10,8 @@\n");
      expect(isHunkHdr(buffer, 0, buffer.length)).toBe(1);
    });

    it("should recognize minimal hunk header", () => {
      const buffer = new TextEncoder().encode("@@ -0,0 +0,0 @@\n");
      expect(isHunkHdr(buffer, 0, buffer.length)).toBe(1);
    });

    it("should reject non-hunk header", () => {
      const buffer = new TextEncoder().encode("not a hunk\n");
      expect(isHunkHdr(buffer, 0, buffer.length)).toBe(0);
    });

    it("should reject malformed hunk header", () => {
      const buffer = new TextEncoder().encode("@@ missing minus\n");
      expect(isHunkHdr(buffer, 0, buffer.length)).toBe(0);
    });

    it("should reject too short header", () => {
      const buffer = new TextEncoder().encode("@@ -\n");
      expect(isHunkHdr(buffer, 0, buffer.length)).toBe(0);
    });
  });

  describe("decode", () => {
    it("should decode UTF-8 string", () => {
      const buffer = new TextEncoder().encode("hello world");
      expect(decode(buffer, 0, buffer.length)).toBe("hello world");
    });

    it("should decode substring", () => {
      const buffer = new TextEncoder().encode("hello world");
      expect(decode(buffer, 6, 11)).toBe("world");
    });
  });

  describe("encodeASCII", () => {
    it("should encode string to bytes", () => {
      const result = encodeASCII("hello");
      expect(result).toEqual(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    });
  });

  describe("parseBase10", () => {
    it("should parse positive number", () => {
      const buffer = new TextEncoder().encode("123");
      const [value, offset] = parseBase10(buffer, 0);
      expect(value).toBe(123);
      expect(offset).toBe(3);
    });

    it("should parse negative number", () => {
      const buffer = new TextEncoder().encode("-456");
      const [value, offset] = parseBase10(buffer, 0);
      expect(value).toBe(-456);
      expect(offset).toBe(4);
    });

    it("should stop at non-digit", () => {
      const buffer = new TextEncoder().encode("123abc");
      const [value, offset] = parseBase10(buffer, 0);
      expect(value).toBe(123);
      expect(offset).toBe(3);
    });

    it("should handle zero", () => {
      const buffer = new TextEncoder().encode("0");
      const [value, offset] = parseBase10(buffer, 0);
      expect(value).toBe(0);
      expect(offset).toBe(1);
    });

    it("should return start offset when no number found", () => {
      const buffer = new TextEncoder().encode("abc");
      const [value, offset] = parseBase10(buffer, 0);
      expect(value).toBe(0);
      expect(offset).toBe(0);
    });
  });
});
