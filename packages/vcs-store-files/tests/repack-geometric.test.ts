/**
 * The split of `git repack --geometric` (repack-geometry.c `compute_pack_geometry_split`), on
 * the object counts of t7703-repack-geometric's scenarios.
 */
import { describe, expect, it } from "vitest";
import { geometricSplit } from "../src/index.js";

describe("geometricSplit", () => {
  it("t7703-repack-geometric '--geometric with no packs'", () => {
    expect(geometricSplit([], 2)).toBe(0);
  });

  it("t7703-repack-geometric '--geometric with one pack'", () => {
    expect(geometricSplit([3], 2)).toBe(0);
  });

  it("t7703-repack-geometric '--geometric with an intact progression'", () => {
    expect(geometricSplit([3, 6, 12], 2)).toBe(0);
  });

  it("t7703-repack-geometric '--geometric with small-pack rollup'", () => {
    // 3 + 3 roll up; 12 and 24 stay
    expect(geometricSplit([3, 3, 12, 24], 2)).toBe(2);
  });

  it("t7703-repack-geometric '--geometric with small- and large-pack rollup'", () => {
    // 3 + 3 = 6 is more than half of 7: the 7 joins them; 27 stays
    expect(geometricSplit([3, 3, 7, 27], 2)).toBe(3);
  });

  it("rolls up everything when no progression holds", () => {
    expect(geometricSplit([5, 5, 5], 2)).toBe(3);
  });
});
