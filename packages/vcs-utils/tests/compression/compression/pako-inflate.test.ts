import { describe, expect, it } from "vitest";
import { decompressBlockPartialPako } from "../../../src/compression/compression/pako-inflate.js";
import type { ByteStream } from "../../../src/compression/compression/types.js";
import { CompressionError } from "../../../src/compression/compression/types.js";
import { deflateWeb } from "../../../src/compression/compression/web-streams.js";

/**
 * Helper to create a ByteStream from Uint8Array chunks
 */
async function* toByteStream(chunks: Uint8Array[]): ByteStream {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Helper to collect all chunks from a ByteStream into a single Uint8Array
 */
async function collectStream(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("decompressBlockPartialPako", () => {
  const encoder = new TextEncoder();

  it("should decompress data with no trailing bytes", async () => {
    const original = encoder.encode("Hello, World!");

    // Compress the data
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Decompress with pako partial function
    const result = decompressBlockPartialPako(compressed);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should decompress data and report correct bytes consumed when trailing data present", async () => {
    const original = encoder.encode("Test data for partial decompression");

    // Compress the data
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Append trailing garbage data
    const trailingData = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
    const dataWithTrailing = new Uint8Array(compressed.length + trailingData.length);
    dataWithTrailing.set(compressed, 0);
    dataWithTrailing.set(trailingData, compressed.length);

    // Decompress - should find exact boundary
    const result = decompressBlockPartialPako(dataWithTrailing);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should handle concatenated compressed streams", async () => {
    const first = encoder.encode("First compressed block");
    const second = encoder.encode("Second compressed block");

    // Compress both blocks
    const compressedFirst = await collectStream(deflateWeb(toByteStream([first])));
    const compressedSecond = await collectStream(deflateWeb(toByteStream([second])));

    // Concatenate them (simulating git pack file format)
    const concatenated = new Uint8Array(compressedFirst.length + compressedSecond.length);
    concatenated.set(compressedFirst, 0);
    concatenated.set(compressedSecond, compressedFirst.length);

    // Decompress first block - should stop at boundary
    const result1 = decompressBlockPartialPako(concatenated);

    expect(result1.data).toEqual(first);
    expect(result1.bytesRead).toBe(compressedFirst.length);

    // Decompress second block from remaining data
    const remaining = concatenated.subarray(result1.bytesRead);
    const result2 = decompressBlockPartialPako(remaining);

    expect(result2.data).toEqual(second);
    expect(result2.bytesRead).toBe(compressedSecond.length);
  });

  it("should work with raw DEFLATE format", async () => {
    const original = encoder.encode("Raw DEFLATE test data");

    // Compress with raw format
    const compressed = await collectStream(deflateWeb(toByteStream([original]), { raw: true }));

    // Append trailing data
    const trailing = new Uint8Array([0x11, 0x22, 0x33]);
    const withTrailing = new Uint8Array(compressed.length + trailing.length);
    withTrailing.set(compressed, 0);
    withTrailing.set(trailing, compressed.length);

    // Decompress with raw format
    const result = decompressBlockPartialPako(withTrailing, { raw: true });

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should throw CompressionError for invalid compressed data", () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    expect(() => decompressBlockPartialPako(invalidData)).toThrow(CompressionError);
  });

  it("should throw CompressionError with descriptive message for invalid data", () => {
    const invalidData = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    expect(() => decompressBlockPartialPako(invalidData)).toThrow("Pako");
  });

  it("should handle empty content", async () => {
    const original = new Uint8Array(0);

    // Compress empty data
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    const result = decompressBlockPartialPako(compressed);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should handle large data", async () => {
    // Create 10KB of data
    const original = new Uint8Array(10000);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }

    // Compress
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Add trailing bytes
    const trailing = new Uint8Array(100).fill(0x42);
    const withTrailing = new Uint8Array(compressed.length + trailing.length);
    withTrailing.set(compressed, 0);
    withTrailing.set(trailing, compressed.length);

    // Decompress
    const result = decompressBlockPartialPako(withTrailing);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should handle highly compressible data", async () => {
    // All zeros compress very well
    const original = new Uint8Array(5000).fill(0x00);

    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Add trailing data
    const trailing = encoder.encode("trailing garbage");
    const withTrailing = new Uint8Array(compressed.length + trailing.length);
    withTrailing.set(compressed, 0);
    withTrailing.set(trailing, compressed.length);

    const result = decompressBlockPartialPako(withTrailing);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should handle minimal trailing data (1 byte)", async () => {
    const original = encoder.encode("Minimal trailing test");

    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Add just 1 byte of trailing data
    const withTrailing = new Uint8Array(compressed.length + 1);
    withTrailing.set(compressed, 0);
    withTrailing[compressed.length] = 0xff;

    const result = decompressBlockPartialPako(withTrailing);

    expect(result.data).toEqual(original);
    expect(result.bytesRead).toBe(compressed.length);
  });

  it("should be synchronous (returns immediately)", async () => {
    const original = encoder.encode("Synchronous test");
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // The function should return a value, not a Promise
    const result = decompressBlockPartialPako(compressed);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.data).toEqual(original);
  });
});
