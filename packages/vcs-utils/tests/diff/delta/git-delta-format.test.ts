/**
 * Tests for Git binary delta format encoder/decoder
 *
 * Based on JGit's DeltaIndexTest.java and BinaryDelta.java patterns
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit.test/tst/org/eclipse/jgit/internal/storage/pack/DeltaIndexTest.java
 */

import { describe, expect, it } from "vitest";
import {
  createDelta,
  createDeltaRanges,
  createFossilLikeRanges,
  type DeltaRange,
  deltaRangesToGitFormat,
  deltaToGitFormat,
  formatGitDelta,
  getGitDeltaBaseSize,
  getGitDeltaResultSize,
  gitFormatToDeltaRanges,
  parseGitDelta,
} from "../../../src/diff/index.js";
import { decodeGitBinaryDelta } from "../../../src/diff/patch/binary-delta.js";

// Helper to create random bytes
function randomBytes(length: number, seed = 42): Uint8Array {
  const result = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    // Simple LCG random number generator
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    result[i] = state & 0xff;
  }
  return result;
}

// Helper to encode string to Uint8Array
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// Helper to concatenate Uint8Arrays
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

describe("deltaRangesToGitFormat", () => {
  // ========== Basic Operations (from JGit DeltaIndexTest) ==========

  describe("basic operations", () => {
    it("testInsertWholeObject_Length12", () => {
      // Pure insert of 12 bytes
      const target = randomBytes(12);
      const ranges: DeltaRange[] = [{ from: "target", start: 0, len: 12 }];

      const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
      const result = decodeGitBinaryDelta(new Uint8Array(0), delta);

      expect(result).toEqual(target);
    });

    it("testCopyWholeObject_Length128", () => {
      // Pure copy of 128 bytes
      const src = randomBytes(128);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 128 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      const result = decodeGitBinaryDelta(src, delta);

      expect(result).toEqual(src);
      // Delta should be compact: header + 1 copy instruction
      expect(delta.length).toBeLessThan(20);
    });

    it("testCopyWholeObject_Length123", () => {
      // Non-power-of-2 copy
      const src = randomBytes(123);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 123 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });

    it("testCopyZeros_Length2048", () => {
      // All zeros (tests edge cases)
      const src = new Uint8Array(2048);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 2048 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });
  });

  // ========== Shuffled/Reordered Operations ==========

  describe("shuffled segments", () => {
    it("testShuffleSegments", () => {
      // Target = second half, then first half
      const src = randomBytes(128);
      const target = new Uint8Array(128);
      target.set(src.subarray(64, 128), 0);
      target.set(src.subarray(0, 64), 64);

      const ranges: DeltaRange[] = [
        { from: "source", start: 64, len: 64 },
        { from: "source", start: 0, len: 64 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("testReversedSegments", () => {
      // 4 segments in reverse order
      const src = randomBytes(256);
      const target = new Uint8Array(256);
      target.set(src.subarray(192, 256), 0);
      target.set(src.subarray(128, 192), 64);
      target.set(src.subarray(64, 128), 128);
      target.set(src.subarray(0, 64), 192);

      const ranges: DeltaRange[] = [
        { from: "source", start: 192, len: 64 },
        { from: "source", start: 128, len: 64 },
        { from: "source", start: 64, len: 64 },
        { from: "source", start: 0, len: 64 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });
  });

  // ========== Insert Mixed Operations ==========

  describe("insert operations", () => {
    it("testInsertHead", () => {
      // Insert at beginning
      const src = randomBytes(1024);
      const target = concat(encode("HEAD"), src);
      const ranges: DeltaRange[] = [
        { from: "target", start: 0, len: 4 },
        { from: "source", start: 0, len: 1024 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("testInsertTail", () => {
      // Insert at end
      const src = randomBytes(1024);
      const target = concat(src, encode("TAIL"));
      const ranges: DeltaRange[] = [
        { from: "source", start: 0, len: 1024 },
        { from: "target", start: 1024, len: 4 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("testInsertMiddle", () => {
      // Insert in middle
      const src = randomBytes(1024);
      const target = concat(src.subarray(0, 512), encode("MIDDLE"), src.subarray(512));
      const ranges: DeltaRange[] = [
        { from: "source", start: 0, len: 512 },
        { from: "target", start: 512, len: 6 },
        { from: "source", start: 512, len: 512 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("testInsertHeadMiddleTail (from DeltaIndexTest.testInsertHeadMiddle)", () => {
      // Multiple inserts
      const src = randomBytes(1024);
      const target = concat(
        encode("foo"),
        src.subarray(0, 512),
        encode("yet more fooery"),
        src.subarray(0, 512),
      );
      const ranges: DeltaRange[] = [
        { from: "target", start: 0, len: 3 },
        { from: "source", start: 0, len: 512 },
        { from: "target", start: 515, len: 15 },
        { from: "source", start: 0, len: 512 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });
  });

  // ========== Chunking Tests (MAX_V2_COPY = 64KB, MAX_INSERT = 127) ==========

  describe("chunking", () => {
    it("should chunk copies > 64KB (MAX_V2_COPY)", () => {
      // 128KB copy requires 2 instructions
      const src = randomBytes(128 * 1024);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 128 * 1024 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      const result = decodeGitBinaryDelta(src, delta);

      expect(result).toEqual(src);
    });

    it("should chunk copies at exact 64KB boundary", () => {
      // Exactly 64KB (no chunking needed)
      const src = randomBytes(64 * 1024);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 64 * 1024 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });

    it("should chunk copies at 64KB + 1", () => {
      // 64KB + 1 requires 2 instructions
      const size = 64 * 1024 + 1;
      const src = randomBytes(size);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: size }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });

    it("should chunk inserts > 127 bytes (MAX_INSERT_DATA_SIZE)", () => {
      const target = randomBytes(1024);
      const ranges: DeltaRange[] = [{ from: "target", start: 0, len: 1024 }];

      const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
      expect(decodeGitBinaryDelta(new Uint8Array(0), delta)).toEqual(target);
    });

    it("should chunk inserts at 127/128/129 boundary", () => {
      for (const size of [127, 128, 129, 255, 256]) {
        const target = randomBytes(size);
        const ranges: DeltaRange[] = [{ from: "target", start: 0, len: size }];

        const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
        expect(decodeGitBinaryDelta(new Uint8Array(0), delta)).toEqual(target);
      }
    });
  });

  // ========== Offset Encoding (Sparse Byte Encoding) ==========

  describe("offset encoding", () => {
    it("should encode zero offset", () => {
      const src = randomBytes(256);
      const target = src.subarray(0, 128);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 128 }];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("should encode 1-byte offset (< 256)", () => {
      const src = randomBytes(512);
      const target = src.subarray(100, 228);
      const ranges: DeltaRange[] = [{ from: "source", start: 100, len: 128 }];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("should encode 2-byte offset (< 65536)", () => {
      const src = randomBytes(70000);
      const target = src.subarray(60000, 61000);
      const ranges: DeltaRange[] = [{ from: "source", start: 60000, len: 1000 }];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("should encode 3-byte offset (< 16MB)", () => {
      const src = randomBytes(5000000);
      const target = src.subarray(4000000, 4001000);
      const ranges: DeltaRange[] = [{ from: "source", start: 4000000, len: 1000 }];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });
  });

  // ========== Size Limit Tests (from DeltaIndexTest) ==========

  describe("size limits", () => {
    it("testLimitObjectSize_Length12InsertFails", () => {
      // Delta larger than original should be rejected by caller
      const src = randomBytes(12);
      const ranges: DeltaRange[] = [{ from: "target", start: 0, len: 12 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      // For insert-only deltas on small objects, delta may be larger than original
      // This is expected behavior - caller decides if delta is worth using
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });

    it("testLimitObjectSize_Length130CopyOk", () => {
      const src = randomBytes(130);
      const ranges: DeltaRange[] = [{ from: "source", start: 0, len: 130 }];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
      // Copy should be efficient
      expect(delta.length).toBeLessThan(src.length);
    });
  });

  // ========== Empty/Edge Cases ==========

  describe("edge cases", () => {
    it("should handle empty ranges", () => {
      const src = randomBytes(100);
      const target = new Uint8Array(0);
      const ranges: DeltaRange[] = [];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("should handle empty source with inserts", () => {
      const target = encode("new content");
      const ranges: DeltaRange[] = [{ from: "target", start: 0, len: target.length }];

      const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
      expect(decodeGitBinaryDelta(new Uint8Array(0), delta)).toEqual(target);
    });

    it("should handle zero-length copy", () => {
      // Zero-length ranges should be skipped
      const src = randomBytes(100);
      const target = randomBytes(50);
      const ranges: DeltaRange[] = [
        { from: "source", start: 0, len: 0 }, // Skip
        { from: "target", start: 0, len: 50 },
      ];

      const delta = deltaRangesToGitFormat(src, target, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(target);
    });

    it("should handle zero-length insert", () => {
      const src = randomBytes(100);
      const ranges: DeltaRange[] = [
        { from: "target", start: 0, len: 0 }, // Skip
        { from: "source", start: 0, len: 100 },
      ];

      const delta = deltaRangesToGitFormat(src, src, ranges);
      expect(decodeGitBinaryDelta(src, delta)).toEqual(src);
    });
  });
});

describe("rolling hash to git format roundtrip", () => {
  describe("createDeltaRanges integration", () => {
    it("should roundtrip identical content", () => {
      const data = randomBytes(1024);
      const ranges = [...createDeltaRanges(data, data)];

      const delta = deltaRangesToGitFormat(data, data, ranges);
      expect(decodeGitBinaryDelta(data, delta)).toEqual(data);
    });

    it("should roundtrip with single byte change", () => {
      const base = randomBytes(1024);
      const target = new Uint8Array(base);
      target[512] = base[512] ^ 0xff;

      const ranges = [...createDeltaRanges(base, target)];
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(decodeGitBinaryDelta(base, delta)).toEqual(target);
    });

    it("should roundtrip with insertion", () => {
      const base = randomBytes(1024);
      const target = concat(base.subarray(0, 512), encode("inserted text"), base.subarray(512));

      const ranges = [...createDeltaRanges(base, target)];
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(decodeGitBinaryDelta(base, delta)).toEqual(target);
    });

    it("should roundtrip with deletion", () => {
      const base = randomBytes(1024);
      const target = concat(base.subarray(0, 256), base.subarray(768));

      const ranges = [...createDeltaRanges(base, target)];
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(decodeGitBinaryDelta(base, delta)).toEqual(target);
    });

    it("should roundtrip text files", () => {
      const base = encode(`line 1
line 2
line 3
line 4
line 5`);
      const target = encode(`line 1
modified line 2
line 3
new line
line 4
line 5`);

      const ranges = [...createDeltaRanges(base, target)];
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(decodeGitBinaryDelta(base, delta)).toEqual(target);
    });
  });

  describe("createFossilLikeRanges integration", () => {
    it("should roundtrip with fossil-style ranges", () => {
      const base = randomBytes(4096);
      const target = new Uint8Array(base);
      // Modify several scattered locations
      target[100] = 0xaa;
      target[1000] = 0xbb;
      target[3000] = 0xcc;

      const ranges = [...createFossilLikeRanges(base, target)];
      const delta = deltaRangesToGitFormat(base, target, ranges);

      expect(decodeGitBinaryDelta(base, delta)).toEqual(target);
    });
  });

  describe("Delta[] integration", () => {
    it("should convert Delta[] from createDelta", () => {
      const base = randomBytes(1024);
      const target = concat(base.subarray(0, 512), encode("middle"), base.subarray(512));

      const ranges = [...createDeltaRanges(base, target)];
      const deltas = [...createDelta(base, target, ranges)];

      const gitDelta = deltaToGitFormat(base.length, deltas);
      expect(decodeGitBinaryDelta(base, gitDelta)).toEqual(target);
    });
  });
});

describe("parseGitDelta and gitFormatToDeltaRanges", () => {
  it("should parse delta with copy instruction", () => {
    const src = randomBytes(256);
    const ranges: DeltaRange[] = [{ from: "source", start: 64, len: 128 }];

    const delta = deltaRangesToGitFormat(src, src.subarray(64, 192), ranges);
    const parsed = parseGitDelta(delta);

    expect(parsed.baseSize).toBe(256);
    expect(parsed.resultSize).toBe(128);
    expect(parsed.instructions.length).toBe(1);
    expect(parsed.instructions[0].type).toBe("copy");
    if (parsed.instructions[0].type === "copy") {
      expect(parsed.instructions[0].offset).toBe(64);
      expect(parsed.instructions[0].size).toBe(128);
    }
  });

  it("should parse delta with insert instruction", () => {
    const target = encode("hello");
    const ranges: DeltaRange[] = [{ from: "target", start: 0, len: 5 }];

    const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
    const parsed = parseGitDelta(delta);

    expect(parsed.baseSize).toBe(0);
    expect(parsed.resultSize).toBe(5);
    expect(parsed.instructions.length).toBe(1);
    expect(parsed.instructions[0].type).toBe("insert");
    if (parsed.instructions[0].type === "insert") {
      expect(parsed.instructions[0].data).toEqual(target);
    }
  });

  it("should roundtrip through gitFormatToDeltaRanges", () => {
    const src = randomBytes(100);
    const target = concat(encode("pre"), src.subarray(0, 50), encode("post"));
    const originalRanges: DeltaRange[] = [
      { from: "target", start: 0, len: 3 },
      { from: "source", start: 0, len: 50 },
      { from: "target", start: 53, len: 4 },
    ];

    const delta = deltaRangesToGitFormat(src, target, originalRanges);
    const parsedRanges = gitFormatToDeltaRanges(delta);

    // Apply parsed ranges to reconstruct target
    let reconstructed = new Uint8Array(0);
    for (const range of parsedRanges) {
      if (range.from === "source") {
        reconstructed = concat(reconstructed, src.subarray(range.start, range.start + range.len));
      } else {
        reconstructed = concat(
          reconstructed,
          target.subarray(range.start, range.start + range.len),
        );
      }
    }

    expect(reconstructed).toEqual(target);
  });
});

describe("formatGitDelta (human-readable)", () => {
  it("should format header", () => {
    const delta = deltaRangesToGitFormat(new Uint8Array(100), new Uint8Array(200), []);
    const formatted = formatGitDelta(delta);

    expect(formatted).toContain("BASE=100");
    expect(formatted).toContain("RESULT=200");
  });

  it("should format COPY instruction", () => {
    const src = randomBytes(256);
    const ranges: DeltaRange[] = [{ from: "source", start: 64, len: 128 }];

    const delta = deltaRangesToGitFormat(src, src.subarray(64, 192), ranges);
    const formatted = formatGitDelta(delta);

    expect(formatted).toContain("COPY");
    expect(formatted).toContain("64");
    expect(formatted).toContain("128");
  });

  it("should format INSERT instruction", () => {
    const target = encode("hello");
    const ranges: DeltaRange[] = [{ from: "target", start: 0, len: 5 }];

    const delta = deltaRangesToGitFormat(new Uint8Array(0), target, ranges);
    const formatted = formatGitDelta(delta);

    expect(formatted).toContain("INSERT");
    expect(formatted).toContain("hello");
  });

  it("should format mixed instructions", () => {
    const src = randomBytes(100);
    const target = concat(encode("pre"), src.subarray(0, 50), encode("post"));
    const ranges: DeltaRange[] = [
      { from: "target", start: 0, len: 3 },
      { from: "source", start: 0, len: 50 },
      { from: "target", start: 53, len: 4 },
    ];

    const delta = deltaRangesToGitFormat(src, target, ranges);
    const formatted = formatGitDelta(delta);

    expect(formatted).toMatch(/INSERT.*pre/);
    expect(formatted).toMatch(/COPY.*0.*50/);
    expect(formatted).toMatch(/INSERT.*post/);
  });

  it("should hide header when requested", () => {
    const delta = deltaRangesToGitFormat(new Uint8Array(100), new Uint8Array(200), []);
    const formatted = formatGitDelta(delta, false);

    expect(formatted).not.toContain("BASE=");
    expect(formatted).not.toContain("RESULT=");
  });
});

describe("getGitDeltaBaseSize and getGitDeltaResultSize", () => {
  it("should return correct base size", () => {
    const delta = deltaRangesToGitFormat(new Uint8Array(12345), new Uint8Array(6789), []);
    expect(getGitDeltaBaseSize(delta)).toBe(12345);
  });

  it("should return correct result size", () => {
    const delta = deltaRangesToGitFormat(new Uint8Array(12345), new Uint8Array(6789), []);
    expect(getGitDeltaResultSize(delta)).toBe(6789);
  });

  it("should handle large sizes with multi-byte varints", () => {
    // Size > 127 requires multi-byte encoding
    const delta = deltaRangesToGitFormat(new Uint8Array(1000000), new Uint8Array(2000000), []);
    expect(getGitDeltaBaseSize(delta)).toBe(1000000);
    expect(getGitDeltaResultSize(delta)).toBe(2000000);
  });
});

describe("deltaToGitFormat", () => {
  it("should convert Delta[] to Git format", () => {
    const base = randomBytes(1024);
    const target = concat(base.subarray(0, 512), encode("middle"), base.subarray(512));

    const ranges = [...createDeltaRanges(base, target)];
    const deltas = [...createDelta(base, target, ranges)];

    const gitDelta = deltaToGitFormat(base.length, deltas);
    expect(decodeGitBinaryDelta(base, gitDelta)).toEqual(target);
  });

  it("should handle Delta[] with only inserts", () => {
    const base = new Uint8Array(0);
    const target = encode("all new content");

    const ranges = [...createDeltaRanges(base, target)];
    const deltas = [...createDelta(base, target, ranges)];

    const gitDelta = deltaToGitFormat(base.length, deltas);
    expect(decodeGitBinaryDelta(base, gitDelta)).toEqual(target);
  });

  it("should handle Delta[] with only copies", () => {
    const base = randomBytes(1024);
    const target = base.subarray(100, 900);

    const ranges = [...createDeltaRanges(base, target)];
    const deltas = [...createDelta(base, target, ranges)];

    const gitDelta = deltaToGitFormat(base.length, deltas);
    expect(decodeGitBinaryDelta(base, gitDelta)).toEqual(target);
  });
});

describe("parseGitDelta error handling", () => {
  it("should throw on unsupported delta command 0", () => {
    // Create a malformed delta with command byte 0
    // Format: baseSize varint, resultSize varint, then instructions
    const malformedDelta = new Uint8Array([
      0x05, // baseSize = 5
      0x05, // resultSize = 5
      0x00, // Invalid command byte (0 is reserved)
    ]);

    expect(() => parseGitDelta(malformedDelta)).toThrow("Unsupported delta command 0");
  });

  it("should parse valid delta without throwing", () => {
    // Create a simple valid delta with an insert instruction
    const validDelta = new Uint8Array([
      0x00, // baseSize = 0
      0x05, // resultSize = 5
      0x05, // INSERT 5 bytes
      0x48,
      0x65,
      0x6c,
      0x6c,
      0x6f, // "Hello"
    ]);

    const result = parseGitDelta(validDelta);
    expect(result.baseSize).toBe(0);
    expect(result.resultSize).toBe(5);
    expect(result.instructions.length).toBe(1);
    expect(result.instructions[0].type).toBe("insert");
  });
});
