import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALGORITHM,
  getAlgorithm,
  SupportedAlgorithm,
} from "../../../src/diff/text-diff/diff-algorithm.js";
import { RawText } from "../../../src/diff/text-diff/raw-text.js";
import { RawTextComparator } from "../../../src/diff/text-diff/raw-text-comparator.js";

describe("DiffAlgorithm", () => {
  describe("SupportedAlgorithm enum", () => {
    it("should have MYERS algorithm", () => {
      expect(SupportedAlgorithm.MYERS).toBe("myers");
    });

    it("should have HISTOGRAM algorithm", () => {
      expect(SupportedAlgorithm.HISTOGRAM).toBe("histogram");
    });
  });

  describe("getAlgorithm", () => {
    it("should return Myers diff function", () => {
      const diff = getAlgorithm(SupportedAlgorithm.MYERS);
      expect(typeof diff).toBe("function");

      const a = new RawText("Line 1\nLine 2\n");
      const b = new RawText("Line 1\nLine 3\n");
      const edits = diff(RawTextComparator.DEFAULT, a, b);

      expect(edits.length).toBe(1);
      expect(edits[0].getType()).toBe("REPLACE");
    });

    it("should return Histogram diff function", () => {
      const diff = getAlgorithm(SupportedAlgorithm.HISTOGRAM);
      expect(typeof diff).toBe("function");

      const a = new RawText("Line 1\nLine 2\n");
      const b = new RawText("Line 1\nLine 3\n");
      const edits = diff(RawTextComparator.DEFAULT, a, b);

      expect(edits.length).toBe(1);
      expect(edits[0].getType()).toBe("REPLACE");
    });

    it("should throw for unknown algorithm", () => {
      expect(() => getAlgorithm("unknown" as SupportedAlgorithm)).toThrow(
        "Unknown diff algorithm: unknown",
      );
    });
  });

  describe("DEFAULT_ALGORITHM", () => {
    it("should be HISTOGRAM", () => {
      expect(DEFAULT_ALGORITHM).toBe(SupportedAlgorithm.HISTOGRAM);
    });

    it("should work with getAlgorithm", () => {
      const diff = getAlgorithm(DEFAULT_ALGORITHM);
      expect(typeof diff).toBe("function");
    });
  });

  describe("algorithm equivalence", () => {
    const testCases = [
      { a: "", b: "", description: "empty inputs" },
      { a: "A\n", b: "B\n", description: "single line replace" },
      { a: "A\nB\n", b: "A\nB\n", description: "identical" },
      { a: "A\nB\nC\n", b: "A\nX\nC\n", description: "middle change" },
      { a: "", b: "A\nB\n", description: "create file" },
      { a: "A\nB\n", b: "", description: "delete file" },
    ];

    for (const { a, b, description } of testCases) {
      it(`should produce equivalent edit counts for ${description}`, () => {
        const rawA = new RawText(a);
        const rawB = new RawText(b);

        const myersDiff = getAlgorithm(SupportedAlgorithm.MYERS);
        const histogramDiff = getAlgorithm(SupportedAlgorithm.HISTOGRAM);

        const myersEdits = myersDiff(RawTextComparator.DEFAULT, rawA, rawB);
        const histogramEdits = histogramDiff(RawTextComparator.DEFAULT, rawA, rawB);

        // Both algorithms should produce the same number of edit regions
        // for simple cases (though positions may differ due to normalization)
        expect(myersEdits.length).toBe(histogramEdits.length);
      });
    }
  });

  describe("algorithm differences", () => {
    it("may produce different results for complex cases with repetition", () => {
      // This is a case where Histogram might produce different results
      // due to its preference for unique lines as anchors
      const a = new RawText("function a() {}\nfunction b() {}\nfunction c() {}\n");
      const b = new RawText(
        "function a() {}\nfunction new() {}\nfunction b() {}\nfunction c() {}\n",
      );

      const myersDiff = getAlgorithm(SupportedAlgorithm.MYERS);
      const histogramDiff = getAlgorithm(SupportedAlgorithm.HISTOGRAM);

      const myersEdits = myersDiff(RawTextComparator.DEFAULT, a, b);
      const histogramEdits = histogramDiff(RawTextComparator.DEFAULT, a, b);

      // Both should detect the insertion, though the exact edit may vary
      expect(myersEdits.length).toBeGreaterThan(0);
      expect(histogramEdits.length).toBeGreaterThan(0);
    });
  });
});
