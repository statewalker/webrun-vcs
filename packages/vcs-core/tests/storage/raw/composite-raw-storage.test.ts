import { beforeEach, describe, expect, it } from "vitest";
import { CompositeRawStorage } from "../../../src/storage/raw/composite-raw-storage.js";
import { MemoryRawStorage } from "../../../src/storage/raw/memory-raw-storage.js";

async function collectBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function* toAsync(data: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const d of data) yield d;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("CompositeRawStorage", () => {
  let primary: MemoryRawStorage;
  let fallback1: MemoryRawStorage;
  let fallback2: MemoryRawStorage;
  let composite: CompositeRawStorage;

  beforeEach(() => {
    primary = new MemoryRawStorage();
    fallback1 = new MemoryRawStorage();
    fallback2 = new MemoryRawStorage();
    composite = new CompositeRawStorage(primary, [fallback1, fallback2]);
  });

  it("writes to primary storage", async () => {
    await composite.store("key1", toAsync([enc.encode("hello")]));
    expect(await primary.has("key1")).toBe(true);
    expect(await fallback1.has("key1")).toBe(false);
  });

  it("reads from primary storage", async () => {
    await primary.store("key1", toAsync([enc.encode("from-primary")]));
    const data = await collectBytes(composite.load("key1"));
    expect(dec.decode(data)).toBe("from-primary");
  });

  it("falls back to first fallback when not in primary", async () => {
    await fallback1.store("key2", toAsync([enc.encode("from-fallback1")]));
    const data = await collectBytes(composite.load("key2"));
    expect(dec.decode(data)).toBe("from-fallback1");
  });

  it("falls back to second fallback when not in primary or first", async () => {
    await fallback2.store("key3", toAsync([enc.encode("from-fallback2")]));
    const data = await collectBytes(composite.load("key3"));
    expect(dec.decode(data)).toBe("from-fallback2");
  });

  it("prefers primary over fallback", async () => {
    await primary.store("dup", toAsync([enc.encode("primary-val")]));
    await fallback1.store("dup", toAsync([enc.encode("fallback-val")]));
    const data = await collectBytes(composite.load("dup"));
    expect(dec.decode(data)).toBe("primary-val");
  });

  it("throws when key not found anywhere", async () => {
    await expect(async () => {
      for await (const _ of composite.load("missing")) {
        // consume
      }
    }).rejects.toThrow("Key not found: missing");
  });

  it("has() checks primary and fallbacks", async () => {
    await primary.store("p", toAsync([enc.encode("a")]));
    await fallback1.store("f1", toAsync([enc.encode("b")]));
    await fallback2.store("f2", toAsync([enc.encode("c")]));

    expect(await composite.has("p")).toBe(true);
    expect(await composite.has("f1")).toBe(true);
    expect(await composite.has("f2")).toBe(true);
    expect(await composite.has("missing")).toBe(false);
  });

  it("remove() only affects primary", async () => {
    await primary.store("key1", toAsync([enc.encode("val")]));
    await fallback1.store("key1", toAsync([enc.encode("val")]));

    expect(await composite.remove("key1")).toBe(true);
    expect(await primary.has("key1")).toBe(false);
    expect(await fallback1.has("key1")).toBe(true);
  });

  it("keys() deduplicates across storages", async () => {
    await primary.store("a", toAsync([enc.encode("1")]));
    await primary.store("b", toAsync([enc.encode("2")]));
    await fallback1.store("b", toAsync([enc.encode("3")])); // duplicate
    await fallback1.store("c", toAsync([enc.encode("4")]));
    await fallback2.store("d", toAsync([enc.encode("5")]));

    const keys: string[] = [];
    for await (const key of composite.keys()) keys.push(key);
    expect(keys.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("size() returns size from primary", async () => {
    await primary.store("key1", toAsync([enc.encode("hello!")]));
    expect(await composite.size("key1")).toBe(6);
  });

  it("size() falls back when not in primary", async () => {
    await fallback1.store("key1", toAsync([enc.encode("world")]));
    expect(await composite.size("key1")).toBe(5);
  });

  it("size() returns -1 for missing key", async () => {
    expect(await composite.size("missing")).toBe(-1);
  });
});
