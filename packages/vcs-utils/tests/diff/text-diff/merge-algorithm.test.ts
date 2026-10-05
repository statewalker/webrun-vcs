/**
 * Tests for MergeAlgorithm
 *
 * Based on JGit's MergeAlgorithmTest.java and MergeAlgorithmUnionTest.java
 */

import { describe, expect, it } from "vitest";

import { MergeContentStrategy, merge3Way } from "../../../src/diff/text-diff/merge-algorithm.js";

describe("MergeAlgorithm", () => {
  /**
   * Helper to convert single-character-per-line notation to actual content.
   * Each character becomes a line: "abc" -> "a\nb\nc\n"
   */
  function toLines(text: string): string {
    if (text === "") return "";
    return `${text.split("").join("\n")}\n`;
  }

  /**
   * Helper to get merged content as string.
   */
  function mergeToString(
    base: string,
    ours: string,
    theirs: string,
    strategy?: MergeContentStrategy,
  ): string {
    const result = merge3Way(toLines(base), toLines(ours), toLines(theirs), strategy);
    return new TextDecoder().decode(result.content);
  }

  describe("basic merge scenarios", () => {
    it("should merge identical texts", () => {
      const result = mergeToString("abc", "abc", "abc");
      expect(result).toBe(toLines("abc"));
    });

    it("should take ours when only ours changes", () => {
      const result = mergeToString("abc", "aZc", "abc");
      expect(result).toBe(toLines("aZc"));
    });

    it("should take theirs when only theirs changes", () => {
      const result = mergeToString("abc", "abc", "aZc");
      expect(result).toBe(toLines("aZc"));
    });

    it("should merge non-overlapping changes", () => {
      const result = mergeToString("abcde", "aZcde", "abcYe");
      expect(result).toBe(toLines("aZcYe"));
    });

    it("should detect conflict when both change same region differently", () => {
      const result = merge3Way(toLines("abc"), toLines("aZc"), toLines("aYc"));
      expect(result.hasConflicts).toBe(true);
      // Check that conflict markers are present
      const content = new TextDecoder().decode(result.content);
      expect(content).toContain("<<<<<<< OURS");
      expect(content).toContain("=======");
      expect(content).toContain(">>>>>>> THEIRS");
    });

    it("should not conflict when both make same change", () => {
      const result = merge3Way(toLines("abc"), toLines("aZc"), toLines("aZc"));
      expect(result.hasConflicts).toBe(false);
      const content = new TextDecoder().decode(result.content);
      expect(content).toBe(toLines("aZc"));
    });
  });

  describe("OURS strategy", () => {
    it("should take ours version for conflicts", () => {
      const result = mergeToString("abc", "aZc", "aYc", MergeContentStrategy.OURS);
      expect(result).toBe(toLines("aZc"));
    });

    it("should still merge non-conflicting changes", () => {
      const result = mergeToString("abcde", "aZcde", "abcYe", MergeContentStrategy.OURS);
      expect(result).toBe(toLines("aZcYe"));
    });
  });

  describe("THEIRS strategy", () => {
    it("should take theirs version for conflicts", () => {
      const result = mergeToString("abc", "aZc", "aYc", MergeContentStrategy.THEIRS);
      expect(result).toBe(toLines("aYc"));
    });

    it("should still merge non-conflicting changes", () => {
      const result = mergeToString("abcde", "aZcde", "abcYe", MergeContentStrategy.THEIRS);
      expect(result).toBe(toLines("aZcYe"));
    });
  });

  describe("UNION strategy", () => {
    /**
     * JGit: testTwoConflictingModifications
     */
    it("should concatenate two conflicting modifications", () => {
      // base: abc, ours: aZc (b->Z), theirs: aYc (b->Y)
      // UNION result: aZYc (both changes included)
      const result = mergeToString("abc", "aZc", "aYc", MergeContentStrategy.UNION);
      expect(result).toBe(toLines("aZYc"));
    });

    /**
     * JGit: testSameModification
     * When both sides make the same change, don't duplicate.
     */
    it("should not duplicate same modification", () => {
      const result = mergeToString("abc", "aZc", "aZc", MergeContentStrategy.UNION);
      expect(result).toBe(toLines("aZc"));
    });

    /**
     * JGit: testConflictAtStart
     */
    it("should handle conflict at start of file", () => {
      const result = mergeToString("abc", "Zbc", "Ybc", MergeContentStrategy.UNION);
      expect(result).toBe(toLines("ZYbc"));
    });

    /**
     * JGit: testConflictAtEnd
     */
    it("should handle conflict at end of file", () => {
      const result = mergeToString("abc", "abZ", "abY", MergeContentStrategy.UNION);
      expect(result).toBe(toLines("abZY"));
    });

    it("should merge non-conflicting changes with UNION", () => {
      const result = mergeToString("abcde", "aZcde", "abcYe", MergeContentStrategy.UNION);
      expect(result).toBe(toLines("aZcYe"));
    });
  });

  describe("deletion scenarios", () => {
    it("should handle deletion by ours", () => {
      // ours deletes b
      const result = mergeToString("abc", "ac", "abc");
      expect(result).toBe(toLines("ac"));
    });

    it("should handle deletion by theirs", () => {
      // theirs deletes b
      const result = mergeToString("abc", "abc", "ac");
      expect(result).toBe(toLines("ac"));
    });

    it("should merge when both delete same content", () => {
      const result = mergeToString("abc", "ac", "ac");
      expect(result).toBe(toLines("ac"));
    });

    it("should conflict when one deletes and other modifies", () => {
      // ours deletes b, theirs modifies b to Z
      const result = merge3Way(toLines("abc"), toLines("ac"), toLines("aZc"));
      expect(result.hasConflicts).toBe(true);
    });
  });

  describe("insertion scenarios", () => {
    it("should handle insertion by ours", () => {
      const result = mergeToString("ac", "abc", "ac");
      expect(result).toBe(toLines("abc"));
    });

    it("should handle insertion by theirs", () => {
      const result = mergeToString("ac", "ac", "abc");
      expect(result).toBe(toLines("abc"));
    });

    it("should handle same insertion by both", () => {
      const result = mergeToString("ac", "abc", "abc");
      expect(result).toBe(toLines("abc"));
    });

    it("should conflict when both insert different content at same location", () => {
      // Both insert at same position with different content
      const result = merge3Way(toLines("ac"), toLines("aXc"), toLines("aYc"));
      expect(result.hasConflicts).toBe(true);
    });
  });

  describe("complex scenarios", () => {
    /**
     * JGit: testTwoNonConflictingModifications
     */
    it("should merge two non-conflicting modifications", () => {
      const result = mergeToString("abcdefghij", "abZdefghij", "Ybcdefghij");
      expect(result).toBe(toLines("YbZdefghij"));
    });

    /**
     * JGit: testNoAgainstOneModification
     */
    it("should take theirs when only theirs has modifications", () => {
      const result = mergeToString("abcdefghij", "abcdefghij", "aZcZefghij");
      expect(result).toBe(toLines("aZcZefghij"));
    });

    it("should handle adjacent modifications", () => {
      // ours changes b->Z, theirs changes c->Y
      const result = mergeToString("abcd", "aZcd", "abYd");
      // These are adjacent but don't overlap, should merge
      expect(result).toBe(toLines("aZYd"));
    });

    it("should handle multiple separate changes", () => {
      const result = mergeToString("abcdefgh", "aZcdefgh", "abcdYfgh");
      expect(result).toBe(toLines("aZcdYfgh"));
    });
  });

  describe("empty content", () => {
    it("should handle empty base", () => {
      const result = mergeToString("", "abc", "");
      expect(result).toBe(toLines("abc"));
    });

    it("should handle all empty", () => {
      const result = merge3Way("", "", "");
      expect(result.hasConflicts).toBe(false);
      expect(new TextDecoder().decode(result.content)).toBe("");
    });

    it("should handle empty ours and theirs", () => {
      const result = mergeToString("abc", "", "");
      expect(result).toBe("");
    });
  });
});
