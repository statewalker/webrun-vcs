import { describe, expect, it } from "vitest";
import { KVRefStore, MemoryKVAdapter } from "../src/index.js";

const oid = (n: number) => n.toString(16).padStart(40, "a");

/** A KV whose first compare-and-swap loses to another writer that moves an unrelated ref. */
class RacingKV extends MemoryKVAdapter {
  raced = 0;
  constructor(private other: () => Promise<void>) {
    super();
  }
  override async compareAndSwap(
    key: string,
    expected: Uint8Array | undefined,
    newValue: Uint8Array,
  ): Promise<boolean> {
    if (this.raced === 0) {
      this.raced++;
      await this.other();
    }
    return super.compareAndSwap(key, expected, newValue);
  }
}

describe("KVRefStore under a concurrent writer", () => {
  it("re-reads and re-plans after a lost race, keeping the other writer's ref", async () => {
    let refs: KVRefStore | undefined;
    const kv = new RacingKV(async () => {
      // Another process writes the root directly with its own store.
      await new KVRefStore(kv).set("refs/heads/other", oid(9));
    });
    refs = new KVRefStore(kv);
    const r = await refs.batch([
      { name: "refs/heads/a", old: null, new: oid(1) },
      { name: "refs/heads/b", old: null, new: oid(2) },
    ]);
    expect(r).toEqual({ ok: true, rejected: [] });
    expect(kv.raced).toBe(1);
    const names: string[] = [];
    for await (const ref of refs.list("refs/")) names.push(ref.name);
    expect(names).toEqual(["refs/heads/a", "refs/heads/b", "refs/heads/other"]);
  });

  it("re-checks old values after a lost race", async () => {
    const kv = new RacingKV(async () => {
      await new KVRefStore(kv).set("refs/heads/a", oid(5));
    });
    const refs = new KVRefStore(kv);
    await kv.set("ref:root", new TextEncoder().encode(JSON.stringify({ "refs/heads/a": oid(1) })));
    kv.raced = 0;
    const r = await refs.batch([{ name: "refs/heads/a", old: oid(1), new: oid(2) }]);
    expect(r).toEqual({ ok: false, rejected: [{ name: "refs/heads/a", reason: "mismatch" }] });
    expect((await refs.resolve("refs/heads/a"))?.objectId).toBe(oid(5));
  });
});
