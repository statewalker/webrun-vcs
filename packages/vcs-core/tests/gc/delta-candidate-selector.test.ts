import { describe, expect, it } from "vitest";
import type { DeltaObjectInfo } from "../../src/gc/delta-candidate-selector.js";
import { selectDeltaCandidates } from "../../src/gc/delta-candidate-selector.js";

describe("selectDeltaCandidates", () => {
  it("pairs same-type objects of similar size", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 100 },
      { id: "bbb", type: "blob", size: 105 },
    ];

    const candidates = selectDeltaCandidates(objects);

    expect(candidates.length).toBe(1);
    // Larger is target, smaller is base (sorted by size ascending)
    expect(candidates[0].targetId).toBe("bbb");
    expect(candidates[0].baseId).toBe("aaa");
    expect(candidates[0].estimatedSavings).toBeGreaterThan(0);
  });

  it("does not pair objects of different types", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 100 },
      { id: "bbb", type: "tree", size: 105 },
    ];

    const candidates = selectDeltaCandidates(objects);
    expect(candidates.length).toBe(0);
  });

  it("does not pair objects with very different sizes", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 10 },
      { id: "bbb", type: "blob", size: 10000 },
    ];

    const candidates = selectDeltaCandidates(objects);
    expect(candidates.length).toBe(0);
  });

  it("respects window size", () => {
    // Create 15 blobs — with window=3, only nearby objects pair
    const objects: DeltaObjectInfo[] = Array.from({ length: 15 }, (_, i) => ({
      id: `obj-${String(i).padStart(3, "0")}`,
      type: "blob",
      size: 100 + i,
    }));

    const candidates = selectDeltaCandidates(objects, { window: 3 });

    // Each object can look back 3 positions for a partner
    // Expect several pairs from nearby objects
    expect(candidates.length).toBeGreaterThan(0);

    // Verify all pairs have bases within window distance
    for (const pair of candidates) {
      const targetIdx = objects.findIndex((o) => o.id === pair.targetId);
      const baseIdx = objects.findIndex((o) => o.id === pair.baseId);
      expect(targetIdx - baseIdx).toBeLessThanOrEqual(3);
    }
  });

  it("skips objects at max depth", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 100, depth: 50 },
      { id: "bbb", type: "blob", size: 105, depth: 0 },
    ];

    const candidates = selectDeltaCandidates(objects, { maxDepth: 50 });

    // "aaa" is at max depth so it's excluded from eligible objects
    // "bbb" has no same-type partner in window
    expect(candidates.length).toBe(0);
  });

  it("skips objects larger than maxSize", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 1024 * 1024 * 600 }, // 600MB
      { id: "bbb", type: "blob", size: 1024 * 1024 * 590 }, // 590MB
    ];

    const candidates = selectDeltaCandidates(objects); // default maxSize=512MB
    expect(candidates.length).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(selectDeltaCandidates([])).toEqual([]);
  });

  it("returns empty array for single object", () => {
    const objects: DeltaObjectInfo[] = [{ id: "aaa", type: "blob", size: 100 }];
    expect(selectDeltaCandidates(objects)).toEqual([]);
  });

  it("groups by type before pairing", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "blob1", type: "blob", size: 100 },
      { id: "tree1", type: "tree", size: 101 },
      { id: "blob2", type: "blob", size: 102 },
      { id: "tree2", type: "tree", size: 103 },
    ];

    const candidates = selectDeltaCandidates(objects);

    // Should pair blob1↔blob2 and tree1↔tree2, not cross-type
    for (const pair of candidates) {
      const target = objects.find((o) => o.id === pair.targetId);
      const base = objects.find((o) => o.id === pair.baseId);
      expect(target?.type).toBe(base?.type);
    }
  });

  it("skips zero-size objects", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 0 },
      { id: "bbb", type: "blob", size: 100 },
    ];

    const candidates = selectDeltaCandidates(objects);
    expect(candidates.length).toBe(0);
  });

  it("configurable minSavingsRatio", () => {
    const objects: DeltaObjectInfo[] = [
      { id: "aaa", type: "blob", size: 100 },
      { id: "bbb", type: "blob", size: 140 },
    ];

    // With strict threshold (0.8), these might not pair
    const strict = selectDeltaCandidates(objects, { minSavingsRatio: 0.8 });

    // With lenient threshold (0.1), they should pair
    const lenient = selectDeltaCandidates(objects, { minSavingsRatio: 0.1 });

    expect(lenient.length).toBeGreaterThanOrEqual(strict.length);
  });
});
