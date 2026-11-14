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

/** A KV that holds back one chosen read or write of a reflog key until released. */
class StallingKV extends MemoryKVAdapter {
  stall: ((key: string) => boolean) | undefined;
  private release: (() => void) | undefined;
  private onStall: () => void = () => {};
  stalled = new Promise<void>((resolve) => {
    this.onStall = resolve;
  });
  override async get(key: string): Promise<Uint8Array | undefined> {
    if (this.stall?.(key)) {
      this.stall = undefined;
      await new Promise<void>((resolve) => {
        this.release = resolve;
        this.onStall();
      });
    }
    return super.get(key);
  }
  resume(): void {
    this.release?.();
  }
}

const IDENT = "A U Thor <a@example.com> 1700000000 +0000";
const lines = async (refs: KVRefStore, name: string) =>
  ((await (await refs.getReflog(name))?.getReverseEntries()) ?? [])
    .reverse()
    .map((e) => `${e.oldId.slice(-1)}>${e.newId.slice(-1)} ${e.comment}`);

describe("KVRefStore reflogs under concurrent batches", () => {
  it("keeps lines in the order the batches committed, whichever writes its line first", async () => {
    const kv = new StallingKV();
    const refs = new KVRefStore(kv);
    await refs.batch([{ name: "refs/heads/main", new: oid(1) }], { ident: IDENT, message: "init" });
    kv.stall = (key) => key === "reflog:refs/heads/main";
    const a = refs.batch([{ name: "refs/heads/main", old: oid(1), new: oid(2) }], {
      ident: IDENT,
      message: "A",
    });
    await kv.stalled; // A committed; its line is held back
    await refs.batch([{ name: "refs/heads/main", old: oid(2), new: oid(3) }], {
      ident: IDENT,
      message: "B",
    });
    kv.resume();
    await a;
    expect(await lines(refs, "refs/heads/main")).toEqual(["0>1 init", "1>2 A", "2>3 B"]);
    expect((await (await refs.getReflog("refs/heads/main"))?.getLastEntry())?.newId).toBe(oid(3));
  });

  it("a late drop of a deleted ref keeps the log of the ref created after it", async () => {
    const kv = new StallingKV();
    const refs = new KVRefStore(kv);
    await refs.batch([{ name: "refs/heads/b", new: oid(1) }], { ident: IDENT, message: "one" });
    kv.stall = (key) => key === "reflog:refs/heads/b";
    const d = refs.batch([{ name: "refs/heads/b", old: oid(1), new: null }], {
      ident: IDENT,
      message: "delete",
    });
    await kv.stalled; // the delete committed; dropping its log is held back
    await refs.batch([{ name: "refs/heads/b", old: null, new: oid(2) }], {
      ident: IDENT,
      message: "two",
    });
    kv.resume();
    await d;
    expect((await refs.resolve("refs/heads/b"))?.objectId).toBe(oid(2));
    expect(await lines(refs, "refs/heads/b")).toEqual(["0>2 two"]);
  });

  it("a broken log value skips that log only; the batch and other logs are written", async () => {
    const kv = new MemoryKVAdapter();
    const refs = new KVRefStore(kv);
    await refs.setSymbolic("HEAD", "refs/heads/main");
    await kv.set("reflog:refs/heads/main", new TextEncoder().encode("not json"));
    const r = await refs.batch([{ name: "HEAD", new: oid(1) }], { ident: IDENT, message: "x" });
    expect(r.ok).toBe(true);
    expect((await refs.resolve("HEAD"))?.objectId).toBe(oid(1));
    expect(await lines(refs, "HEAD")).toEqual(["0>1 x"]);
  });
});
