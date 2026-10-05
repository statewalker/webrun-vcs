/**
 * MemoryPackObjectCache tests
 */

import { describe, expect, it } from "vitest";
import { MemoryPackObjectCache } from "../../src/pack/memory-pack-object-cache.js";

function toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield data;
  })();
}

function toChunkedAsyncIterable(data: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < data.length; i += chunkSize) {
      yield data.subarray(i, Math.min(i + chunkSize, data.length));
    }
  })();
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

describe("MemoryPackObjectCache", () => {
  it("save and read back a single object", async () => {
    const cache = new MemoryPackObjectCache();
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    await cache.save("obj1", "blob", toAsyncIterable(data));

    expect(cache.getType("obj1")).toBe("blob");
    expect(cache.getSize("obj1")).toBe(5);

    const result = await collect(cache.read("obj1"));
    expect(result).toEqual(data);
  });

  it("save collects chunked async iterable into buffer", async () => {
    const cache = new MemoryPackObjectCache();
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

    await cache.save("obj1", "tree", toChunkedAsyncIterable(data, 3));

    expect(cache.getSize("obj1")).toBe(8);
    const result = await collect(cache.read("obj1"));
    expect(result).toEqual(data);
  });

  it("read with offset returns subarray from start", async () => {
    const cache = new MemoryPackObjectCache();
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

    await cache.save("obj1", "blob", toAsyncIterable(data));

    const result = await collect(cache.read("obj1", 3));
    expect(result).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
  });

  it("read with offset=0 returns full content", async () => {
    const cache = new MemoryPackObjectCache();
    const data = new Uint8Array([10, 20, 30]);

    await cache.save("obj1", "commit", toAsyncIterable(data));

    const result = await collect(cache.read("obj1", 0));
    expect(result).toEqual(data);
  });

  it("read with offset at size returns empty", async () => {
    const cache = new MemoryPackObjectCache();
    const data = new Uint8Array([1, 2, 3]);

    await cache.save("obj1", "blob", toAsyncIterable(data));

    const result = await collect(cache.read("obj1", 3));
    expect(result.length).toBe(0);
  });

  it("getType and getSize return undefined for missing keys", () => {
    const cache = new MemoryPackObjectCache();
    expect(cache.getType("missing")).toBeUndefined();
    expect(cache.getSize("missing")).toBeUndefined();
  });

  it("read throws for missing key", () => {
    const cache = new MemoryPackObjectCache();
    expect(() => cache.read("missing")).toThrow('key "missing" not found');
  });

  it("stores multiple objects independently", async () => {
    const cache = new MemoryPackObjectCache();
    const data1 = new Uint8Array([1, 2, 3]);
    const data2 = new Uint8Array([4, 5, 6, 7]);

    await cache.save("a", "blob", toAsyncIterable(data1));
    await cache.save("b", "tree", toAsyncIterable(data2));

    expect(cache.getType("a")).toBe("blob");
    expect(cache.getType("b")).toBe("tree");
    expect(cache.getSize("a")).toBe(3);
    expect(cache.getSize("b")).toBe(4);

    expect(await collect(cache.read("a"))).toEqual(data1);
    expect(await collect(cache.read("b"))).toEqual(data2);
  });

  it("dispose clears all objects", async () => {
    const cache = new MemoryPackObjectCache();
    await cache.save("obj1", "blob", toAsyncIterable(new Uint8Array([1])));
    await cache.save("obj2", "tree", toAsyncIterable(new Uint8Array([2])));

    await cache.dispose();

    expect(cache.getType("obj1")).toBeUndefined();
    expect(cache.getType("obj2")).toBeUndefined();
  });

  it("overwrite replaces existing object", async () => {
    const cache = new MemoryPackObjectCache();
    await cache.save("obj1", "blob", toAsyncIterable(new Uint8Array([1, 2])));
    await cache.save("obj1", "tree", toAsyncIterable(new Uint8Array([3, 4, 5])));

    expect(cache.getType("obj1")).toBe("tree");
    expect(cache.getSize("obj1")).toBe(3);
    expect(await collect(cache.read("obj1"))).toEqual(new Uint8Array([3, 4, 5]));
  });
});
