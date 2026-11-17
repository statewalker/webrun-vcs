/**
 * The work the pack read path does, counted: which delta bases the base cache keeps and how
 * they are allocated (git's unpack_entry policy: the bases on the way are cached, the object
 * asked for is handed over), and which idx checks run when (git's check_packed_git_idx at
 * open, the rest as lookups use the idx, everything for verifyIndex). Corrupt idx files fail
 * with `PackError` when used, never with another object's bytes.
 */
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../src/common/files/index.js";
import {
  DeltaBaseCache,
  installPack,
  openPack,
  openPackSet,
  PackError,
  type PackFile,
  writePackIdx,
} from "../../src/pack/index.js";
import {
  buildPack,
  chunks,
  collect,
  copyAll,
  delta,
  type Entry,
  extend,
  oidOf,
} from "./pack-builder.js";

const enc = new TextEncoder();
const PACK_DIR = "/objects/pack";
const SLAB = 64 * 1024;

const text = (n: number, tag: string) =>
  enc.encode(Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join(""));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** A chain base -> v1 -> ... -> vN of OFS deltas (each appends a line), and every version. */
function chain(n: number, lines = 100) {
  const versions = [text(lines, "base")];
  const entries: Entry[] = [{ kind: 3, data: versions[0] as Uint8Array }];
  for (let i = 1; i <= n; i++) {
    const { data, d } = extend(versions[i - 1] as Uint8Array, `version ${i}\n`);
    versions.push(data);
    entries.push({ kind: 6, data: d, baseIdx: i - 1 });
  }
  return { versions, entries, ids: versions.map((v) => oidOf("blob", v)) };
}

async function install(files: FilesApi, entries: Entry[]) {
  const built = buildPack(entries);
  const r = await installPack(files, PACK_DIR, chunks(built.bytes));
  const base = `${PACK_DIR}/pack-${r.packId}`;
  return { packPath: `${base}.pack`, idxPath: `${base}.idx`, built, packId: r.packId };
}

describe("the delta base cache, as git's unpack_entry", () => {
  it("caches the bases on the way, carved from slabs, and hands the object asked for over", async () => {
    const files = createInMemoryFilesApi();
    const { versions, entries, ids } = chain(20);
    const { packPath, idxPath } = await install(files, entries);
    const cache = new DeltaBaseCache(96 * 2 ** 20);
    const pack = await openPack(files, packPath, idxPath, { baseCache: cache });

    const top = await pack.get(ids[20] as string);
    expect(same(top?.bytes as Uint8Array, versions[20] as Uint8Array)).toBe(true);
    expect(pack.stats.inflations).toBe(21); // the base and 20 deltas
    // the base and the 19 deltas below the top are cached; the top is not
    expect(cache.size).toBe(20);
    // no base got a buffer of its own: ~1.4 KiB each, carved from a single 64 KiB slab
    expect(cache.ownAllocations).toBe(0);
    expect(cache.slabsCreated).toBe(1);
    // the budget counts the slab, which is what the entries keep alive
    expect(cache.bytes).toBe(SLAB);
    expect(cache.bytes).toBe(cache.entriesBytes);
    // the caller's buffer is its own: changing it reaches no cached base
    top?.bytes?.fill(0);

    // the top again: one delta on its cached base
    const hits = cache.hits;
    const again = await pack.get(ids[20] as string);
    expect(same(again?.bytes as Uint8Array, versions[20] as Uint8Array)).toBe(true);
    expect(pack.stats.inflations).toBe(22);
    expect(cache.hits).toBe(hits + 1);

    // every base on the way is a cache hit, copied out (zeroing it changes nothing)
    for (let i = 0; i < 20; i++) {
      const o = await pack.get(ids[i] as string);
      expect(same(o?.bytes as Uint8Array, versions[i] as Uint8Array), `v${i}`).toBe(true);
      o?.bytes?.fill(0);
    }
    expect(pack.stats.inflations).toBe(22);
    expect(cache.hits).toBe(hits + 21);
    for (let i = 0; i <= 20; i++) {
      const o = await pack.get(ids[i] as string, { verify: true });
      expect(same(await collect(o?.content ?? []), versions[i] as Uint8Array)).toBe(true);
    }
  });

  it("allocates bases on their own under a small budget, within it", async () => {
    const files = createInMemoryFilesApi();
    const { versions, entries, ids } = chain(20);
    const { packPath, idxPath } = await install(files, entries);
    const cache = new DeltaBaseCache(256 * 1024);
    const pack = await openPack(files, packPath, idxPath, { baseCache: cache });
    const top = await pack.get(ids[20] as string);
    expect(same(top?.bytes as Uint8Array, versions[20] as Uint8Array)).toBe(true);
    expect(cache.slabsCreated).toBe(0);
    expect(cache.ownAllocations).toBe(20);
    expect(cache.bytes).toBe(cache.entriesBytes);
    expect(cache.peakBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("spreads checkpoints along a chain longer than the budget holds", async () => {
    const files = createInMemoryFilesApi();
    const { versions, entries, ids } = chain(30, 2000); // ~33 KiB objects
    const { packPath, idxPath } = await install(files, entries);
    const limit = 4 * (versions[30] as Uint8Array).length;
    const cache = new DeltaBaseCache(limit);
    const pack = await openPack(files, packPath, idxPath, { baseCache: cache });
    await pack.get(ids[30] as string);
    expect(pack.stats.inflations).toBe(31);
    // the whole base and every 8th step: 4 slots for 30 steps
    expect(cache.ownAllocations).toBeLessThanOrEqual(5);
    expect(cache.peakBytes).toBeLessThanOrEqual(limit);
    // a read into the chain stops at a checkpoint at most 7 steps below
    const before = pack.stats.inflations;
    expect(
      same((await pack.get(ids[25] as string))?.bytes as Uint8Array, versions[25] as Uint8Array),
    ).toBe(true);
    expect(pack.stats.inflations - before).toBeLessThanOrEqual(8);
  });

  it("keeps its slab accounting through hits and evictions (LRU)", () => {
    const cache = new DeltaBaseCache(16 * SLAB);
    const scope = cache.scope();
    const put = (offset: number, size: number) => {
      const data = cache.alloc(size);
      scope.put(offset, { type: "blob", data });
      return data;
    };
    // sixteen 4000-byte bases fill one slab; the 17th starts a second
    for (let i = 0; i < 17; i++) put(i, 4000);
    expect(cache.slabsCreated).toBe(2);
    expect(cache.bytes).toBe(2 * SLAB);
    expect(cache.bytes).toBe(cache.entriesBytes);
    // a base too large for a slab counts its own length
    put(100, 100_000);
    expect(cache.ownAllocations).toBe(1);
    expect(cache.bytes).toBe(2 * SLAB + 100_000);
    // fill past the budget: the least recently used go first, offset 0 kept by a hit
    for (let i = 17; i < 300; i++) {
      expect(scope.get(0)).toBeDefined();
      put(i, 4000);
      expect(cache.bytes).toBeLessThanOrEqual(16 * SLAB);
      expect(cache.bytes).toBe(cache.entriesBytes);
    }
    expect(scope.get(0)).toBeDefined();
    expect(scope.get(1)).toBeUndefined();
    expect(scope.get(100)).toBeUndefined();
    scope.drop();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });
});

describe("the idx at open and in use, as git's check_packed_git_idx", () => {
  it("open checks the header only; a lookup checks its bucket once; verifyIndex checks all", async () => {
    const files = createInMemoryFilesApi();
    const { entries, ids } = chain(5);
    const { packPath, idxPath } = await install(files, entries);
    const pack = await openPack(files, packPath, idxPath);
    expect(pack.stats.idxBucketsChecked).toBe(0);
    expect(pack.stats.idxVerified).toBe(false);
    const id = ids[3] as string;
    expect(pack.has(id)).toBe(true);
    expect(pack.stats.idxBucketsChecked).toBe(1);
    await pack.get(id);
    expect(pack.has(id)).toBe(true);
    expect(pack.stats.idxBucketsChecked).toBe(1);
    await pack.verifyIndex();
    expect(pack.stats.idxBucketsChecked).toBe(256);
    expect(pack.stats.idxVerified).toBe(true);

    const verified = await openPack(files, packPath, idxPath, { verifyIndex: true });
    expect(verified.stats.idxVerified).toBe(true);
    expect(verified.stats.idxBucketsChecked).toBe(256);
  });

  it("a pack set checks an idx it just installed whole, and one it finds only as used", async () => {
    const files = createInMemoryFilesApi();
    const { entries, ids } = chain(3);
    const set = await openPackSet(files, PACK_DIR);
    await set.install(chunks(buildPack(entries).bytes));
    const [installed] = (await set.packs()) as PackFile[];
    expect(installed?.stats.idxVerified).toBe(true);
    const scanned = await openPackSet(files, PACK_DIR);
    const [found] = (await scanned.packs()) as PackFile[];
    expect(found?.stats.idxVerified).toBe(false);
    expect(found?.stats.idxBucketsChecked).toBe(0);
    expect(await scanned.has(ids[1] as string)).toBe(true);
    expect(found?.stats.idxBucketsChecked).toBe(1);
  });
});

describe("a corrupt idx fails with PackError when used, never with wrong data", () => {
  /** A pack of `n` small blobs and its idx, written under fake ids `ids`. */
  async function rawPack(files: FilesApi, ids: string[]) {
    const entries: Entry[] = ids.map((_, i) => ({ kind: 3, data: enc.encode(`object ${i}\n`) }));
    const built = buildPack(entries);
    const checksum = built.bytes.subarray(built.bytes.length - 20);
    const packId = bytesToHex(checksum);
    const idx = writePackIdx(
      ids.map((id, i) => ({
        id,
        offset: built.offsets[i] as number,
        crc32: crc32(built.bytes.subarray(built.offsets[i], built.ends[i])),
      })),
      checksum,
    );
    const base = `${PACK_DIR}/pack-${packId}`;
    await files.write(`${base}.pack`, [built.bytes]);
    return { packPath: `${base}.pack`, idxPath: `${base}.idx`, idx, built };
  }
  const resum = (idx: Uint8Array) => {
    idx.set(
      createSha1()
        .update(idx.subarray(0, idx.length - 20))
        .digest(),
      idx.length - 20,
    );
    return idx;
  };
  const ID_AT = 8 + 1024;

  it("an id moved out of its fan-out bucket", async () => {
    const files = createInMemoryFilesApi();
    const ids = [`10${"1".repeat(38)}`, `20${"2".repeat(38)}`, `30${"3".repeat(38)}`];
    const { packPath, idxPath, idx } = await rawPack(files, ids);
    const bad = idx.slice();
    bad[ID_AT + 20] = 0x21; // the second id now starts with 21, inside bucket 20
    await files.write(idxPath, [resum(bad)]);
    const pack = await openPack(files, packPath, idxPath);
    // its own bucket is empty: not found
    expect(await pack.get(`21${"2".repeat(38)}`)).toBeUndefined();
    await expect(pack.get(`20${"2".repeat(38)}`)).rejects.toThrow(/outside its fan-out bucket/);
    // the other buckets are sound
    expect(new TextDecoder().decode((await pack.get(ids[0] as string))?.bytes)).toBe("object 0\n");
    await expect(pack.verifyIndex()).rejects.toBeInstanceOf(PackError);
  });

  it("refused at open: a fan-out going down, a length that does not fit the tables", async () => {
    const files = createInMemoryFilesApi();
    const ids = [`10${"1".repeat(38)}`, `20${"2".repeat(38)}`];
    const { packPath, idxPath, idx } = await rawPack(files, ids);
    const fanDown = idx.slice();
    new DataView(fanDown.buffer).setUint32(8 + 0x15 * 4, 5);
    const odd = new Uint8Array(idx.length + 4);
    odd.set(idx.subarray(0, idx.length - 40));
    odd.set(idx.subarray(idx.length - 40), idx.length - 36);
    for (const [bad, message] of [
      [fanDown, /fan-out not monotonic/],
      [odd, /does not match its tables/],
      [idx.subarray(0, idx.length - 1), /idx truncated/],
    ] as const) {
      await files.write(idxPath, [bad]);
      await expect(openPack(files, packPath, idxPath)).rejects.toThrow(message);
    }
  });

  it("an offset outside the pack", async () => {
    const files = createInMemoryFilesApi();
    const ids = [`10${"1".repeat(38)}`];
    const { packPath, idxPath, idx } = await rawPack(files, ids);
    const bad = idx.slice();
    new DataView(bad.buffer).setUint32(ID_AT + 20 + 4, 0x7000_0000);
    await files.write(idxPath, [resum(bad)]);
    const pack = await openPack(files, packPath, idxPath);
    await expect(pack.get(ids[0] as string)).rejects.toBeInstanceOf(PackError);
  });

  it("one bad large offset fails every read that needs an extent, each time", async () => {
    const files = createInMemoryFilesApi();
    const ids = [`10${"1".repeat(38)}`, `20${"2".repeat(38)}`];
    const { packPath, idxPath, idx } = await rawPack(files, ids);
    const bad = idx.slice();
    // the second entry's offset names entry 7 of a large-offset table that has none
    new DataView(bad.buffer).setUint32(ID_AT + 2 * 20 + 2 * 4 + 4, 0x8000_0007);
    await files.write(idxPath, [resum(bad)]);
    const pack = await openPack(files, packPath, idxPath);
    await expect(pack.get(ids[1] as string)).rejects.toThrow(/past the large-offset table/);
    // the first entry's own offset is sound, but its extent needs every offset
    for (let k = 0; k < 3; k++) {
      await expect(pack.entry(ids[0] as string)).rejects.toThrow(/past the large-offset table/);
    }
  });
});

describe("review of #130: the delta base cache admits an entry over its limit, as git's", () => {
  it("with a limit of 0, reading a chain upwards applies O(depth) deltas, not O(depth^2)", async () => {
    const files = createInMemoryFilesApi();
    const depth = 40;
    const { versions, entries, ids } = chain(depth);
    const { packPath, idxPath } = await install(files, entries);
    const cache = new DeltaBaseCache(0);
    const pack = await openPack(files, packPath, idxPath, { baseCache: cache });
    for (let i = 0; i <= depth; i++) {
      const o = await pack.get(ids[i] as string);
      expect(same(o?.bytes as Uint8Array, versions[i] as Uint8Array), `v${i}`).toBe(true);
      // the most recent base stays, alone
      expect(cache.size).toBeLessThanOrEqual(1);
    }
    // v0: 1; v1: base and delta, the base kept; then the delta below and the delta asked for
    expect(pack.stats.inflations).toBe(1 + 2 + 2 * (depth - 1));
    // without that base: 1 + 2 + ... + (depth + 1)
    expect(pack.stats.inflations).toBeLessThan(((depth + 1) * (depth + 2)) / 2);
  });

  it("keeps a single base over the limit alone; the next base evicts it", () => {
    const cache = new DeltaBaseCache(1000);
    const scope = cache.scope();
    scope.put(1, { type: "blob", data: cache.alloc(500) });
    scope.put(2, { type: "blob", data: cache.alloc(4000) });
    expect(cache.size).toBe(1);
    expect(scope.get(1)).toBeUndefined();
    expect(scope.get(2)?.data.length).toBe(4000);
    expect(cache.bytes).toBe(4000);
    expect(cache.bytes).toBe(cache.entriesBytes);
    scope.put(3, { type: "blob", data: cache.alloc(3000) });
    expect(cache.size).toBe(1);
    expect(scope.get(2)).toBeUndefined();
    expect(scope.get(3)?.data.length).toBe(3000);
    expect(cache.bytes).toBe(3000);
    // a small base then fits under the limit alone: the large one goes
    scope.put(4, { type: "blob", data: cache.alloc(200) });
    expect(scope.get(3)).toBeUndefined();
    expect(cache.bytes).toBe(200);
  });

  it("never hands the cached base to the caller, under a limit of 0", async () => {
    const files = createInMemoryFilesApi();
    const { versions, entries, ids } = chain(3);
    const { packPath, idxPath } = await install(files, entries);
    const cache = new DeltaBaseCache(0);
    const pack = await openPack(files, packPath, idxPath, { baseCache: cache });
    await pack.get(ids[2] as string); // v1 is cached
    const hit = await pack.get(ids[1] as string);
    hit?.bytes?.fill(0);
    const top = await pack.get(ids[2] as string);
    expect(same(top?.bytes as Uint8Array, versions[2] as Uint8Array)).toBe(true);
    top?.bytes?.fill(0);
    expect(
      same((await pack.get(ids[3] as string))?.bytes as Uint8Array, versions[3] as Uint8Array),
    ).toBe(true);
  });
});

describe("P4.24: lookups narrowed by a second fan-out level, resolutions through I/O", () => {
  it("an idx of thousands of ids compares about one id per lookup", async () => {
    const files = createInMemoryFilesApi();
    const blobs = Array.from({ length: 6000 }, (_, i) => enc.encode(`blob ${i}\n`));
    const { packPath, idxPath } = await install(
      files,
      blobs.map((data) => ({ kind: 3, data })),
    );
    const pack = await openPack(files, packPath, idxPath);
    for (const b of blobs) expect(pack.has(oidOf("blob", b))).toBe(true);
    // a bucket of ~23 ids takes ~5 comparisons by binary search; its second level leaves ~1
    expect(pack.stats.idCompares).toBeLessThan(2 * blobs.length);
    const before = pack.stats.idCompares;
    for (let i = 0; i < 500; i++)
      expect(pack.has(oidOf("blob", enc.encode(`absent ${i}\n`)))).toBe(false);
    expect(pack.stats.idCompares - before).toBeLessThan(2 * 500);
    // every id still found by `get`, the objects intact
    const some = blobs.filter((_, i) => i % 97 === 0);
    for (const b of some) {
      const o = await pack.get(oidOf("blob", b));
      expect(same(o?.bytes as Uint8Array, b)).toBe(true);
    }
  });

  it("two chains resolved at once, each waiting for windows, under a tiny base cache", async () => {
    const STEPS = 40;
    // deltas spread over many 64 KiB windows by incompressible blobs: each resolution waits
    // in the middle of its walk up, while the other uses the pack's scratch buffers
    let seed = 7;
    const noise = (n: number) =>
      Uint8Array.from({ length: n }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed >> 16;
      });
    const entries: Entry[] = [];
    const versions: Uint8Array[][] = [[text(150, "chain a")], [text(150, "chain b")]];
    const at: number[] = [];
    for (const v of versions) {
      at.push(entries.length);
      entries.push({ kind: 3, data: v[0] as Uint8Array });
    }
    const hex = (n: number) => Buffer.from(noise(n)).toString("hex");
    for (let step = 1; step <= STEPS; step++) {
      entries.push({ kind: 3, data: noise(20 * 1024) });
      for (let c = 0; c < 2; c++) {
        const chainVersions = versions[c] as Uint8Array[];
        // deltas of ~2 KiB compressed: some of them cross a window boundary
        const tail = `step ${step} ${hex(1500)}\n`;
        const { data, d } = extendLong(chainVersions[step - 1] as Uint8Array, tail);
        chainVersions.push(data);
        entries.push({ kind: 6, data: d, baseIdx: at[c] as number });
        at[c] = entries.length - 1;
      }
    }
    const files = createInMemoryFilesApi();
    const { packPath, idxPath } = await install(files, entries);
    {
      // a budget below one version: only the base of each read is cached, the rest is scratch
      const pack = await openPack(files, packPath, idxPath, { baseCacheBytes: 1024 });
      const asked: Uint8Array[] = [];
      for (let k = STEPS; k > 0; k -= 3)
        asked.push(versions[0]?.[k] as Uint8Array, versions[1]?.[k] as Uint8Array);
      const got = await Promise.all(asked.map((v) => pack.get(oidOf("blob", v))));
      for (let i = 0; i < asked.length; i++)
        expect([i, same(got[i]?.bytes as Uint8Array, asked[i] as Uint8Array)]).toEqual([i, true]);
    }
  });
});

/** `extend` for a tail of any length: inserts of at most 127 bytes each. */
function extendLong(base: Uint8Array, tail: string) {
  const t = enc.encode(tail);
  const data = new Uint8Array(base.length + t.length);
  data.set(base);
  data.set(t, base.length);
  const ops = [...copyAll(base.length)];
  for (let i = 0; i < t.length; i += 127) {
    const piece = t.subarray(i, i + 127);
    ops.push(piece.length, ...piece);
  }
  return { data, d: delta(base.length, data.length, ops) };
}
