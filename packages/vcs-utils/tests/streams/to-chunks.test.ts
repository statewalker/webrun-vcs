import { describe, expect, it } from "vitest";
import { toChunks } from "../../src/streams/to-chunks";

describe("toChunks()", () => {
  // Helper to create Uint8Array from numbers
  function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
  }

  // Helper to collect all chunks from async generator
  async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
    const result: Uint8Array[] = [];
    for await (const chunk of gen) {
      result.push(chunk);
    }
    return result;
  }

  // =============================================================================
  // Basic functionality
  // =============================================================================

  it("should return empty for empty stream", async () => {
    const chunks = await collect(toChunks([], 4));
    expect(chunks).toEqual([]);
  });

  it("should return single chunk smaller than size", async () => {
    const input = [bytes(1, 2, 3)];
    const chunks = await collect(toChunks(input, 10));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes(1, 2, 3));
  });

  it("should return single chunk exactly matching size", async () => {
    const input = [bytes(1, 2, 3, 4)];
    const chunks = await collect(toChunks(input, 4));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes(1, 2, 3, 4));
  });

  it("should split into multiple chunks when larger than size", async () => {
    const input = [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)];
    const chunks = await collect(toChunks(input, 4));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(bytes(1, 2, 3, 4));
    expect(chunks[1]).toEqual(bytes(5, 6, 7, 8));
    expect(chunks[2]).toEqual(bytes(9, 10)); // Remainder
  });

  // =============================================================================
  // Multiple input chunks
  // =============================================================================

  it("should combine small input chunks into fixed-size output", async () => {
    const input = [bytes(1, 2), bytes(3, 4), bytes(5, 6)];
    const chunks = await collect(toChunks(input, 4));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(bytes(1, 2, 3, 4));
    expect(chunks[1]).toEqual(bytes(5, 6)); // Remainder
  });

  it("should handle uneven input chunks", async () => {
    const input = [bytes(1), bytes(2, 3, 4, 5), bytes(6, 7)];
    const chunks = await collect(toChunks(input, 3));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(bytes(1, 2, 3));
    expect(chunks[1]).toEqual(bytes(4, 5, 6));
    expect(chunks[2]).toEqual(bytes(7)); // Remainder
  });

  it("should handle empty input chunks interspersed", async () => {
    const input = [bytes(1, 2), bytes(), bytes(3, 4), bytes(), bytes(5)];
    const chunks = await collect(toChunks(input, 2));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(bytes(1, 2));
    expect(chunks[1]).toEqual(bytes(3, 4));
    expect(chunks[2]).toEqual(bytes(5)); // Remainder
  });

  // =============================================================================
  // Async iterables
  // =============================================================================

  it("should work with async iterable input", async () => {
    async function* asyncInput(): AsyncGenerator<Uint8Array> {
      yield bytes(1, 2);
      yield bytes(3, 4);
      yield bytes(5);
    }

    const chunks = await collect(toChunks(asyncInput(), 3));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(bytes(1, 2, 3));
    expect(chunks[1]).toEqual(bytes(4, 5)); // Remainder
  });

  // =============================================================================
  // Edge cases
  // =============================================================================

  it("should handle single byte chunks", async () => {
    const input = [bytes(1), bytes(2), bytes(3), bytes(4), bytes(5)];
    const chunks = await collect(toChunks(input, 2));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(bytes(1, 2));
    expect(chunks[1]).toEqual(bytes(3, 4));
    expect(chunks[2]).toEqual(bytes(5)); // Remainder
  });

  it("should handle chunk size of 1", async () => {
    const input = [bytes(1, 2, 3)];
    const chunks = await collect(toChunks(input, 1));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(bytes(1));
    expect(chunks[1]).toEqual(bytes(2));
    expect(chunks[2]).toEqual(bytes(3));
  });

  it("should handle very large chunk size", async () => {
    const input = [bytes(1, 2, 3), bytes(4, 5)];
    const chunks = await collect(toChunks(input, 1000));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes(1, 2, 3, 4, 5));
  });

  // =============================================================================
  // Default size
  // =============================================================================

  it("should use default 128KB chunk size", async () => {
    // Create a 256KB + 1 byte input
    const size = 128 * 1024;
    const data = new Uint8Array(size * 2 + 1);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const chunks = await collect(toChunks([data]));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(size);
    expect(chunks[1].length).toBe(size);
    expect(chunks[2].length).toBe(1);
  });

  // =============================================================================
  // Data integrity
  // =============================================================================

  it("should preserve all data across chunking", async () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }

    // Split into irregular chunks
    const input = [
      original.slice(0, 100),
      original.slice(100, 350),
      original.slice(350, 351),
      original.slice(351, 999),
      original.slice(999),
    ];

    const chunks = await collect(toChunks(input, 128));

    // Reconstruct
    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
    }
    expect(totalLength).toBe(original.length);

    const reconstructed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      reconstructed.set(chunk, offset);
      offset += chunk.length;
    }

    expect(reconstructed).toEqual(original);
  });

  // =============================================================================
  // Byte-by-byte streaming (size=1)
  // =============================================================================

  it("should work with size=1 and large input", async () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const chunks = await collect(toChunks([data], 1));

    expect(chunks).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(chunks[i]).toEqual(bytes(i % 256));
    }
  });

  it("should work with size=1 and multiple input chunks", async () => {
    const input = [bytes(1, 2, 3), bytes(4, 5), bytes(6)];
    const chunks = await collect(toChunks(input, 1));

    expect(chunks).toHaveLength(6);
    expect(chunks.map((c) => c[0])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // =============================================================================
  // Big chunks split into multiple outputs
  // =============================================================================

  it("should split a single big chunk into many fixed-size outputs", async () => {
    // 1000 bytes input, 100 byte chunks => 10 output chunks
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const chunks = await collect(toChunks([data], 100));

    expect(chunks).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(chunks[i].length).toBe(100);
      // Verify data integrity
      for (let j = 0; j < 100; j++) {
        expect(chunks[i][j]).toBe((i * 100 + j) % 256);
      }
    }
  });

  it("should handle big chunk with remainder", async () => {
    // 1050 bytes input, 100 byte chunks => 10 full + 1 partial
    const data = new Uint8Array(1050);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const chunks = await collect(toChunks([data], 100));

    expect(chunks).toHaveLength(11);
    for (let i = 0; i < 10; i++) {
      expect(chunks[i].length).toBe(100);
    }
    expect(chunks[10].length).toBe(50);
  });

  // =============================================================================
  // Stress test: many small chunks into one output
  // =============================================================================

  it("should combine many single-byte inputs into fixed-size outputs", async () => {
    // 256 single-byte inputs, 16 byte chunks => 16 output chunks
    const input: Uint8Array[] = [];
    for (let i = 0; i < 256; i++) {
      input.push(bytes(i));
    }

    const chunks = await collect(toChunks(input, 16));

    expect(chunks).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      expect(chunks[i].length).toBe(16);
      // Verify data integrity
      for (let j = 0; j < 16; j++) {
        expect(chunks[i][j]).toBe(i * 16 + j);
      }
    }
  });

  // =============================================================================
  // Boundary conditions
  // =============================================================================

  it("should handle input exactly divisible by chunk size", async () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < data.length; i++) {
      data[i] = i;
    }

    const chunks = await collect(toChunks([data], 25));

    expect(chunks).toHaveLength(4);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(25);
    }
  });

  it("should handle multiple inputs summing to exact multiple of chunk size", async () => {
    const input = [bytes(1, 2), bytes(3, 4), bytes(5, 6)];
    const chunks = await collect(toChunks(input, 3));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(bytes(1, 2, 3));
    expect(chunks[1]).toEqual(bytes(4, 5, 6));
  });
});
