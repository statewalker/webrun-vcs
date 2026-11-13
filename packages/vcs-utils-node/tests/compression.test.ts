import { deflateSync } from "node:zlib";
import {
  collect,
  compressBlock,
  decompressBlock,
  decompressBlockPartial,
  deflate,
  inflate,
  setCompressionUtils,
} from "@statewalker/vcs-utils";
import { beforeAll, describe, expect, it } from "vitest";
import { createNodeCompression, deflateNode, inflateNode } from "../src/compression/index.js";

describe("Node.js Compression", () => {
  beforeAll(() => {
    setCompressionUtils(createNodeCompression());
  });

  describe("createNodeCompression", () => {
    it("should return a valid CompressionUtils object", () => {
      const compression = createNodeCompression();
      expect(compression.deflate).toBeDefined();
      expect(compression.inflate).toBeDefined();
      expect(compression.compressBlock).toBeDefined();
      expect(compression.decompressBlock).toBeDefined();
      // Partial decompression stays on the portable one-pass inflater.
      expect(compression.decompressBlockPartial).toBeUndefined();
    });

    it("keeps exact partial decompression after registration", async () => {
      setCompressionUtils(createNodeCompression());
      const data = new TextEncoder().encode("hello ".repeat(100));
      const z = new Uint8Array(deflateSync(data));
      const withNext = new Uint8Array([...z, 1, 2, 3]);
      const r = await decompressBlockPartial(withNext);
      expect(r.bytesRead).toBe(z.length);
      expect(new TextDecoder().decode(r.data)).toBe("hello ".repeat(100));
    });
  });

  describe("block compression", () => {
    it("should compress and decompress data", async () => {
      const data = new TextEncoder().encode("Hello, World!");
      const compressed = await compressBlock(data);
      const decompressed = await decompressBlock(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe("Hello, World!");
    });

    it("should compress and decompress with raw mode", async () => {
      const data = new TextEncoder().encode("Hello, World!");
      const compressed = await compressBlock(data, { raw: true });
      const decompressed = await decompressBlock(compressed, { raw: true });
      expect(new TextDecoder().decode(decompressed)).toBe("Hello, World!");
    });
  });

  describe("streaming compression", () => {
    it("should compress and decompress a stream", async () => {
      const data = new TextEncoder().encode("Hello, World!");

      async function* inputStream() {
        yield data;
      }

      const compressed = await collect(deflate(inputStream()));
      const decompressed = await collect(
        inflate(
          (async function* () {
            yield compressed;
          })(),
        ),
      );

      expect(new TextDecoder().decode(decompressed)).toBe("Hello, World!");
    });
  });

  describe("direct function usage", () => {
    it("should work with deflateNode and inflateNode directly", async () => {
      const data = new TextEncoder().encode("Direct function test");

      async function* inputStream() {
        yield data;
      }

      const compressed = await collect(deflateNode(inputStream()));
      const decompressed = await collect(
        inflateNode(
          (async function* () {
            yield compressed;
          })(),
        ),
      );

      expect(new TextDecoder().decode(decompressed)).toBe("Direct function test");
    });
  });
});
