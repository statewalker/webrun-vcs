import { describe, expect, test } from "vitest";
import { FossilChecksum } from "../../../src/hash/fossil-checksum/index.js";
import { checksum } from "./checksum.js";

describe("FossilChecksum - Incremental checksum calculation", () => {
  test("should match checksum function for single update", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, data.length);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should match checksum function for multiple updates", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 8);
    checksumObj.update(data, 8, 8);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should match checksum function for various block sizes", () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 20);
    checksumObj.update(data, 20, 30);
    checksumObj.update(data, 50, 50);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle empty array", () => {
    const data = new Uint8Array(0);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 0);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle single byte", () => {
    const data = new Uint8Array([42]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 1);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle two bytes", () => {
    const data = new Uint8Array([42, 84]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 2);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle three bytes", () => {
    const data = new Uint8Array([42, 84, 126]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 3);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle exactly 4 bytes", () => {
    const data = new Uint8Array([1, 2, 3, 4]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 4);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle exactly 16 bytes", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 16);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle 17 bytes (16 + 1)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 17);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle 18 bytes (16 + 2)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 18);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle 19 bytes (16 + 3)", () => {
    const data = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 19);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle updates with odd boundaries", () => {
    const data = new Uint8Array(50);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 7) % 256;
    }

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, 7);
    checksumObj.update(data, 7, 13);
    checksumObj.update(data, 20, 17);
    checksumObj.update(data, 37, 13);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle large data block by block", () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 13 + 7) % 256;
    }

    const checksumObj = new FossilChecksum();
    const blockSize = 100;
    for (let i = 0; i < data.length; i += blockSize) {
      checksumObj.update(data, i, Math.min(blockSize, data.length - i));
    }
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle many small updates", () => {
    const data = new Uint8Array(50);
    for (let i = 0; i < data.length; i++) {
      data[i] = i;
    }

    const checksumObj = new FossilChecksum();
    for (let i = 0; i < data.length; i++) {
      checksumObj.update(data, i, 1);
    }
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle offset correctly", () => {
    const data = new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5, 0, 0]);
    const expectedData = new Uint8Array([1, 2, 3, 4, 5]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 3, 5);
    const result = checksumObj.finalize();

    const expected = checksum(expectedData);

    expect(result).toBe(expected);
  });

  test("should allow multiple finalize calls", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, data.length);
    const result1 = checksumObj.finalize();
    const result2 = checksumObj.finalize();

    expect(result1).toBe(result2);
  });

  test("should match checksum for realistic text data", () => {
    const text = "Hello, World! This is a test of the incremental checksum calculation.";
    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    const checksumObj = new FossilChecksum();
    // checksumObj.update(data, 0, data.length);
    const blockSize = 3;
    for (let i = 0; i < data.length; i += blockSize) {
      checksumObj.update(data, i, blockSize);
    }
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle zero bytes correctly", () => {
    const data = new Uint8Array([0, 0, 0, 0, 0]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, data.length);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  test("should handle maximum byte values", () => {
    const data = new Uint8Array([255, 255, 255, 255, 255]);

    const checksumObj = new FossilChecksum();
    checksumObj.update(data, 0, data.length);
    const result = checksumObj.finalize();

    const expected = checksum(data);

    expect(result).toBe(expected);
  });

  describe("reset", () => {
    test("should reset to initial state", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const checksumObj = new FossilChecksum();
      checksumObj.update(data, 0, data.length);
      checksumObj.finalize();
      checksumObj.reset();

      // After reset, finalize should return same as empty data
      const emptyChecksum = new FossilChecksum();
      expect(checksumObj.finalize()).toBe(emptyChecksum.finalize());
    });

    test("should produce same result after reset and re-update", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const checksumObj = new FossilChecksum();
      checksumObj.update(data, 0, data.length);
      const firstResult = checksumObj.finalize();

      checksumObj.reset();
      checksumObj.update(data, 0, data.length);
      const secondResult = checksumObj.finalize();

      expect(firstResult).toBe(secondResult);
    });

    test("should allow using with different data after reset", () => {
      const data1 = new Uint8Array([1, 2, 3, 4]);
      const data2 = new Uint8Array([5, 6, 7, 8]);

      const checksumObj = new FossilChecksum();
      checksumObj.update(data1, 0, data1.length);
      const result1 = checksumObj.finalize();

      checksumObj.reset();
      checksumObj.update(data2, 0, data2.length);
      const result2 = checksumObj.finalize();

      // Should match fresh instances
      const fresh1 = new FossilChecksum();
      fresh1.update(data1, 0, data1.length);
      expect(result1).toBe(fresh1.finalize());

      const fresh2 = new FossilChecksum();
      fresh2.update(data2, 0, data2.length);
      expect(result2).toBe(fresh2.finalize());
    });
  });
});
