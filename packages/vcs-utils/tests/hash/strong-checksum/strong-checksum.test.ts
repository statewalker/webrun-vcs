import { describe, expect, it } from "vitest";
import { StrongChecksum } from "../../../src/hash/strong-checksum/index.js";

describe("StrongChecksum", () => {
  describe("update", () => {
    it("should be chainable", () => {
      const sc = new StrongChecksum();
      const result = sc.update(new Uint8Array([1, 2, 3]));

      expect(result).toBe(sc);
    });

    it("should handle empty data", () => {
      const sc = new StrongChecksum();
      sc.update(new Uint8Array(0));

      // Empty update should keep the initial FNV-1a basis
      expect(sc.finalize()).toBe(0x811c9dc5);
    });

    it("should handle offset parameter", () => {
      const data = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);

      const sc1 = new StrongChecksum();
      sc1.update(data, 2, 3);

      const sc2 = new StrongChecksum();
      sc2.update(new Uint8Array([1, 2, 3]));

      expect(sc1.finalize()).toBe(sc2.finalize());
    });

    it("should handle len parameter", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const sc1 = new StrongChecksum();
      sc1.update(data, 0, 3);

      const sc2 = new StrongChecksum();
      sc2.update(new Uint8Array([1, 2, 3]));

      expect(sc1.finalize()).toBe(sc2.finalize());
    });

    it("should accumulate multiple updates", () => {
      const sc1 = new StrongChecksum();
      sc1.update(new Uint8Array([1, 2]));
      sc1.update(new Uint8Array([3, 4]));

      const sc2 = new StrongChecksum();
      sc2.update(new Uint8Array([1, 2, 3, 4]));

      expect(sc1.finalize()).toBe(sc2.finalize());
    });

    it("should handle number array input", () => {
      const sc1 = new StrongChecksum();
      sc1.update([1, 2, 3, 4, 5]);

      const sc2 = new StrongChecksum();
      sc2.update(new Uint8Array([1, 2, 3, 4, 5]));

      expect(sc1.finalize()).toBe(sc2.finalize());
    });
  });

  describe("finalize", () => {
    it("should return 32-bit unsigned integer", () => {
      const sc = new StrongChecksum();
      sc.update(new Uint8Array([1, 2, 3, 4, 5]));

      const result = sc.finalize();
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xffffffff);
    });

    it("should produce consistent results", () => {
      const sc = new StrongChecksum();
      sc.update(new Uint8Array([1, 2, 3, 4, 5]));

      const result1 = sc.finalize();
      const result2 = sc.finalize();

      expect(result1).toBe(result2);
    });

    it("should produce known FNV-1a values", () => {
      const encoder = new TextEncoder();

      // Empty string - FNV-1a basis
      const empty = new StrongChecksum();
      expect(empty.finalize()).toBe(0x811c9dc5);

      // "a"
      const aHash = new StrongChecksum();
      aHash.update(encoder.encode("a"));
      expect(aHash.finalize()).toBe(0xe40c292c);

      // "foobar"
      const foobarHash = new StrongChecksum();
      foobarHash.update(encoder.encode("foobar"));
      expect(foobarHash.finalize()).toBe(0x0ee3c7f0);
    });
  });

  describe("reset", () => {
    it("should reset to initial state", () => {
      const sc = new StrongChecksum();
      sc.update(new Uint8Array([1, 2, 3, 4, 5]));
      sc.reset();

      expect(sc.finalize()).toBe(0x811c9dc5);
    });

    it("should produce same result after reset", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const sc = new StrongChecksum();
      sc.update(data);
      const result1 = sc.finalize();

      sc.reset();
      sc.update(data);
      const result2 = sc.finalize();

      expect(result1).toBe(result2);
    });
  });

  describe("clone", () => {
    it("should create independent copy", () => {
      const sc = new StrongChecksum();
      sc.update(new Uint8Array([1, 2, 3]));

      const cloned = sc.clone();

      // Continue updating original
      sc.update(new Uint8Array([4, 5]));

      // Clone should not be affected
      expect(cloned.finalize()).not.toBe(sc.finalize());
    });

    it("should allow divergent updates", () => {
      const base = new StrongChecksum();
      base.update(new Uint8Array([1, 2, 3]));

      const clone1 = base.clone();
      const clone2 = base.clone();

      clone1.update(new Uint8Array([4]));
      clone2.update(new Uint8Array([5]));

      expect(clone1.finalize()).not.toBe(clone2.finalize());

      // But base should match both clones' starting point
      const directCheck = new StrongChecksum();
      directCheck.update(new Uint8Array([1, 2, 3]));
      expect(base.finalize()).toBe(directCheck.finalize());
    });
  });

  describe("known values", () => {
    const encoder = new TextEncoder();

    it("should hash empty string correctly", () => {
      const sc = new StrongChecksum();
      expect(sc.finalize()).toBe(0x811c9dc5);
    });

    it("should hash 'a' correctly", () => {
      const sc = new StrongChecksum();
      sc.update(encoder.encode("a"));
      expect(sc.finalize()).toBe(0xe40c292c);
    });

    it("should hash 'foobar' correctly", () => {
      const sc = new StrongChecksum();
      sc.update(encoder.encode("foobar"));
      // Matches the strongChecksum function output
      expect(sc.finalize()).toBe(0x0ee3c7f0);
    });
  });
});
