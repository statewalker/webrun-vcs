import { describe, expect, it } from "vitest";
import { Edit } from "../../../src/diff/text-diff/edit.js";
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
  return MyersDiff.diff(RawTextComparator.DEFAULT, a, b);
}

describe("MyersDiff", () => {
  // Test cases from JGit's AbstractDiffTestCase

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
});
