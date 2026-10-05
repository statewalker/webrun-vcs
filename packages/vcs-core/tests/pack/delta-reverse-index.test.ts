/**
 * Tests for DeltaReverseIndex
 *
 * Tests the in-memory reverse index for delta relationships.
 */

import { describe, expect, it } from "vitest";
import {
  type DeltaRelationshipSource,
  DeltaReverseIndex,
} from "../../src/pack/delta-reverse-index.js";

describe("DeltaReverseIndex", () => {
  describe("add and get", () => {
    it("correctly tracks base→targets mapping", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);

      expect(index.getTargets(base)).toContain(target);
      expect(index.getTargets(base)).toHaveLength(1);
    });

    it("correctly tracks target→base mapping", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);

      expect(index.getBase(target)).toBe(base);
    });

    it("handles multiple targets per base", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";
      const target3 = "3333333333333333333333333333333333333333";

      index.add(target1, base);
      index.add(target2, base);
      index.add(target3, base);

      const targets = index.getTargets(base);
      expect(targets).toHaveLength(3);
      expect(targets).toContain(target1);
      expect(targets).toContain(target2);
      expect(targets).toContain(target3);
    });

    it("handles chained deltas (A→B→C)", () => {
      const index = new DeltaReverseIndex();
      const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const c = "cccccccccccccccccccccccccccccccccccccccc";

      // B depends on A, C depends on B
      index.add(b, a);
      index.add(c, b);

      // A has one target: B
      expect(index.getTargets(a)).toEqual([b]);

      // B has one target: C
      expect(index.getTargets(b)).toEqual([c]);

      // C has no targets
      expect(index.getTargets(c)).toEqual([]);

      // Base chain
      expect(index.getBase(c)).toBe(b);
      expect(index.getBase(b)).toBe(a);
      expect(index.getBase(a)).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("correctly removes relationship", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);
      expect(index.remove(target)).toBe(true);

      expect(index.getBase(target)).toBeUndefined();
      expect(index.getTargets(base)).toEqual([]);
    });

    it("returns false for non-existent target", () => {
      const index = new DeltaReverseIndex();

      expect(index.remove("nonexistent")).toBe(false);
    });

    it("removes base entry when last target is removed", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";

      index.add(target1, base);
      index.add(target2, base);

      index.remove(target1);
      expect(index.hasTargets(base)).toBe(true);

      index.remove(target2);
      expect(index.hasTargets(base)).toBe(false);
    });
  });

  describe("hasTargets", () => {
    it("returns true when base has dependents", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);

      expect(index.hasTargets(base)).toBe(true);
    });

    it("returns false when base has no dependents", () => {
      const index = new DeltaReverseIndex();

      expect(index.hasTargets("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    });
  });

  describe("isDelta", () => {
    it("returns true for deltas", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);

      expect(index.isDelta(target)).toBe(true);
    });

    it("returns false for non-deltas", () => {
      const index = new DeltaReverseIndex();

      expect(index.isDelta("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    });

    it("returns false for base objects (unless they are also targets)", () => {
      const index = new DeltaReverseIndex();
      const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const target = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      index.add(target, base);

      expect(index.isDelta(base)).toBe(false);
    });
  });

  describe("size", () => {
    it("returns correct count of relationships", () => {
      const index = new DeltaReverseIndex();

      expect(index.size).toBe(0);

      index.add("1111111111111111111111111111111111111111", "a".repeat(40));
      expect(index.size).toBe(1);

      index.add("2222222222222222222222222222222222222222", "a".repeat(40));
      expect(index.size).toBe(2);

      index.add("3333333333333333333333333333333333333333", "b".repeat(40));
      expect(index.size).toBe(3);
    });
  });

  describe("entries", () => {
    it("iterates all relationships", () => {
      const index = new DeltaReverseIndex();
      const base1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const base2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const target1 = "1111111111111111111111111111111111111111";
      const target2 = "2222222222222222222222222222222222222222";
      const target3 = "3333333333333333333333333333333333333333";

      index.add(target1, base1);
      index.add(target2, base1);
      index.add(target3, base2);

      const entries = [...index.entries()];
      expect(entries).toHaveLength(3);

      const targets = entries.map((e) => e.target);
      expect(targets).toContain(target1);
      expect(targets).toContain(target2);
      expect(targets).toContain(target3);
    });
  });

  describe("clear", () => {
    it("empties the index", () => {
      const index = new DeltaReverseIndex();

      index.add("1111111111111111111111111111111111111111", "a".repeat(40));
      index.add("2222222222222222222222222222222222222222", "a".repeat(40));

      expect(index.size).toBe(2);

      index.clear();

      expect(index.size).toBe(0);
      expect(index.getTargets("a".repeat(40))).toEqual([]);
    });
  });

  describe("build", () => {
    it("builds index from relationship source", async () => {
      const source: DeltaRelationshipSource = {
        async *listDeltaRelationships() {
          yield {
            target: "1111111111111111111111111111111111111111",
            base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          };
          yield {
            target: "2222222222222222222222222222222222222222",
            base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          };
          yield {
            target: "3333333333333333333333333333333333333333",
            base: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          };
        },
      };

      const index = await DeltaReverseIndex.build(source);

      expect(index.size).toBe(3);
      expect(index.getTargets("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toHaveLength(2);
      expect(index.getTargets("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toHaveLength(1);
    });
  });
});
