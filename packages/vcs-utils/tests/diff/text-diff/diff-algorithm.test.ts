import { describe, expect, it } from "vitest";
import { SupportedAlgorithm } from "../../../src/diff/text-diff/diff-algorithm.js";

describe("DiffAlgorithm", () => {
  describe("SupportedAlgorithm enum", () => {
    it("should have MYERS algorithm", () => {
      expect(SupportedAlgorithm.MYERS).toBe("myers");
    });

    it("should have HISTOGRAM algorithm", () => {
      expect(SupportedAlgorithm.HISTOGRAM).toBe("histogram");
    });
  });
});
