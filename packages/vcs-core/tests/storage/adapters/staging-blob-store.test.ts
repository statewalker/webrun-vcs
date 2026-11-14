/**
 * rawStorageStaging streams through `RawStorage.move` when the raw store has it,
 * and spools content of unknown size to a temporary key.
 */
import { describe, expect, it } from "vitest";
import {
  createGitObjects,
  MemoryRawStorage,
  type RawStorage,
  rawStorageStaging,
} from "../../../src/index.js";

async function keysOf(raw: RawStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const k of raw.keys()) keys.push(k);
  return keys.sort();
}

async function bytesOf(s: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const c of s) out.push(...c);
  return out;
}

/** A raw store that records how many bytes `store` had received when each chunk was produced. */
function countingRaw(): { raw: MemoryRawStorage; received: () => number } {
  const raw = new MemoryRawStorage();
  let received = 0;
  const store = raw.store.bind(raw);
  raw.store = (key, content) =>
    store(
      key,
      (async function* () {
        for await (const c of content) {
          received += c.length;
          yield c;
        }
      })(),
    );
  return { raw, received: () => received };
}

describe("rawStorageStaging", () => {
  it("streams the staged bytes into the raw store as they come when it can move", async () => {
    const { raw, received } = countingRaw();
    const store = rawStorageStaging(raw);
    let maxLag = 0;
    let produced = 0;
    async function* bytes() {
      for (let i = 0; i < 64; i++) {
        maxLag = Math.max(maxLag, produced - received());
        produced += 1024;
        yield new Uint8Array(1024).fill(i);
      }
    }
    const r = await store.putStaged(bytes(), () => "k1");
    expect(r).toEqual({ id: "k1", stored: true });
    expect(maxLag).toBeLessThanOrEqual(2048);
    expect(await keysOf(raw)).toEqual(["k1"]);
    expect((await bytesOf(raw.load("k1"))).length).toBe(64 * 1024);
  });

  it("removes the temporary when the stream or the id fails, and keeps an existing value", async () => {
    const raw = new MemoryRawStorage();
    const store = rawStorageStaging(raw);
    await expect(
      store.putStaged(
        (async function* () {
          yield new Uint8Array([1]);
          throw new Error("boom");
        })(),
        () => "k",
      ),
    ).rejects.toThrow("boom");
    await expect(
      store.putStaged(
        (async function* () {
          yield new Uint8Array([1]);
        })(),
        () => {
          throw new Error("no id");
        },
      ),
    ).rejects.toThrow("no id");
    expect(await keysOf(raw)).toEqual([]);
    await store.putStaged(
      (async function* () {
        yield new Uint8Array([1]);
      })(),
      () => "k",
    );
    const again = await store.putStaged(
      (async function* () {
        yield new Uint8Array([1]);
      })(),
      () => "k",
    );
    expect(again).toEqual({ id: "k", stored: false });
    expect(await keysOf(raw)).toEqual(["k"]);
  });

  it("spools content to a temporary key and removes it on dispose", async () => {
    const raw = new MemoryRawStorage();
    const store = rawStorageStaging(raw);
    const spooled = await store.spool?.(
      (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    );
    expect(spooled?.size).toBe(3);
    expect(await bytesOf(spooled?.read() ?? (async function* () {})())).toEqual([1, 2, 3]);
    expect((await keysOf(raw)).length).toBe(1);
    await spooled?.dispose();
    expect(await keysOf(raw)).toEqual([]);
  });
});

describe("MemoryRawStorage.move", () => {
  it("renames a value, replacing the target", async () => {
    const raw = new MemoryRawStorage();
    await raw.store(
      "a",
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    );
    await raw.store(
      "b",
      (async function* () {
        yield new Uint8Array([2]);
      })(),
    );
    expect(await raw.move?.("a", "b")).toBe(true);
    expect(await raw.move?.("a", "c")).toBe(false);
    expect(await keysOf(raw)).toEqual(["b"]);
    expect(await bytesOf(raw.load("b"))).toEqual([1]);
  });
});

describe("GitObjects.putUnsized", () => {
  const enc = new TextEncoder();
  const HELLO = "ce013625030ba8dba906f756967f9e9ca394464a";

  it("keeps content under the threshold in memory and stores it under git's id", async () => {
    const store = rawStorageStaging(new MemoryRawStorage());
    let spools = 0;
    const spool = store.spool?.bind(store);
    store.spool = (c) => {
      spools++;
      return (spool as NonNullable<typeof spool>)(c);
    };
    const objects = createGitObjects(store, { spoolThreshold: 1024 });
    expect(await objects.putUnsized("blob", [enc.encode("hel"), enc.encode("lo\n")])).toBe(HELLO);
    expect(spools).toBe(0);
  });

  it("spools content above the threshold, then writes it in a second pass", async () => {
    const raw = new MemoryRawStorage();
    const store = rawStorageStaging(raw);
    let spooledBytes = 0;
    const spool = store.spool?.bind(store) as NonNullable<typeof store.spool>;
    store.spool = async (c) => {
      const s = await spool(c);
      spooledBytes = s.size;
      return s;
    };
    const objects = createGitObjects(store, { spoolThreshold: 4 });
    const id = await objects.putUnsized("blob", [enc.encode("hel"), enc.encode("lo\n")]);
    expect(id).toBe(HELLO);
    expect(spooledBytes).toBe(6);
    // the spool's temporary is gone; only the object is left
    expect(await keysOf(raw)).toEqual([HELLO]);
  });

  it("collects in memory when the store cannot spool", async () => {
    const { spool: _spool, ...plain } = rawStorageStaging(new MemoryRawStorage());
    const objects = createGitObjects(plain, { spoolThreshold: 2 });
    expect(await objects.putUnsized("blob", [enc.encode("hello\n")])).toBe(HELLO);
  });
});
