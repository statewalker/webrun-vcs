import { describe, expect, it } from "vitest";
import { CorruptRefRootError, KVRefStore, MemoryKVAdapter } from "../src/index.js";

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
    const kv = new RacingKV(async () => {
      // Another process writes the root directly with its own store.
      await new KVRefStore(kv).set("refs/heads/other", oid(9));
    });
    const refs = new KVRefStore(kv);
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
    const r = await refs.batch([{ name: "refs/heads/a", old: oid(1), new: oid(2) }]);
    expect(r).toEqual({ ok: false, rejected: [{ name: "refs/heads/a", reason: "mismatch" }] });
    expect((await refs.resolve("refs/heads/a"))?.objectId).toBe(oid(5));
  });
});

/** A KV whose compare-and-swap always loses, and counts its calls. */
class AlwaysLosingKV extends MemoryKVAdapter {
  casCalls = 0;
  override async compareAndSwap(): Promise<boolean> {
    this.casCalls++;
    return false;
  }
}

describe("KVRefStore limits and guards", () => {
  it("gives up after 100 lost races: a batch reports locked, set throws", async () => {
    const kv = new AlwaysLosingKV();
    const refs = new KVRefStore(kv);
    const r = await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
    expect(r).toEqual({ ok: false, rejected: [{ name: "refs/heads/a", reason: "locked" }] });
    expect(kv.casCalls).toBe(100);
    await expect(refs.set("refs/heads/a", oid(1))).rejects.toThrow(/concurrent writers/);
  }, 20_000);

  it("removing a missing ref writes nothing", async () => {
    const kv = new AlwaysLosingKV();
    expect(await new KVRefStore(kv).remove("refs/heads/none")).toBe(false);
    expect(kv.casCalls).toBe(0);
  });

  it("refuses a corrupt root and never overwrites it", async () => {
    const enc = new TextEncoder();
    for (const bad of ["{not json", "null", "[]", '"str"', '{"refs/heads/a":5}']) {
      const kv = new MemoryKVAdapter();
      await kv.set("ref:root", enc.encode(bad));
      const refs = new KVRefStore(kv);
      await expect(refs.get("refs/heads/a"), bad).rejects.toThrow(CorruptRefRootError);
      await expect(refs.batch([{ name: "refs/heads/b", new: oid(1) }]), bad).rejects.toThrow(
        CorruptRefRootError,
      );
      expect(new TextDecoder().decode(await kv.get("ref:root"))).toBe(bad);
    }
  });

  it("refuses a store in the old one-key-per-ref layout instead of showing it empty", async () => {
    const kv = new MemoryKVAdapter();
    await kv.set("ref:refs/heads/main", new TextEncoder().encode(JSON.stringify({ oid: oid(1) })));
    const refs = new KVRefStore(kv);
    await expect(refs.get("refs/heads/main")).rejects.toThrow(/old one-key-per-ref layout/);
    await expect(refs.batch([{ name: "refs/heads/main", old: null, new: oid(2) }])).rejects.toThrow(
      /old one-key-per-ref layout/,
    );
  });

  it("keeps a decoded root consistent when another store writes (no stale cache)", async () => {
    const kv = new MemoryKVAdapter();
    const a = new KVRefStore(kv);
    const b = new KVRefStore(kv);
    await a.set("refs/heads/x", oid(1));
    expect((await a.resolve("refs/heads/x"))?.objectId).toBe(oid(1));
    await b.set("refs/heads/x", oid(2));
    expect((await a.resolve("refs/heads/x"))?.objectId).toBe(oid(2));
  });
});
