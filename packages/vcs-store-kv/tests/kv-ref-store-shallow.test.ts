/**
 * The shallow commits (git's `shallow` file) in the KV ref store: kept sorted and unique,
 * and replaced with the `expected` check of the other stores (memory, files, SQL), so a
 * concurrent fetch's boundary is not overwritten.
 */

import { describe, expect, it } from "vitest";

import { MemoryKVAdapter } from "../src/adapters/memory-adapter.js";
import { KVRefStore } from "../src/kv-ref-store.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");

describe("KVRefStore shallow commits", () => {
  it("starts complete, stores sorted unique ids, and empties again", async () => {
    const kv = new MemoryKVAdapter();
    const refs = new KVRefStore(kv);
    expect(await refs.getShallow()).toEqual([]);

    await refs.setShallow([oid(2), oid(1), oid(2)]);
    expect(await refs.getShallow()).toEqual([oid(1), oid(2)]);
    // another instance over the same store sees them
    expect(await new KVRefStore(kv).getShallow()).toEqual([oid(1), oid(2)]);

    await refs.setShallow([]);
    expect(await refs.getShallow()).toEqual([]);
  });

  it("keeps them under a prefixed key, as the store's other keys", async () => {
    const kv = new MemoryKVAdapter();
    await new KVRefStore(kv).setShallow([oid(1)]);
    const keys: string[] = [];
    for await (const key of kv.list("shallow:")) keys.push(key);
    expect(keys).toEqual(["shallow:root"]);
  });

  it("refuses a write whose expected list is no longer current", async () => {
    const kv = new MemoryKVAdapter();
    const a = new KVRefStore(kv);
    const b = new KVRefStore(kv);
    await a.setShallow([oid(1)]);
    const read = await a.getShallow();

    await b.setShallow([oid(3)], read);
    await expect(a.setShallow([oid(2)], read)).rejects.toThrow(
      "shallow file has changed since we read it",
    );
    expect(await a.getShallow()).toEqual([oid(3)]);
    // order and duplicates of `expected` do not matter
    await a.setShallow([oid(4)], [oid(3), oid(3)]);
    expect(await b.getShallow()).toEqual([oid(4)]);
  });

  it("leaves the refs alone", async () => {
    const refs = new KVRefStore(new MemoryKVAdapter());
    await refs.set("refs/heads/main", oid(9));
    await refs.setShallow([oid(9)]);
    expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(9));
    const names: string[] = [];
    for await (const ref of refs.list()) names.push(ref.name);
    expect(names).toEqual(["refs/heads/main"]);
  });
});
