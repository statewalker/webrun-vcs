/**
 * P4.36: the object kernel hashes content it holds and skips the write of an object the store
 * already has (git's odb_freshen_object before writing), on every backend built on
 * `rawStorageStaging` (memory, KV, SQL) as on the files backend.
 */
import { describe, expect, it } from "vitest";
import {
  createGitObjects,
  MemoryRawStorage,
  rawStorageStaging,
  type StagingBlobStore,
} from "../../../src/index.js";

const enc = new TextEncoder();

/** A memory raw store that records its calls. */
function opsRaw() {
  const raw = new MemoryRawStorage();
  const ops: string[] = [];
  for (const name of ["has", "store", "move", "remove"] as const) {
    const original = (raw[name] as (...a: unknown[]) => unknown).bind(raw);
    (raw as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      ops.push(name);
      return original(...args);
    };
  }
  return { raw, ops };
}

describe("P4.36: writes of stored objects are skipped (rawStorageStaging)", () => {
  it("a stored object put again costs one lookup and no store", async () => {
    const { raw, ops } = opsRaw();
    const objects = createGitObjects(rawStorageStaging(raw));
    const bytes = enc.encode("hello\n");
    const id = await objects.put("blob", bytes.length, [bytes]);
    expect(id).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // a new object: one lookup (isFresh), then the store, without a second lookup
    expect(ops).toEqual(["has", "store"]);
    ops.length = 0;
    expect(await objects.put("blob", bytes.length, [bytes])).toBe(id);
    expect(ops).toEqual(["has"]);
  });

  it("putRaw of a stored object does not read its source", async () => {
    const { raw, ops } = opsRaw();
    const objects = createGitObjects(rawStorageStaging(raw));
    const bytes = enc.encode("hello\n");
    const id = await objects.put("blob", bytes.length, [bytes]);
    ops.length = 0;
    let read = false;
    let closed = false;
    await objects.putRaw(id, {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            read = true;
            return { done: true, value: undefined };
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    });
    expect(read).toBe(false);
    expect(closed).toBe(true);
    expect(ops).toEqual(["has"]);
  });

  it("putRaw of a new object still checks its id", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const raw = [enc.encode("blob 6\0hello\n")];
    await expect(objects.putRaw("0".repeat(40), raw)).rejects.toThrow(/hashes to/);
    await objects.putRaw("ce013625030ba8dba906f756967f9e9ca394464a", raw);
    expect(await objects.has("ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
  });

  it("a store without isFresh is written as before", async () => {
    const inner = rawStorageStaging(new MemoryRawStorage());
    let staged = 0;
    const store: StagingBlobStore = {
      putStaged: (bytes, idOf, o) => {
        staged++;
        return inner.putStaged(bytes, idOf, o);
      },
      get: (id) => inner.get(id),
      has: (id) => inner.has(id),
      remove: (id) => inner.remove(id),
      list: () => inner.list(),
    };
    const objects = createGitObjects(store);
    const bytes = enc.encode("hello\n");
    await objects.put("blob", bytes.length, [bytes]);
    await objects.put("blob", bytes.length, [bytes]);
    expect(staged).toBe(2);
    expect((await objects.get("ce013625030ba8dba906f756967f9e9ca394464a"))?.size).toBe(6);
  });

  it("concurrent puts of one object store it once", async () => {
    const { raw } = opsRaw();
    const objects = createGitObjects(rawStorageStaging(raw));
    const bytes = enc.encode("raced\n");
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => objects.put("blob", bytes.length, [bytes])),
    );
    expect(new Set(ids).size).toBe(1);
    const keys: string[] = [];
    for await (const k of raw.keys()) keys.push(k);
    expect(keys).toEqual([ids[0]]);
    expect((await objects.get(ids[0] as string, { verify: true }))?.size).toBe(bytes.length);
  });
});
