import { describe, expect, it } from "vitest";
import type { ByteStream } from "../../../src/compression/compression/types.js";
import { CompressionError } from "../../../src/compression/compression/types.js";
import { deflateWeb, inflateWeb } from "../../../src/compression/compression/web-streams.js";

// Suppress unhandled rejections during error tests
// Node.js's DecompressionStream emits rejections after our catch
let unhandledRejectionHandler: (reason: unknown) => void;

function suppressUnhandledRejections() {
  unhandledRejectionHandler = () => {};
  process.on("unhandledRejection", unhandledRejectionHandler);
}

function restoreUnhandledRejections() {
  process.off("unhandledRejection", unhandledRejectionHandler);
}

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

describe("deflateWeb", () => {
  const encoder = new TextEncoder();

  it("should compress data", async () => {
    const input = encoder.encode("Hello, World!");
    const stream = toByteStream([input]);

    const compressed = await collectStream(deflateWeb(stream));

    // Compressed data should exist and be different from input
    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.length).toBeGreaterThan(0);
  });

  it("should compress empty data", async () => {
    const input = new Uint8Array(0);
    const stream = toByteStream([input]);

    const compressed = await collectStream(deflateWeb(stream));

    expect(compressed).toBeInstanceOf(Uint8Array);
  });

  it("should compress multiple chunks", async () => {
    const chunk1 = encoder.encode("Hello, ");
    const chunk2 = encoder.encode("World!");
    const stream = toByteStream([chunk1, chunk2]);

    const compressed = await collectStream(deflateWeb(stream));

    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.length).toBeGreaterThan(0);
  });

  it("should compress large data", async () => {
    const input = new Uint8Array(10000).fill(0x42);
    const stream = toByteStream([input]);

    const compressed = await collectStream(deflateWeb(stream));

    expect(compressed).toBeInstanceOf(Uint8Array);
    // Repetitive data should compress well
    expect(compressed.length).toBeLessThan(input.length);
  });

  it("should use raw format when specified", async () => {
    const input = encoder.encode("Test data for raw format");
    const stream = toByteStream([input]);

    const compressed = await collectStream(deflateWeb(stream, { raw: true }));

    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.length).toBeGreaterThan(0);
  });

  it("should use ZLIB format by default", async () => {
    const input = encoder.encode("Test data for ZLIB format");
    const stream = toByteStream([input]);

    const compressed = await collectStream(deflateWeb(stream));

    expect(compressed).toBeInstanceOf(Uint8Array);
    // ZLIB format has a header (first byte typically 0x78)
    expect(compressed[0]).toBe(0x78);
  });
});

describe("inflateWeb", () => {
  const encoder = new TextEncoder();

  it("should decompress data compressed with deflateWeb", async () => {
    const original = encoder.encode("Hello, World!");

    // Compress
    const compressedStream = deflateWeb(toByteStream([original]));
    const compressed = await collectStream(compressedStream);

    // Decompress
    const decompressedStream = inflateWeb(toByteStream([compressed]));
    const decompressed = await collectStream(decompressedStream);

    expect(decompressed).toEqual(original);
  });

  it("should decompress empty data", async () => {
    const original = new Uint8Array(0);

    // Compress
    const compressedStream = deflateWeb(toByteStream([original]));
    const compressed = await collectStream(compressedStream);

    // Decompress
    const decompressedStream = inflateWeb(toByteStream([compressed]));
    const decompressed = await collectStream(decompressedStream);

    expect(decompressed).toEqual(original);
  });

  it("should handle compressed data in multiple chunks", async () => {
    const original = encoder.encode("Hello, World! This is a test message.");

    // Compress
    const compressed = await collectStream(deflateWeb(toByteStream([original])));

    // Split compressed data into multiple chunks
    const mid = Math.floor(compressed.length / 2);
    const chunk1 = compressed.slice(0, mid);
    const chunk2 = compressed.slice(mid);

    // Decompress from chunks
    const decompressed = await collectStream(inflateWeb(toByteStream([chunk1, chunk2])));

    expect(decompressed).toEqual(original);
  });

  it("should throw CompressionError for invalid compressed data", async () => {
    suppressUnhandledRejections();
    try {
      const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const stream = toByteStream([invalidData]);

      await expect(collectStream(inflateWeb(stream))).rejects.toThrow(CompressionError);
      // Wait for async rejections from Node.js stream internals
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      restoreUnhandledRejections();
    }
  });

  it("should throw CompressionError with descriptive message", async () => {
    suppressUnhandledRejections();
    try {
      const invalidData = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const stream = toByteStream([invalidData]);

      await expect(collectStream(inflateWeb(stream))).rejects.toThrow("Web decompression failed");
      // Wait for async rejections from Node.js stream internals
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      restoreUnhandledRejections();
    }
  });
});

describe("deflateWeb and inflateWeb round-trip", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  it("should round-trip text data", async () => {
    const original = "The quick brown fox jumps over the lazy dog";
    const encoded = encoder.encode(original);

    const compressed = await collectStream(deflateWeb(toByteStream([encoded])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decoder.decode(decompressed)).toBe(original);
  });

  it("should round-trip binary data", async () => {
    const original = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decompressed).toEqual(original);
  });

  it("should round-trip large data", async () => {
    const original = new Uint8Array(50000);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decompressed).toEqual(original);
  });

  it("should round-trip with raw format", async () => {
    const original = encoder.encode("Testing raw DEFLATE format");

    const compressed = await collectStream(deflateWeb(toByteStream([original]), { raw: true }));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed]), { raw: true }));

    expect(decompressed).toEqual(original);
  });

  it("should round-trip with ZLIB format (default)", async () => {
    const original = encoder.encode("Testing ZLIB format");

    const compressed = await collectStream(deflateWeb(toByteStream([original]), { raw: false }));
    const decompressed = await collectStream(
      inflateWeb(toByteStream([compressed]), { raw: false }),
    );

    expect(decompressed).toEqual(original);
  });

  it("should round-trip multiple input chunks", async () => {
    const chunk1 = encoder.encode("First chunk of data. ");
    const chunk2 = encoder.encode("Second chunk of data. ");
    const chunk3 = encoder.encode("Third chunk of data.");

    const compressed = await collectStream(deflateWeb(toByteStream([chunk1, chunk2, chunk3])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    const expected = new Uint8Array(chunk1.length + chunk2.length + chunk3.length);
    expected.set(chunk1, 0);
    expected.set(chunk2, chunk1.length);
    expected.set(chunk3, chunk1.length + chunk2.length);

    expect(decompressed).toEqual(expected);
  });

  it("should produce deterministic compressed output", async () => {
    const original = encoder.encode("Deterministic test data");

    const compressed1 = await collectStream(deflateWeb(toByteStream([original])));
    const compressed2 = await collectStream(deflateWeb(toByteStream([original])));

    expect(compressed1).toEqual(compressed2);
  });

  it("should handle unicode text", async () => {
    const original = "Hello, 世界! 🌍 Привет мир!";
    const encoded = encoder.encode(original);

    const compressed = await collectStream(deflateWeb(toByteStream([encoded])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decoder.decode(decompressed)).toBe(original);
  });

  it("should handle highly compressible data", async () => {
    const original = new Uint8Array(10000).fill(0x00);

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decompressed).toEqual(original);
    // All zeros should compress very well
    expect(compressed.length).toBeLessThan(original.length / 10);
  });

  it("should handle incompressible random-like data", async () => {
    // Create pseudo-random data that doesn't compress well
    const original = new Uint8Array(1000);
    for (let i = 0; i < original.length; i++) {
      original[i] = (i * 17 + 31) % 256;
    }

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decompressed).toEqual(original);
  });
});

describe("format compatibility", () => {
  const encoder = new TextEncoder();

  it("should not decompress raw format with ZLIB decompressor", async () => {
    suppressUnhandledRejections();
    try {
      const original = encoder.encode("Format mismatch test");

      // Compress with raw format
      const compressed = await collectStream(deflateWeb(toByteStream([original]), { raw: true }));

      // Try to decompress with ZLIB format (should fail)
      await expect(
        collectStream(inflateWeb(toByteStream([compressed]), { raw: false })),
      ).rejects.toThrow(CompressionError);
      // Wait for async rejections from Node.js stream internals
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      restoreUnhandledRejections();
    }
  });

  it("should not decompress ZLIB format with raw decompressor", async () => {
    suppressUnhandledRejections();
    try {
      const original = encoder.encode("Format mismatch test");

      // Compress with ZLIB format (default)
      const compressed = await collectStream(deflateWeb(toByteStream([original]), { raw: false }));

      // Try to decompress with raw format (should fail)
      await expect(
        collectStream(inflateWeb(toByteStream([compressed]), { raw: true })),
      ).rejects.toThrow(CompressionError);
      // Wait for async rejections from Node.js stream internals
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      restoreUnhandledRejections();
    }
  });
});
