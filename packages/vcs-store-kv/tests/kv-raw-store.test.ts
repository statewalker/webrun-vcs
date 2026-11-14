/**
 * KvRawStore against the shared RawStorage contract: values are cut into
 * chunks, written as they arrive, renamed with `move`, and values written in
 * the old single-value format still read.
 */
import { rawStorageStaging } from "@statewalker/vcs-core";
import { createRawStorageTests } from "@statewalker/vcs-testing";
import { timestampedId } from "@statewalker/vcs-utils";
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

describe("KvRawStore.sweepStale", () => {
  const bytes = (n: number, fill = 1) =>
    (async function* () {
      yield new Uint8Array(n).fill(fill);
    })();

  async function chunkKeys(kv: MemoryKVAdapter): Promise<string[]> {
    const out: string[] = [];
    for await (const k of kv.list("test:chunk:")) out.push(k);
    return out.sort();
  }

  it("removes chunks no manifest references once older than the expiry", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    await store.store("kept", bytes(3000));
    const kept = await chunkKeys(kv);
    // a write that crashed before its manifest, two days ago, and one that crashed just now
    const old = timestampedId(Date.now() - 2 * 24 * 3600_000);
    const fresh = timestampedId();
    for (const t of [old, fresh]) {
      await kv.set(`test:chunk:${t}:0`, new Uint8Array(1024));
      await kv.set(`test:chunk:${t}:1`, new Uint8Array(1024));
    }
    expect(await store.sweepStale({ olderThanMs: 24 * 3600_000 })).toBe(1); // one leftover write
    expect(await chunkKeys(kv)).toEqual(
      [...kept, `test:chunk:${fresh}:0`, `test:chunk:${fresh}:1`].sort(),
    );
    expect(await store.size("kept")).toBe(3000);
  });

  it("removes orphans of unknown age only with olderThanMs 0", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    await kv.set("test:chunk:3f2b8c1e-0d4a-4e8b-9c6f-2a1b3c4d5e6f:0", new Uint8Array(4));
    expect(await store.sweepStale({ olderThanMs: 3600_000 })).toBe(0);
    expect(await store.sweepStale({ olderThanMs: 0 })).toBe(1);
    expect(await chunkKeys(kv)).toEqual([]);
  });

  it("never removes the chunks of a write in progress", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writing = store.store(
      "big",
      (async function* () {
        yield new Uint8Array(3000).fill(7);
        await gate;
        yield new Uint8Array(3000).fill(8);
      })(),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect((await chunkKeys(kv)).length).toBeGreaterThan(0);
    expect(await store.sweepStale({ olderThanMs: 0 })).toBe(0);
    release();
    await writing;
    expect(await store.size("big")).toBe(6000);
    let n = 0;
    for await (const c of store.load("big")) n += c.length;
    expect(n).toBe(6000);
  });

  it("makes the chunks leaked by two concurrent stores of one key sweepable", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    await Promise.all([store.store("k", bytes(3000, 1)), store.store("k", bytes(3000, 2))]);
    await store.sweepStale({ olderThanMs: 0 });
    // only the chunks of the manifest that won remain
    expect((await chunkKeys(kv)).length).toBe(3);
    let n = 0;
    for await (const c of store.load("k")) n += c.length;
    expect(n).toBe(3000);
  });
});

describe("KvRawStore holding git objects (same id twice)", () => {
  const big = (fill: number) =>
    (async function* () {
      for (let i = 0; i < 4; i++) yield new Uint8Array(100 * 1024).fill(fill);
    })();

  it("keeps the stored value: a reader of it never loses its chunks", async () => {
    const kv = new MemoryKVAdapter();
    const raw = new KvRawStore(kv, "test", { chunkSize: 64 * 1024 });
    const staging = rawStorageStaging(raw);
    expect(await staging.putStaged(big(1), () => "id")).toEqual({ id: "id", stored: true });
    const chunksBefore: string[] = [];
    for await (const k of kv.list("test:chunk:")) chunksBefore.push(k);

    const reader = raw.load("id")[Symbol.asyncIterator]();
    await reader.next(); // the reader holds the manifest
    expect(await staging.putStaged(big(1), () => "id")).toEqual({ id: "id", stored: false });
    let rest = 64 * 1024;
    for (let r = await reader.next(); !r.done; r = await reader.next()) rest += r.value.length;
    expect(rest).toBe(400 * 1024);

    const chunksAfter: string[] = [];
    for await (const k of kv.list("test:chunk:")) chunksAfter.push(k);
    expect(chunksAfter.sort()).toEqual(chunksBefore.sort());
  });

  it("writes nothing for a duplicate small object", async () => {
    const kv = new MemoryKVAdapter();
    const raw = new KvRawStore(kv, "test");
    const staging = rawStorageStaging(raw);
    await staging.putStaged(big(1), () => "x"); // warm up
    const small = () =>
      (async function* () {
        yield new Uint8Array(200);
      })();
    await staging.putStaged(small(), () => "s");
    let writes = 0;
    const set = kv.set.bind(kv);
    const setMany = kv.setMany.bind(kv);
    kv.set = (k, v) => {
      writes++;
      return set(k, v);
    };
    kv.setMany = (e) => {
      writes++;
      return setMany(e);
    };
    expect(await staging.putStaged(small(), () => "s")).toEqual({ id: "s", stored: false });
    expect(writes).toBe(0);
  });
});

describe("KvRawStore.sweepStale racing a move", () => {
  it("with olderThanMs 0 removes nothing when a move runs during its manifest scan", async () => {
    const kv = new MemoryKVAdapter();
    const store = new KvRawStore(kv, "test", { chunkSize: 1024 });
    const big = (fill: number) =>
      (async function* () {
        yield new Uint8Array(3000).fill(fill);
      })();
    await store.store("id", big(1)); // manifest:id first in the listing
    await store.store("tmp2", big(2)); // a staged write, not in flight any more
    const list = kv.list.bind(kv);
    let moved = false;
    kv.list = (prefix: string) =>
      (async function* () {
        for await (const key of list(prefix)) {
          yield key;
          if (!moved && prefix.includes("manifest")) {
            moved = true; // the staged value is published while the scan is past manifest:id
            await store.move("tmp2", "id");
          }
        }
      })();
    await store.sweepStale({ olderThanMs: 0 });
    let n = 0;
    let last = 0;
    for await (const c of store.load("id")) {
      n += c.length;
      last = c[c.length - 1] as number;
    }
    expect(n).toBe(3000);
    expect(last).toBe(2);
  });
});
