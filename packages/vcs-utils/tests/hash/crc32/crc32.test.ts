import { describe, expect, it } from "vitest";
import { CRC32, crc32 } from "../../../src/hash/crc32/crc32.js";

describe("crc32", () => {
  describe("crc32 function", () => {
    it("computes CRC32 of empty data", () => {
      expect(crc32(new Uint8Array([]))).toBe(0);
    });

    it("computes CRC32 of 'hello'", () => {
      const data = new TextEncoder().encode("hello");
      expect(crc32(data)).toBe(0x3610a686);
    });

    it("computes CRC32 of binary data", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
      const result = crc32(data);
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it("produces unsigned 32-bit integers", () => {
      const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const result = crc32(data);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xffffffff);
    });
  });

  describe("CRC32 class", () => {
    it("produces same result as function for single update", () => {
      const data = new TextEncoder().encode("hello");
      const calc = new CRC32();
      calc.update(data);
      expect(calc.getValue()).toBe(crc32(data));
    });

    it("supports incremental updates", () => {
      const full = new TextEncoder().encode("hello world");
      const part1 = new TextEncoder().encode("hello ");
      const part2 = new TextEncoder().encode("world");

      const calc = new CRC32();
      calc.update(part1);
      calc.update(part2);

      expect(calc.getValue()).toBe(crc32(full));
    });

    it("supports chaining", () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6]);

      const calc = new CRC32();
      const result = calc.update(data1).update(data2).getValue();

      expect(typeof result).toBe("number");
    });

    it("reset clears state", () => {
      const data = new TextEncoder().encode("hello");
      const calc = new CRC32();

      calc.update(data);
      const firstResult = calc.getValue();

      calc.reset();
      calc.update(data);
      const secondResult = calc.getValue();

      expect(firstResult).toBe(secondResult);
    });

    it("clone creates independent copy", () => {
      const calc = new CRC32();
      calc.update(new Uint8Array([1, 2, 3]));

      const cloned = calc.clone();
      calc.update(new Uint8Array([4, 5, 6]));
      cloned.update(new Uint8Array([7, 8, 9]));

      expect(calc.getValue()).not.toBe(cloned.getValue());
    });
  });
});
