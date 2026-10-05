import { describe, expect, it } from "vitest";
import { RollingChecksum } from "../../../src/hash/rolling-checksum/index.js";

describe("RollingChecksum", () => {
  describe("init", () => {
    it("should initialize with correct values for a window", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 5);

      expect(rc.windowSize).toBe(5);
      expect(rc.value()).toBeGreaterThan(0);
    });

    it("should handle single-byte window", () => {
      const buf = new Uint8Array([42]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 1);

      expect(rc.windowSize).toBe(1);
      expect(rc.value()).toBeGreaterThan(0);
    });

    it("should handle offset into buffer", () => {
      const buf = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
      const rc = new RollingChecksum();
      rc.init(buf, 2, 3);

      const expected = new RollingChecksum();
      expected.init(new Uint8Array([1, 2, 3]), 0, 3);

      expect(rc.value()).toBe(expected.value());
    });

    it("should be chainable", () => {
      const buf = new Uint8Array([1, 2, 3]);
      const rc = new RollingChecksum();
      const result = rc.init(buf, 0, 3);

      expect(result).toBe(rc);
    });
  });

  describe("update", () => {
    it("should return updated checksum value", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 3);

      const initialValue = rc.value();
      const newValue = rc.update(1, 4); // remove 1, add 4 -> window [2,3,4]

      expect(newValue).not.toBe(initialValue);
      expect(newValue).toBe(rc.value());
    });

    it("should maintain consistency when sliding through data", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const windowSize = 4;

      // Compute checksum by sliding
      const rc = new RollingChecksum();
      rc.init(buf, 0, windowSize);

      // Slide to position 1
      rc.update(buf[0], buf[windowSize]);

      // Compute directly at position 1
      const direct = new RollingChecksum();
      direct.init(buf, 1, windowSize);

      expect(rc.value()).toBe(direct.value());
    });

    it("should match direct computation after multiple slides", () => {
      const buf = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
      const windowSize = 4;

      const rc = new RollingChecksum();
      rc.init(buf, 0, windowSize);

      // Slide through several positions
      for (let pos = 0; pos < 5; pos++) {
        rc.update(buf[pos], buf[pos + windowSize]);
      }

      // Should now be at position 5, window [60, 70, 80, 90]
      const direct = new RollingChecksum();
      direct.init(buf, 5, windowSize);

      expect(rc.value()).toBe(direct.value());
    });

    it("should handle zero bytes", () => {
      const buf = new Uint8Array([0, 0, 0, 1, 0, 0]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 3);

      // Slide: remove 0, add 1
      const value = rc.update(0, 1);
      expect(value).toBeGreaterThanOrEqual(0);
    });

    it("should handle 0xFF bytes", () => {
      const buf = new Uint8Array([255, 255, 255, 1, 255, 255]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 3);

      // Slide: remove 255, add 1
      const value = rc.update(255, 1);
      expect(value).toBeGreaterThanOrEqual(0);
    });
  });

  describe("value", () => {
    it("should return 32-bit checksum", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 5);

      const value = rc.value();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    });

    it("should combine s1 and s2 correctly", () => {
      // For a simple case: [1]
      // s1 = 1, s2 = 1
      // value = (1 & 0xffff) | ((1 & 0xffff) << 16) = 1 | (1 << 16) = 65537
      const buf = new Uint8Array([1]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 1);

      expect(rc.value()).toBe(65537);
    });

    it("should be idempotent", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 5);

      const value1 = rc.value();
      const value2 = rc.value();
      const value3 = rc.value();

      expect(value1).toBe(value2);
      expect(value2).toBe(value3);
    });
  });

  describe("reset", () => {
    it("should clear all state", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5]);
      const rc = new RollingChecksum();
      rc.init(buf, 0, 5);

      rc.reset();

      expect(rc.windowSize).toBe(0);
      expect(rc.value()).toBe(0);
    });

    it("should allow reinitialization", () => {
      const buf1 = new Uint8Array([1, 2, 3]);
      const buf2 = new Uint8Array([4, 5, 6]);

      const rc = new RollingChecksum();
      rc.init(buf1, 0, 3);
      const value1 = rc.value();

      rc.reset();
      rc.init(buf2, 0, 3);
      const value2 = rc.value();

      // Values should be different
      expect(value1).not.toBe(value2);

      // Should match fresh computation
      const fresh = new RollingChecksum();
      fresh.init(buf2, 0, 3);
      expect(value2).toBe(fresh.value());
    });
  });

  describe("integration", () => {
    it("should find matching blocks in similar data", () => {
      // Source and target with a matching block at aligned position
      const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const target = new Uint8Array([0, 0, 1, 2, 3, 4, 0, 0]);

      const blockSize = 4;

      // Build index of source blocks (at every position for better matching)
      const sourceChecksums = new Map<number, number>();
      const indexRc = new RollingChecksum();
      for (let i = 0; i <= source.length - blockSize; i++) {
        indexRc.reset();
        const checksum = indexRc.init(source, i, blockSize).value();
        if (!sourceChecksums.has(checksum)) {
          sourceChecksums.set(checksum, i);
        }
      }

      // Search for matching block in target using rolling checksum
      const rc = new RollingChecksum();
      rc.init(target, 0, blockSize);

      let foundMatch = false;
      let matchPos = -1;

      for (let i = 0; i <= target.length - blockSize; i++) {
        const checksum = i === 0 ? rc.value() : rc.update(target[i - 1], target[i + blockSize - 1]);

        if (sourceChecksums.has(checksum)) {
          foundMatch = true;
          matchPos = sourceChecksums.get(checksum) ?? -1;
          break;
        }
      }

      expect(foundMatch).toBe(true);
      expect(matchPos).toBe(0); // Block [1,2,3,4] matches at source position 0
    });

    it("should produce different values for different windows", () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const checksums = new Set<number>();
      const rc = new RollingChecksum();

      for (let i = 0; i <= buf.length - 4; i++) {
        rc.reset();
        const checksum = rc.init(buf, i, 4).value();
        checksums.add(checksum);
      }

      // All windows should have unique checksums (for this data)
      expect(checksums.size).toBe(buf.length - 4 + 1);
    });

    it("should handle various buffer sizes", () => {
      const rc = new RollingChecksum();
      for (let size = 1; size <= 32; size++) {
        const buf = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          buf[i] = i + 1;
        }

        rc.reset();
        const checksum = rc.init(buf, 0, size).value();
        expect(checksum).toBeGreaterThanOrEqual(0);
        expect(checksum).toBeLessThanOrEqual(0xffffffff);
      }
    });

    it("should handle offset correctly", () => {
      const buf = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
      const rc1 = new RollingChecksum();
      const rc2 = new RollingChecksum();

      const withOffset = rc1.init(buf, 2, 3).value();
      const direct = rc2.init(new Uint8Array([1, 2, 3]), 0, 3).value();

      expect(withOffset).toBe(direct);
    });
  });
});
