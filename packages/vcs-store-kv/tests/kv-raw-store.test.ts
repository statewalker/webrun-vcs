/**
 * KvRawStore against the shared RawStorage contract: values are cut into
 * chunks, written as they arrive, renamed with `move`, and values written in
 * the old single-value format still read.
 */
import { createRawStorageTests } from "@statewalker/vcs-testing";
import { describe, expect, it } from "vitest";
import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KvRawStore } from "../src/binary-storage/kv-raw-store.js";

/** A KV store counting the bytes of every value written. */
function countingKv(): { kv: MemoryKVAdapter; written: () => number } {
  const kv = new MemoryKVAdapter();
  let written = 0;
  const set = kv.set.bind(kv);
  const setMany = kv.setMany.bind(kv);
  kv.set = (key, value) => {
    written += value.length;
    return set(key, value);
  };
  kv.setMany = (entries) => {
    for (const v of entries.values()) written += v.length;
    return setMany(entries);
  };
  return { kv, written: () => written };
}

createRawStorageTests("KvRawStore", async () => {
  const { kv, written } = countingKv();
  return { rawStorage: new KvRawStore(kv, "test"), supportsMove: true, persistedBytes: written };
});

describe("KvRawStore old single-value format", () => {
  it("reads, sizes, lists and removes a value written as one KV entry", async () => {
    const kv = new MemoryKVAdapter();
    const old = new TextEncoder().encode("written by an older version");
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, old.length, true);
    await kv.set("test:raw:k", old);
    await kv.set("test:size:k", size);
    const store = new KvRawStore(kv, "test");
    expect(await store.has("k")).toBe(true);
    expect(await store.size("k")).toBe(old.length);
    const parts: number[] = [];
    for await (const c of store.load("k", { start: 8 })) parts.push(...c);
    expect(new TextDecoder().decode(Uint8Array.from(parts))).toBe("by an older version");
    const keys: string[] = [];
    for await (const k of store.keys()) keys.push(k);
    expect(keys).toEqual(["k"]);
    expect(await store.remove("k")).toBe(true);
    expect(await kv.has("test:size:k")).toBe(false);
  });

  it("cuts large values into chunks of the configured size", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    await store.store(
      "big",
      (async function* () {
        yield new Uint8Array(4000).fill(1);
      })(),
    );
    const chunkKeys: string[] = [];
    for await (const k of kv.list("test:chunk:")) chunkKeys.push(k);
    expect(chunkKeys.length).toBe(4);
    expect(await store.size("big")).toBe(4000);
  });
});
