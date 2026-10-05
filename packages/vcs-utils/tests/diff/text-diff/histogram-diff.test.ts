import { describe, expect, it } from "vitest";
import { Edit } from "../../../src/diff/text-diff/edit.js";
import { HistogramDiff } from "../../../src/diff/text-diff/histogram-diff.js";
import { MyersDiff } from "../../../src/diff/text-diff/myers-diff.js";
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
 * Run diff and return the edit list.
 */
function diff(a: RawText, b: RawText) {
  return HistogramDiff.diff(RawTextComparator.DEFAULT, a, b);
}

describe("HistogramDiff", () => {
  // Test cases from JGit's AbstractDiffTestCase (same as MyersDiff tests)

  describe("basic operations", () => {
    it("should handle empty inputs", () => {
      const r = diff(t(""), t(""));
      expect(r.length).toBe(0);
    });

    it("should handle create file", () => {
      const r = diff(t(""), t("AB"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 0, 0, 2))).toBe(true);
    });

    it("should handle delete file", () => {
      const r = diff(t("AB"), t(""));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 2, 0, 0))).toBe(true);
    });

    it("should handle insert middle", () => {
      const r = diff(t("ac"), t("aBc"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(1, 1, 1, 2))).toBe(true);
    });

    it("should handle delete middle", () => {
      const r = diff(t("aBc"), t("ac"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(1, 2, 1, 1))).toBe(true);
    });

    it("should handle replace middle", () => {
      const r = diff(t("bCd"), t("bEd"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(1, 2, 1, 2))).toBe(true);
    });

    it("should handle inserts into mid position", () => {
      const r = diff(t("aaaa"), t("aaXaa"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(2, 2, 2, 3))).toBe(true);
    });

    it("should handle insert start", () => {
      const r = diff(t("bc"), t("Abc"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 0, 0, 1))).toBe(true);
    });

    it("should handle delete start", () => {
      const r = diff(t("Abc"), t("bc"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 1, 0, 0))).toBe(true);
    });

    it("should handle insert end", () => {
      const r = diff(t("bc"), t("bcD"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(2, 2, 2, 3))).toBe(true);
    });

    it("should handle delete end", () => {
      const r = diff(t("bcD"), t("bc"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(2, 3, 2, 2))).toBe(true);
    });
  });

  describe("complex operations", () => {
    it("should handle replace with common delete", () => {
      const r = diff(t("RbC"), t("Sb"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(0, 1, 0, 1))).toBe(true);
      expect(r[1].equals(new Edit(2, 3, 2, 2))).toBe(true);
    });

    it("should handle common replace common delete common", () => {
      const r = diff(t("aRbCd"), t("aSbd"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 2, 1, 2))).toBe(true);
      expect(r[1].equals(new Edit(3, 4, 3, 3))).toBe(true);
    });

    it("should handle move block", () => {
      const r = diff(t("aYYbcdz"), t("abcdYYz"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 3, 1, 1))).toBe(true);
      expect(r[1].equals(new Edit(6, 6, 4, 6))).toBe(true);
    });

    it("should handle invert blocks", () => {
      const r = diff(t("aYYbcdXXz"), t("aXXbcdYYz"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 3, 1, 3))).toBe(true);
      expect(r[1].equals(new Edit(6, 8, 6, 8))).toBe(true);
    });

    it("should handle unique common larger than match point", () => {
      const r = diff(t("AbdeZ"), t("PbdeQR"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(0, 1, 0, 1))).toBe(true);
      expect(r[1].equals(new Edit(4, 5, 4, 6))).toBe(true);
    });

    it("should handle common grows prefix and suffix", () => {
      const r = diff(t("AaabccZ"), t("PaabccR"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(0, 1, 0, 1))).toBe(true);
      expect(r[1].equals(new Edit(6, 7, 6, 7))).toBe(true);
    });

    it("should handle duplicate A but common unique in B", () => {
      const r = diff(t("AbbcR"), t("CbcS"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(0, 2, 0, 1))).toBe(true);
      expect(r[1].equals(new Edit(4, 5, 3, 4))).toBe(true);
    });

    it("should handle insert near common tail", () => {
      const r = diff(t("aq}nb"), t("aCq}nD}nb"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 1, 1, 2))).toBe(true);
      expect(r[1].equals(new Edit(4, 4, 5, 8))).toBe(true);
    });

    it("should handle delete near common tail", () => {
      const r = diff(t("aCq}nD}nb"), t("aq}nb"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 2, 1, 1))).toBe(true);
      expect(r[1].equals(new Edit(5, 8, 4, 4))).toBe(true);
    });

    it("should handle delete near common center", () => {
      const r = diff(t("abcd123123uvwxpq"), t("aBcd123uvwxPq"));
      expect(r.length).toBe(3);
      expect(r[0].equals(new Edit(1, 2, 1, 2))).toBe(true);
      expect(r[1].equals(new Edit(7, 10, 7, 7))).toBe(true);
      expect(r[2].equals(new Edit(14, 15, 11, 12))).toBe(true);
    });

    it("should handle insert near common center", () => {
      const r = diff(t("aBcd123uvwxPq"), t("abcd123123uvwxpq"));
      expect(r.length).toBe(3);
      expect(r[0].equals(new Edit(1, 2, 1, 2))).toBe(true);
      expect(r[1].equals(new Edit(7, 7, 7, 10))).toBe(true);
      expect(r[2].equals(new Edit(11, 12, 14, 15))).toBe(true);
    });

    it("should handle Linux bug edge case", () => {
      const r = diff(t("a{bcdE}z"), t("a{0bcdEE}z"));
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(2, 2, 2, 3))).toBe(true);
      expect(r[1].equals(new Edit(6, 6, 7, 8))).toBe(true);
    });
  });

  describe("real text examples", () => {
    it("should handle real text example", () => {
      const a = new RawText("Line 1\nLine 2\nLine 3\n");
      const b = new RawText("Line 1\nModified Line 2\nLine 3\n");
      const r = diff(a, b);
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("REPLACE");
      expect(r[0].beginA).toBe(1);
      expect(r[0].endA).toBe(2);
      expect(r[0].beginB).toBe(1);
      expect(r[0].endB).toBe(2);
    });

    it("should handle function insertion", () => {
      const a = new RawText("function a() {}\nfunction b() {}\n");
      const b = new RawText("function a() {}\nfunction new() {}\nfunction b() {}\n");
      const r = diff(a, b);
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("INSERT");
      expect(r[0].beginA).toBe(1);
      expect(r[0].endA).toBe(1);
      expect(r[0].beginB).toBe(1);
      expect(r[0].endB).toBe(2);
    });

    it("should handle function deletion", () => {
      const a = new RawText("function a() {}\nfunction middle() {}\nfunction b() {}\n");
      const b = new RawText("function a() {}\nfunction b() {}\n");
      const r = diff(a, b);
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("DELETE");
      expect(r[0].beginA).toBe(1);
      expect(r[0].endA).toBe(2);
      expect(r[0].beginB).toBe(1);
      expect(r[0].endB).toBe(1);
    });
  });

  describe("algorithm configuration", () => {
    it("should work with custom maxChainLength", () => {
      const a = t("abc");
      const b = t("def");
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, a, b, {
        maxChainLength: 32,
      });
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("REPLACE");
    });

    it("should use fallback when chain length exceeded", () => {
      // With maxChainLength=1, most sequences will trigger fallback
      const a = t("aabb");
      const b = t("bbaa");
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, a, b, {
        maxChainLength: 1,
        fallback: MyersDiff.diff,
      });
      // Should still produce valid results via fallback
      expect(r.length).toBeGreaterThan(0);
    });

    it("should emit REPLACE when no fallback and chain exceeded", () => {
      const a = t("aabb");
      const b = t("ccdd");
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, a, b, {
        maxChainLength: 1,
        fallback: null,
      });
      // With no common elements and no fallback, should emit REPLACE
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("REPLACE");
    });
  });

  describe("comparison with Myers", () => {
    it("should produce equivalent results to Myers for simple cases", () => {
      const testCases = [
        ["abc", "abc"],
        ["abc", "abd"],
        ["abc", "def"],
        ["", "abc"],
        ["abc", ""],
        ["abcdef", "abXdef"],
      ];

      for (const [a, b] of testCases) {
        const rawA = t(a);
        const rawB = t(b);
        const histogramResult = HistogramDiff.diff(RawTextComparator.DEFAULT, rawA, rawB);
        const myersResult = MyersDiff.diff(RawTextComparator.DEFAULT, rawA, rawB);

        // Both should produce the same number of edit regions
        // (exact positions may vary due to normalization differences)
        expect(histogramResult.length).toBe(myersResult.length);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle identical sequences", () => {
      const r = diff(t("abcdef"), t("abcdef"));
      expect(r.length).toBe(0);
    });

    it("should handle completely different sequences", () => {
      const r = diff(t("abc"), t("xyz"));
      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("REPLACE");
    });

    it("should handle single character sequences", () => {
      const r = diff(t("a"), t("b"));
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 1, 0, 1))).toBe(true);
    });

    it("should handle long sequences", () => {
      const chars = "abcdefghijklmnopqrstuvwxyz";
      let a = "";
      let b = "";
      for (let i = 0; i < 100; i++) {
        a += chars[i % 26];
        b += chars[i % 26];
      }
      // Insert one character in the middle
      b = `${b.slice(0, 50)}X${b.slice(50)}`;

      const rawA = t(a);
      const rawB = t(b);
      const r = diff(rawA, rawB);

      expect(r.length).toBe(1);
      expect(r[0].getType()).toBe("INSERT");
    });
  });

  // T2.6b: HistogramDiff-specific tests from JGit HistogramDiffTest.java
  describe("histogram-specific: non-unique elements", () => {
    it("should handle flip blocks with no unique middle side", () => {
      // testEdit_NoUniqueMiddleSide_FlipBlocks from JGit
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, t("aRRSSz"), t("aSSRRz"), {
        fallback: null,
      });
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 3, 1, 1))).toBe(true); // DELETE "RR"
      expect(r[1].equals(new Edit(5, 5, 3, 5))).toBe(true); // INSERT "RR"
    });

    it("should handle insert with no unique middle side", () => {
      // testEdit_NoUniqueMiddleSide_Insert2 from JGit
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, t("aRSz"), t("aRRSSz"), {
        fallback: null,
      });
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(2, 2, 2, 4))).toBe(true);
    });

    it("should handle flip and expand with no unique middle side", () => {
      // testEdit_NoUniqueMiddleSide_FlipAndExpand from JGit
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, t("aRSz"), t("aSSRRz"), {
        fallback: null,
      });
      expect(r.length).toBe(2);
      expect(r[0].equals(new Edit(1, 2, 1, 1))).toBe(true); // DELETE "R"
      expect(r[1].equals(new Edit(3, 3, 2, 5))).toBe(true); // INSERT "SRR"
    });

    it("should handle LCS containing unique elements", () => {
      // testEdit_LcsContainsUnique from JGit
      const r = HistogramDiff.diff(
        RawTextComparator.DEFAULT,
        t("nqnjrnjsnm"),
        t("AnqnjrnjsnjTnmZ"),
        { fallback: null },
      );
      expect(r.length).toBe(3);
      expect(r[0].equals(new Edit(0, 0, 0, 1))).toBe(true); // INSERT "A"
      expect(r[1].equals(new Edit(9, 9, 10, 13))).toBe(true); // INSERT "jTn"
      expect(r[2].equals(new Edit(10, 10, 14, 15))).toBe(true); // INSERT "Z"
    });
  });

  describe("histogram-specific: chain length limits", () => {
    it("should handle exceeds chain length during scan of A", () => {
      // testExceedsChainLength_DuringScanOfA from JGit
      // Use a custom comparator that forces all elements to hash to the same value
      const cmp: import("../../../src/diff/text-diff/sequence.js").SequenceComparator<RawText> = {
        equals(a: RawText, ai: number, b: RawText, bi: number): boolean {
          return RawTextComparator.DEFAULT.equals(a, ai, b, bi);
        },
        hash(_a: RawText, _ai: number): number {
          return 1; // Force all elements to same hash bucket
        },
      };

      const r = HistogramDiff.diff(cmp, t("RabS"), t("QabT"), {
        maxChainLength: 3,
        fallback: null,
      });
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 4, 0, 4))).toBe(true);
    });

    it("should handle exceeds chain length during scan of B", () => {
      // testExceedsChainLength_DuringScanOfB from JGit
      const r = HistogramDiff.diff(RawTextComparator.DEFAULT, t("RaaS"), t("QaaT"), {
        maxChainLength: 1,
        fallback: null,
      });
      expect(r.length).toBe(1);
      expect(r[0].equals(new Edit(0, 4, 0, 4))).toBe(true);
    });
  });

  describe("histogram-specific: fallback behavior", () => {
    it("should produce better results with Myers fallback", () => {
      // testFallbackToMyersDiff from JGit
      const a = t("bbbbb");
      const b = t("AbCbDbEFbZ");

      // Without fallback our results are limited due to collisions
      const noFallback = HistogramDiff.diff(RawTextComparator.DEFAULT, a, b, {
        maxChainLength: 4,
        fallback: null,
      });
      expect(noFallback.length).toBe(1);

      // Results go up when we add a fallback for the high collision regions
      const withFallback = HistogramDiff.diff(RawTextComparator.DEFAULT, a, b, {
        maxChainLength: 4,
        fallback: MyersDiff.diff,
      });
      expect(withFallback.length).toBe(5);
    });
  });
});
