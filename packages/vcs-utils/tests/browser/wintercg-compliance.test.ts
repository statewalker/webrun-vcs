/**
 * WinterTC/WinterCG Compliance Tests
 *
 * These tests verify that @statewalker/vcs-utils works correctly
 * in browser environment using only Web Platform APIs.
 *
 * APIs tested:
 * - CompressionStream/DecompressionStream (Web Compression API)
 * - crypto.subtle (Web Crypto API)
 * - TextEncoder/TextDecoder
 * - Uint8Array and TypedArrays
 * - AsyncIterators
 */

import { describe, expect, it } from "vitest";
import {
  createPakoCompression,
  setCompressionUtils,
} from "../../src/compression/compression/index.js";
import type { ByteStream } from "../../src/compression/compression/types.js";
import { deflateWeb, inflateWeb } from "../../src/compression/compression/web-streams.js";
import { createInMemoryFilesApi } from "../../src/files/index.js";
import { crc32 } from "../../src/hash/crc32/crc32.js";
import { sha1 } from "../../src/hash/sha1/sha1-async.js";

// Initialize pako compression for tests
setCompressionUtils(createPakoCompression());

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

describe("WinterTC Compliance: Compression", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  it("should compress and decompress with Web Streams API", async () => {
    const original = "Hello, World! Testing browser compression.";
    const encoded = encoder.encode(original);

    const compressed = await collectStream(deflateWeb(toByteStream([encoded])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decoder.decode(decompressed)).toBe(original);
  });

  it("should compress and decompress with pako (portable)", async () => {
    const original = encoder.encode("Pako compression test");

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    expect(compressed.length).toBeGreaterThan(0);

    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));
    expect(decompressed).toEqual(original);
  });

  it("should handle binary data", async () => {
    const original = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);

    const compressed = await collectStream(deflateWeb(toByteStream([original])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decompressed).toEqual(original);
  });

  it("should handle unicode text", async () => {
    const original = "Hello, 世界! 🌍 Привет мир!";
    const encoded = encoder.encode(original);

    const compressed = await collectStream(deflateWeb(toByteStream([encoded])));
    const decompressed = await collectStream(inflateWeb(toByteStream([compressed])));

    expect(decoder.decode(decompressed)).toBe(original);
  });
});

describe("WinterTC Compliance: Web Crypto API", () => {
  const encoder = new TextEncoder();

  /**
   * Helper to convert Uint8Array to hex string
   */
  function toHex(data: Uint8Array): string {
    return Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("should compute SHA-1 hash using crypto.subtle", async () => {
    const data = encoder.encode("test");

    const hash = await sha1(data);

    // SHA-1 returns 20 bytes
    expect(hash).toHaveLength(20);
    expect(toHex(hash)).toBe("a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
  });

  it("should compute SHA-1 hash of empty data", async () => {
    const data = new Uint8Array(0);

    const hash = await sha1(data);

    // SHA-1 of empty string
    expect(toHex(hash)).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("should compute SHA-1 hash of binary data", async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

    const hash = await sha1(data);

    // SHA-1 returns 20 bytes
    expect(hash).toHaveLength(20);
    // All hex characters when converted
    expect(toHex(hash)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("WinterTC Compliance: CRC32", () => {
  const encoder = new TextEncoder();

  it("should compute CRC32 checksum", () => {
    const data = encoder.encode("test");

    const checksum = crc32(data);

    expect(typeof checksum).toBe("number");
    // CRC32 of "test" is a known value
    expect(checksum).toBe(0xd87f7e0c);
  });

  it("should compute CRC32 of empty data", () => {
    const data = new Uint8Array(0);

    const checksum = crc32(data);

    expect(checksum).toBe(0);
  });
});

describe("WinterTC Compliance: In-Memory Files API", () => {
  it("should create in-memory filesystem", async () => {
    const files = createInMemoryFilesApi();

    expect(files).toBeDefined();
    expect(typeof files.read).toBe("function");
    expect(typeof files.write).toBe("function");
    expect(typeof files.mkdir).toBe("function");
  });

  it("should write and read files", async () => {
    const files = createInMemoryFilesApi();
    const encoder = new TextEncoder();

    await files.mkdir("test");
    await files.write("test/file.txt", [encoder.encode("Hello, World!")]);

    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read("test/file.txt")) {
      chunks.push(chunk);
    }

    const content = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const result = new Uint8Array(acc.length + chunk.length);
        result.set(acc);
        result.set(chunk, acc.length);
        return result;
      }, new Uint8Array(0)),
    );

    expect(content).toBe("Hello, World!");
  });

  it("should list directory contents", async () => {
    const files = createInMemoryFilesApi();
    const encoder = new TextEncoder();

    await files.mkdir("dir");
    await files.write("dir/a.txt", [encoder.encode("a")]);
    await files.write("dir/b.txt", [encoder.encode("b")]);

    const entries: string[] = [];
    for await (const entry of files.list("dir")) {
      entries.push(entry.name);
    }

    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("WinterTC Compliance: Standard APIs", () => {
  it("should have TextEncoder/TextDecoder", () => {
    expect(typeof TextEncoder).toBe("function");
    expect(typeof TextDecoder).toBe("function");

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const encoded = encoder.encode("Hello");
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decoder.decode(encoded);
    expect(decoded).toBe("Hello");
  });

  it("should have Uint8Array and typed arrays", () => {
    expect(typeof Uint8Array).toBe("function");
    expect(typeof Int8Array).toBe("function");
    expect(typeof Uint32Array).toBe("function");

    const arr = new Uint8Array([1, 2, 3]);
    expect(arr.length).toBe(3);
    expect(arr[0]).toBe(1);
  });

  it("should support async iterators", async () => {
    async function* generator(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      yield 3;
    }

    const values: number[] = [];
    for await (const value of generator()) {
      values.push(value);
    }

    expect(values).toEqual([1, 2, 3]);
  });

  it("should have crypto.subtle available", () => {
    expect(typeof crypto).toBe("object");
    expect(typeof crypto.subtle).toBe("object");
    expect(typeof crypto.subtle.digest).toBe("function");
  });

  it("should have CompressionStream and DecompressionStream", () => {
    // These are Web Platform APIs for compression
    expect(typeof CompressionStream).toBe("function");
    expect(typeof DecompressionStream).toBe("function");
  });
});
