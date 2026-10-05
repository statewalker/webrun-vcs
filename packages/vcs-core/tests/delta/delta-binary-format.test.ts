/**
 * Tests for delta binary format conversion
 *
 * Verifies round-trip conversion between Delta[] and Git binary format.
 */

import type { Delta } from "@statewalker/vcs-utils";
import { describe, expect, it } from "vitest";
import {
  formatGitDelta,
  getGitDeltaBaseSize,
  getGitDeltaResultSize,
  parseBinaryDelta,
  parseGitDelta,
  serializeDelta,
} from "../../src/storage/delta/delta-binary-format.js";

describe("delta-binary-format", () => {
  describe("serializeDelta", () => {
    it("serializes simple copy instruction", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 10 },
        { type: "copy", start: 0, len: 10 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);

      // Should produce valid binary
      expect(binary.length).toBeGreaterThan(0);

      // Parse back and verify
      const parsed = parseGitDelta(binary);
      expect(parsed.resultSize).toBe(10);
      expect(parsed.instructions).toHaveLength(1);
      expect(parsed.instructions[0]).toEqual({ type: "copy", offset: 0, size: 10 });
    });

    it("serializes simple insert instruction", () => {
      const insertData = new TextEncoder().encode("hello");
      const delta: Delta[] = [
        { type: "start", targetLen: 5 },
        { type: "insert", data: insertData },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseGitDelta(binary);

      expect(parsed.resultSize).toBe(5);
      expect(parsed.instructions).toHaveLength(1);
      expect(parsed.instructions[0].type).toBe("insert");
      if (parsed.instructions[0].type === "insert") {
        expect(new TextDecoder().decode(parsed.instructions[0].data)).toBe("hello");
      }
    });

    it("serializes mixed copy and insert", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 25 },
        { type: "copy", start: 0, len: 10 },
        { type: "insert", data: new TextEncoder().encode("middle") },
        { type: "copy", start: 20, len: 9 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseGitDelta(binary);

      expect(parsed.resultSize).toBe(25);
      expect(parsed.instructions).toHaveLength(3);
      expect(parsed.instructions[0]).toEqual({ type: "copy", offset: 0, size: 10 });
      expect(parsed.instructions[1].type).toBe("insert");
      expect(parsed.instructions[2]).toEqual({ type: "copy", offset: 20, size: 9 });
    });

    it("chunks large copies (> 64KB)", () => {
      const largeLen = 100000; // > 64KB
      const delta: Delta[] = [
        { type: "start", targetLen: largeLen },
        { type: "copy", start: 0, len: largeLen },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseGitDelta(binary);

      // Should be split into multiple copy instructions
      expect(parsed.instructions.length).toBeGreaterThan(1);

      // Total size should match
      let totalCopied = 0;
      for (const instr of parsed.instructions) {
        if (instr.type === "copy") {
          totalCopied += instr.size;
        }
      }
      expect(totalCopied).toBe(largeLen);
    });

    it("chunks large inserts (> 127 bytes)", () => {
      const largeData = new Uint8Array(200);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      const delta: Delta[] = [
        { type: "start", targetLen: 200 },
        { type: "insert", data: largeData },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseGitDelta(binary);

      // Should be split into multiple insert instructions
      expect(parsed.instructions.length).toBeGreaterThan(1);

      // Total data should match
      const combined: number[] = [];
      for (const instr of parsed.instructions) {
        if (instr.type === "insert") {
          combined.push(...instr.data);
        }
      }
      expect(combined.length).toBe(200);
      expect(new Uint8Array(combined)).toEqual(largeData);
    });

    it("handles empty delta", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 0 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseGitDelta(binary);

      expect(parsed.resultSize).toBe(0);
      expect(parsed.instructions).toHaveLength(0);
    });
  });

  describe("parseBinaryDelta", () => {
    it("parses simple copy instruction", () => {
      // Manually construct a simple delta
      // Header: base=100, result=50
      // Instruction: copy offset=10, len=50
      const delta: Delta[] = [
        { type: "start", targetLen: 50 },
        { type: "copy", start: 10, len: 50 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseBinaryDelta(binary);

      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toEqual({ type: "start", sourceLen: 60, targetLen: 50 });
      expect(parsed[1]).toEqual({ type: "copy", start: 10, len: 50 });
      expect(parsed[2]).toEqual({ type: "finish", checksum: 0 });
    });

    it("parses insert instruction", () => {
      const insertData = new TextEncoder().encode("test data");
      const delta: Delta[] = [
        { type: "start", targetLen: 9 },
        { type: "insert", data: insertData },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseBinaryDelta(binary);

      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toEqual({ type: "start", sourceLen: 0, targetLen: 9 });
      expect(parsed[1].type).toBe("insert");
      if (parsed[1].type === "insert") {
        expect(new TextDecoder().decode(parsed[1].data)).toBe("test data");
      }
    });

    it("parses mixed instructions", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 30 },
        { type: "copy", start: 0, len: 15 },
        { type: "insert", data: new TextEncoder().encode("inserted") },
        { type: "copy", start: 20, len: 7 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseBinaryDelta(binary);

      // start + 3 instructions + finish = 5
      expect(parsed).toHaveLength(5);
      expect(parsed[0].type).toBe("start");
      expect(parsed[1].type).toBe("copy");
      expect(parsed[2].type).toBe("insert");
      expect(parsed[3].type).toBe("copy");
      expect(parsed[4].type).toBe("finish");
    });
  });

  describe("round-trip", () => {
    it("preserves copy instruction", () => {
      const original: Delta[] = [
        { type: "start", targetLen: 100 },
        { type: "copy", start: 50, len: 100 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(original);
      const parsed = parseBinaryDelta(binary);

      expect(parsed[0]).toEqual({ type: "start", sourceLen: 150, targetLen: 100 });
      expect(parsed[1]).toEqual({ type: "copy", start: 50, len: 100 });
      expect(parsed[2]).toEqual({ type: "finish", checksum: 0 });
    });

    it("preserves insert data", () => {
      const testData = new Uint8Array([0, 1, 2, 255, 254, 253]);
      const original: Delta[] = [
        { type: "start", targetLen: 6 },
        { type: "insert", data: testData },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(original);
      const parsed = parseBinaryDelta(binary);

      expect(parsed[1].type).toBe("insert");
      if (parsed[1].type === "insert") {
        expect(parsed[1].data).toEqual(testData);
      }
    });

    it("handles complex delta", () => {
      const original: Delta[] = [
        { type: "start", targetLen: 500 },
        { type: "copy", start: 0, len: 100 },
        { type: "insert", data: new TextEncoder().encode("middle section") },
        { type: "copy", start: 200, len: 150 },
        { type: "insert", data: new TextEncoder().encode("end") },
        { type: "copy", start: 500, len: 236 - 14 - 3 }, // Adjust to match targetLen
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(original);
      const parsed = parseBinaryDelta(binary);

      // Verify structure preserved
      expect(parsed[0].type).toBe("start");
      expect((parsed[0] as Extract<Delta, { type: "start" }>).targetLen).toBe(500);

      // Count instructions (excluding start/finish)
      const instructions = parsed.filter((d) => d.type !== "start" && d.type !== "finish");
      expect(instructions.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("helper functions", () => {
    it("getGitDeltaBaseSize returns base size", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 100 },
        { type: "copy", start: 50, len: 100 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const baseSize = getGitDeltaBaseSize(binary);

      // Base size is calculated from copy instructions
      expect(baseSize).toBe(150); // start=50 + len=100
    });

    it("getGitDeltaResultSize returns result size", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 42 },
        { type: "copy", start: 0, len: 42 },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const resultSize = getGitDeltaResultSize(binary);

      expect(resultSize).toBe(42);
    });

    it("formatGitDelta produces readable output", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 15 },
        { type: "copy", start: 0, len: 10 },
        { type: "insert", data: new TextEncoder().encode("hello") },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const formatted = formatGitDelta(binary);

      expect(formatted).toContain("DELTA");
      expect(formatted).toContain("COPY");
      expect(formatted).toContain("INSERT");
      expect(formatted).toContain("hello");
    });
  });

  describe("edge cases", () => {
    it("handles zero-length copy", () => {
      const delta: Delta[] = [
        { type: "start", targetLen: 5 },
        { type: "copy", start: 0, len: 0 }, // Should be skipped
        { type: "insert", data: new TextEncoder().encode("hello") },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseBinaryDelta(binary);

      // Zero-length copy should be omitted
      expect(parsed.filter((d) => d.type === "copy")).toHaveLength(0);
    });

    it("handles offset at various positions", () => {
      // Test offsets that exercise different byte encodings
      const offsets = [0, 1, 127, 128, 255, 256, 65535, 65536];

      for (const offset of offsets) {
        const delta: Delta[] = [
          { type: "start", targetLen: 10 },
          { type: "copy", start: offset, len: 10 },
          { type: "finish", checksum: 0 },
        ];

        const binary = serializeDelta(delta);
        const parsed = parseBinaryDelta(binary);

        expect(parsed[1]).toEqual({ type: "copy", start: offset, len: 10 });
      }
    });

    it("handles copy length at boundary (64KB)", () => {
      const len = 0x10000; // Exactly 64KB - special case in encoding
      const delta: Delta[] = [
        { type: "start", targetLen: len },
        { type: "copy", start: 0, len },
        { type: "finish", checksum: 0 },
      ];

      const binary = serializeDelta(delta);
      const parsed = parseBinaryDelta(binary);

      expect(parsed[1]).toEqual({ type: "copy", start: 0, len });
    });
  });
});
