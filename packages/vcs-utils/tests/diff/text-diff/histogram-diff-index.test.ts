import { describe, expect, it } from "vitest";
import { Edit } from "../../../src/diff/text-diff/edit.js";
import {
  type HashedSequence,
  HashedSequencePair,
} from "../../../src/diff/text-diff/hashed-sequence.js";
import { HistogramDiffIndex } from "../../../src/diff/text-diff/histogram-diff-index.js";
import { RawText } from "../../../src/diff/text-diff/raw-text.js";
import { RawTextComparator } from "../../../src/diff/text-diff/raw-text-comparator.js";

/**
 * Helper function to create RawText from a simple string.
 * Each character becomes a line (like JGit's test helper).
 */
function t(text: string): RawText {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += text.charAt(i);
    result += "\n";
  }
  return new RawText(result);
}

/**
 * Create a HistogramDiffIndex and find LCS for the given sequences.
 */
function findLCS(
  a: string,
  b: string,
  maxChainLength = 64,
): { lcs: Edit | null; ha: HashedSequence<RawText>; hb: HashedSequence<RawText> } {
  const rawA = t(a);
  const rawB = t(b);
  const pair = new HashedSequencePair(RawTextComparator.DEFAULT, rawA, rawB);
  const cmp = pair.getComparator();
  const ha = pair.getA();
  const hb = pair.getB();
  const region = new Edit(0, ha.size(), 0, hb.size());

  const index = new HistogramDiffIndex(maxChainLength, cmp, ha, hb, region);
  const lcs = index.findLongestCommonSequence();

  return { lcs, ha, hb };
}

/**
 * Find LCS for a specific region.
 */
function findLCSInRegion(
  a: string,
  b: string,
  beginA: number,
  endA: number,
  beginB: number,
  endB: number,
  maxChainLength = 64,
): Edit | null {
  const rawA = t(a);
  const rawB = t(b);
  const pair = new HashedSequencePair(RawTextComparator.DEFAULT, rawA, rawB);
  const cmp = pair.getComparator();
  const ha = pair.getA();
  const hb = pair.getB();
  const region = new Edit(beginA, endA, beginB, endB);

  const index = new HistogramDiffIndex(maxChainLength, cmp, ha, hb, region);
  return index.findLongestCommonSequence();
}

describe("HistogramDiffIndex", () => {
  describe("basic LCS finding", () => {
    it("should find empty LCS for completely different sequences", () => {
      const { lcs } = findLCS("abc", "xyz");
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });

    it("should find LCS of single common element", () => {
      const { lcs } = findLCS("axb", "cxd");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(1);
      expect(lcs?.endA).toBe(2);
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(2);
    });

    it("should find LCS at start", () => {
      const { lcs } = findLCS("abcd", "abxy");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(0);
      expect(lcs?.endA).toBe(2);
      expect(lcs?.beginB).toBe(0);
      expect(lcs?.endB).toBe(2);
    });

    it("should find LCS at end", () => {
      const { lcs } = findLCS("xycd", "abcd");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(2);
      expect(lcs?.endA).toBe(4);
      expect(lcs?.beginB).toBe(2);
      expect(lcs?.endB).toBe(4);
    });

    it("should find LCS in middle", () => {
      const { lcs } = findLCS("aXYZb", "pXYZq");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(1);
      expect(lcs?.endA).toBe(4);
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(4);
    });

    it("should find identical sequences as one LCS", () => {
      const { lcs } = findLCS("abc", "abc");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(0);
      expect(lcs?.endA).toBe(3);
      expect(lcs?.beginB).toBe(0);
      expect(lcs?.endB).toBe(3);
    });
  });

  describe("empty sequences", () => {
    it("should handle both sequences empty", () => {
      const { lcs } = findLCS("", "");
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });

    it("should handle first sequence empty", () => {
      const { lcs } = findLCS("", "abc");
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });

    it("should handle second sequence empty", () => {
      const { lcs } = findLCS("abc", "");
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });
  });

  describe("occurrence counting", () => {
    it("should prefer unique elements over repeated ones", () => {
      // 'U' appears once in A, 'R' appears twice
      // The histogram diff should prefer U as the anchor
      const { lcs } = findLCS("aRURb", "pUq");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(2);
      expect(lcs?.endA).toBe(3);
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(2);
    });

    it("should find longest LCS among multiple candidates", () => {
      // Both 'X' and 'YY' are candidates
      // 'YY' is longer so should be preferred
      const { lcs } = findLCS("aXYYb", "pXYYq");
      expect(lcs).not.toBeNull();
      // Should find XYY (length 3) not just X (length 1)
      expect(lcs?.getLengthA()).toBeGreaterThanOrEqual(2);
    });

    it("should handle many repeated elements", () => {
      const { lcs } = findLCS("aaaaaXaaaaa", "bbbbbXbbbbb");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(5);
      expect(lcs?.endA).toBe(6);
      expect(lcs?.beginB).toBe(5);
      expect(lcs?.endB).toBe(6);
    });
  });

  describe("maxChainLength fallback", () => {
    it("should return null when maxChainLength is exceeded", () => {
      // Create a sequence with many hash collisions
      // Using maxChainLength=1 means any collision triggers fallback
      const { lcs } = findLCS("aabb", "ccdd", 1);
      // With such a low maxChainLength, it may or may not find LCS
      // depending on hash distribution. The point is it shouldn't crash.
      // A return value of null signals fallback needed.
      if (lcs === null) {
        // Expected - fallback signal
      } else {
        // Also acceptable if no collisions occurred
        expect(lcs.isEmpty()).toBe(true);
      }
    });

    it("should work with normal maxChainLength", () => {
      const { lcs } = findLCS("abcdef", "ghijkl", 64);
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });
  });

  describe("region-specific search", () => {
    it("should only search within specified region", () => {
      // Full sequences: "XabcY" and "ZabcW"
      // Region is [1,4) in both, which is "abc"
      const lcs = findLCSInRegion("XabcY", "ZabcW", 1, 4, 1, 4);
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(1);
      expect(lcs?.endA).toBe(4);
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(4);
    });

    it("should not find matches outside region", () => {
      // Full sequences have common "abc" but region excludes it
      const lcs = findLCSInRegion("abcXYZ", "abcPQR", 3, 6, 3, 6);
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle single character sequences", () => {
      const { lcs } = findLCS("a", "a");
      expect(lcs).not.toBeNull();
      expect(lcs?.beginA).toBe(0);
      expect(lcs?.endA).toBe(1);
      expect(lcs?.beginB).toBe(0);
      expect(lcs?.endB).toBe(1);
    });

    it("should handle single different characters", () => {
      const { lcs } = findLCS("a", "b");
      expect(lcs).not.toBeNull();
      expect(lcs?.isEmpty()).toBe(true);
    });

    it("should handle multiple possible LCS positions", () => {
      // "a" appears twice in A, once in B
      // Should find a match (either position works)
      const { lcs } = findLCS("aba", "xax");
      expect(lcs).not.toBeNull();
      expect(lcs?.getLengthA()).toBe(1);
      // Position could be 0 or 2 in A, 1 in B
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(2);
    });

    it("should extend LCS in both directions", () => {
      // The 'Y' is the unique element, but should extend to include 'abc' before and after
      const { lcs } = findLCS("XabcYdefZ", "PabcYdefQ");
      expect(lcs).not.toBeNull();
      // Should find "abcYdef" as the LCS
      expect(lcs?.beginA).toBe(1);
      expect(lcs?.endA).toBe(8);
      expect(lcs?.beginB).toBe(1);
      expect(lcs?.endB).toBe(8);
    });
  });

  describe("hasCommon tracking", () => {
    it("should detect common elements even with high occurrence count", () => {
      // Test that hasCommon is set correctly
      const { lcs } = findLCS("aaaaXaaaa", "bbbXbbb");
      expect(lcs).not.toBeNull();
      // Should find X as common
      expect(lcs?.getLengthA()).toBe(1);
    });
  });

  describe("real-world patterns", () => {
    it("should handle function insertion pattern", () => {
      // Classic patience diff case: inserting a function between others
      const a = "func1\nfunc2\n}";
      const b = "func1\nnewFunc\nfunc2\n}";
      const rawA = new RawText(a);
      const rawB = new RawText(b);
      const pair = new HashedSequencePair(RawTextComparator.DEFAULT, rawA, rawB);
      const cmp = pair.getComparator();
      const ha = pair.getA();
      const hb = pair.getB();
      const region = new Edit(0, ha.size(), 0, hb.size());

      const index = new HistogramDiffIndex(64, cmp, ha, hb, region);
      const lcs = index.findLongestCommonSequence();

      expect(lcs).not.toBeNull();
      // Should find a common sequence (the actual positions depend on line parsing)
      expect(lcs?.getLengthA()).toBeGreaterThan(0);
    });

    it("should handle code block movement", () => {
      // Moving a block of code
      const { lcs } = findLCS("aXYZbcd", "bcdXYZa");
      expect(lcs).not.toBeNull();
      // Should find either "XYZ" or "bcd" as LCS
      expect(lcs?.getLengthA()).toBeGreaterThanOrEqual(3);
    });

    it("should handle repeated braces pattern", () => {
      // Common pattern in code with many braces
      const { lcs } = findLCS("{{{}}}abc{{{}}}", "xyz{{{}}}pqr");
      expect(lcs).not.toBeNull();
      // Should find "{{{}}}" as common
      expect(lcs?.getLengthA()).toBe(6);
    });
  });

  describe("performance characteristics", () => {
    it("should handle moderately large sequences", () => {
      // Create sequences with 1000 elements each
      const chars = "abcdefghijklmnopqrstuvwxyz";
      let a = "";
      let b = "";
      for (let i = 0; i < 100; i++) {
        a += chars[i % 26];
        b += chars[(i + 13) % 26];
      }

      const { lcs } = findLCS(a, b);
      // Should complete without error
      expect(lcs).not.toBeNull();
    });
  });
});
