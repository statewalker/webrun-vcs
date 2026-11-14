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

describe("deflateNode: early stop, stalled sources and source errors", () => {
  type Source = AsyncIterable<Uint8Array>;
  const within = <T>(p: Promise<T>, ms = 2000) =>
    Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

  function endless() {
    const state = { closed: false };
    const source: Source = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: crypto.getRandomValues(new Uint8Array(64 * 1024)) };
          },
          async return() {
            state.closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    return { source, state };
  }

  it("closes the source when the consumer stops early", async () => {
    const { source, state } = endless();
    const run = (async () => {
      for await (const _ of deflateNode(source)) break;
      return "done";
    })();
    expect(await within(run)).toBe("done");
    expect(state.closed).toBe(true);
  });

  it("rethrows the source's own error unchanged, without hanging", async () => {
    class SourceError extends Error {}
    async function* failing(): Source {
      yield new Uint8Array(10);
      throw new SourceError("source failed");
    }
    const run = collect(deflateNode(failing())).then(
      () => "resolved",
      (e) => e,
    );
    expect(await within(run)).toBeInstanceOf(SourceError);
  });

  it("an early stop does not wait for a stalled source", async () => {
    let closed = false;
    let n = 0;
    const source: Source = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            n++ === 0
              ? Promise.resolve({ done: false, value: new Uint8Array(200_000).fill(7) })
              : new Promise<IteratorResult<Uint8Array>>(() => {}),
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const it = deflateNode(source)[Symbol.asyncIterator]();
    const run = (async () => {
      await it.next();
      await it.return?.();
      return "stopped";
    })();
    expect(await within(run)).toBe("stopped");
    expect(closed).toBe(true);
  });

  it("still round-trips large input", async () => {
    const data = new Uint8Array(300_000);
    for (let i = 0; i < data.length; i += 65_536)
      crypto.getRandomValues(data.subarray(i, i + 65_536));
    async function* src(): Source {
      for (let i = 0; i < data.length; i += 10_000) yield data.subarray(i, i + 10_000);
    }
    const out = await collect(inflateNode(deflateNode(src())));
    expect(out).toEqual(data);
  });
});
