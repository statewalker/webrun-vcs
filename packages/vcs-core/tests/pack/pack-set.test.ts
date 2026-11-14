/**
 * Reading installed packs: `openPack` (one `.pack` + `.idx`) and `openPackSet` (every pack of a
 * directory), on hand-built packs in memory. The native-git comparisons live in
 * vcs-store-files/tests/pack/pack-set.git.test.ts.
 */

import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../src/common/files/index.js";
import { ObjectIdMismatchError } from "../../src/history/objects/git-objects.js";
import {
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
  concat,
  copyAll,
  delta,
  type Entry,
  extend,
  oidOf,
  pack,
} from "./pack-builder.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PACK_DIR = "/objects/pack";
const MiB = 2 ** 20;

const A = enc.encode("base object A\n".repeat(20));
const { data: B, d: dAB } = extend(A, "plus B\n");
const { data: C, d: dBC } = extend(B, "plus C\n");
const { data: D, d: dCD } = extend(C, "plus D\n");
const Aid = oidOf("blob", A);
const Bid = oidOf("blob", B);
const Cid = oidOf("blob", C);
const Did = oidOf("blob", D);

/** Installs a pack built from `entries` with installPack (P2.2). */
async function install(files: FilesApi, entries: Entry[]) {
  return installPack(files, PACK_DIR, chunks(pack(entries)));
}

/**
 * Writes a pack and an idx for it directly, bypassing installPack's checks (cross-pack REF
 * deltas, cycles, hostile entries). `ids[i]` names entry i; CRCs are the entries' real ones.
 */
async function writeRaw(files: FilesApi, entries: Entry[], ids: string[]) {
  const built = buildPack(entries);
  const bytes = built.bytes;
  const checksum = bytes.subarray(bytes.length - 20);
  const packId = bytesToHex(checksum);
  const idx = writePackIdx(
    ids.map((id, i) => ({
      id,
      offset: built.offsets[i] as number,
      crc32: crc32(bytes.subarray(built.offsets[i], built.ends[i])),
    })),
    checksum,
  );
  const base = `${PACK_DIR}/pack-${packId}`;
  await files.write(`${base}.pack`, [bytes]);
  await files.write(`${base}.idx`, [idx]);
  return { packId, packPath: `${base}.pack`, idxPath: `${base}.idx`, idx, built };
}

const fakeId = (n: number) => n.toString(16).padStart(40, "0");
const paths = (packId: string) => ({
  pack: `${PACK_DIR}/pack-${packId}.pack`,
  idx: `${PACK_DIR}/pack-${packId}.idx`,
});
const flipAt = (b: Uint8Array, at: number) => {
  const c = b.slice();
  c[at] = (c[at] as number) ^ 0x40;
  return c;
};
async function content(o: { content: AsyncIterable<Uint8Array> } | undefined) {
  if (!o) throw new Error("object not found");
  return collect(o.content);
}
/** xorshift bytes: deterministic and incompressible */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}

describe("openPackSet: reading objects", () => {
  it("get, has and list over two packs", async () => {
    const files = createInMemoryFilesApi();
    const p1 = await install(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
    ]);
    const tree = enc.encode("100644 f\0".padEnd(29, "x"));
    const p2 = await install(files, [
      { kind: 3, data: C },
      { kind: 2, data: tree },
    ]);
    const set = await openPackSet(files, PACK_DIR);
    expect((await set.packs()).map((p) => p.packId).sort()).toEqual([p1.packId, p2.packId].sort());
    expect(set.skipped).toEqual([]);
    for (const [id, type, data] of [
      [Aid, "blob", A],
      [Bid, "blob", B],
      [Cid, "blob", C],
      [oidOf("tree", tree), "tree", tree],
    ] as const) {
      expect(await set.has(id), id).toBe(true);
      const o = await set.get(id, { verify: true });
      expect(o?.type).toBe(type);
      expect(o?.size).toBe(data.length);
      expect(await content(o)).toEqual(data);
    }
    const listed: string[] = [];
    for await (const id of set.list()) listed.push(id);
    expect(listed.sort()).toEqual([Aid, Bid, Cid, oidOf("tree", tree)].sort());
    const absent = "0123456789abcdef0123456789abcdef01234567";
    expect(await set.has(absent)).toBe(false);
    expect(await set.get(absent)).toBeUndefined();
    expect(await set.entry(absent)).toBeUndefined();
    expect(await set.has("not an id")).toBe(false);
  });

  it("resolves OFS and REF chains (REF on OFS, OFS on REF)", async () => {
    const files = createInMemoryFilesApi();
    const { data: E, d: dDE } = extend(D, "plus E\n");
    await install(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
      { kind: 7, data: dBC, baseOid: Bid },
      { kind: 7, data: dCD, baseOid: Cid },
      { kind: 6, data: dDE, baseIdx: 3 },
    ]);
    const set = await openPackSet(files, PACK_DIR);
    for (const [id, data] of [
      [Aid, A],
      [Bid, B],
      [Cid, C],
      [Did, D],
      [oidOf("blob", E), E],
    ] as const) {
      expect(await content(await set.get(id, { verify: true })), id).toEqual(data);
    }
  });

  it("resolves a REF_DELTA whose base is in another pack of the set", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [{ kind: 3, data: A }]);
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: Aid }], [Bid]);
    const set = await openPackSet(files, PACK_DIR);
    expect(set.skipped).toEqual([]);
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
  });

  it("resolves a REF_DELTA whose base is outside the set through externalBase", async () => {
    const files = createInMemoryFilesApi();
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: Aid }], [Bid]);
    const asked: string[] = [];
    const set = await openPackSet(files, PACK_DIR, {
      externalBase: async (id) => {
        asked.push(id);
        return id === Aid
          ? {
              type: "blob",
              size: A.length,
              content: (async function* () {
                yield A;
              })(),
            }
          : undefined;
      },
    });
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
    expect(asked).toEqual([Aid]);
  });

  it("an external base over maxObjectSize is refused before it is buffered", async () => {
    const files = createInMemoryFilesApi();
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: Aid }], [Bid]);
    let read = false;
    const set = await openPackSet(files, PACK_DIR, {
      maxObjectSize: MiB,
      // a loose zlib bomb: a few KB on disk declaring 8 MiB
      externalBase: async () => ({
        type: "blob",
        size: 8 * MiB,
        content: (async function* () {
          read = true;
          yield new Uint8Array(8 * MiB);
        })(),
      }),
    });
    await expect(set.get(Bid)).rejects.toThrow(/over the limit of 1048576/);
    await expect(set.get(Bid)).rejects.toBeInstanceOf(PackError);
    expect(read).toBe(false);
  });

  it("a REF_DELTA cycle across two packs fails with PackError, fast", async () => {
    const files = createInMemoryFilesApi();
    const X = fakeId(0xaa);
    const Y = fakeId(0xbb);
    const d = delta(10, 10, copyAll(10));
    await writeRaw(files, [{ kind: 7, data: d, baseOid: Y }], [X]);
    await writeRaw(files, [{ kind: 7, data: d, baseOid: X }], [Y]);
    const set = await openPackSet(files, PACK_DIR);
    const t0 = performance.now();
    await expect(set.get(X)).rejects.toBeInstanceOf(PackError);
    await expect(set.get(Y)).rejects.toBeInstanceOf(PackError);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("a copy that fails is passed over for another pack's copy (git's mark_bad_packed_object)", async () => {
    const files = createInMemoryFilesApi();
    // a broken copy of B: a REF_DELTA on a base that exists nowhere
    const good = await install(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 5)); // the broken pack is newer: it is tried first
    const broken = await writeRaw(files, [{ kind: 7, data: dAB, baseOid: fakeId(0xee) }], [Bid]);
    const set = await openPackSet(files, PACK_DIR);
    expect((await set.packs()).map((p) => p.packId)).toEqual([broken.packId, good.packId]);
    for (let i = 0; i < 2; i++)
      expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
    // with no other copy, the pack's error is raised
    const lone = createInMemoryFilesApi();
    await writeRaw(lone, [{ kind: 7, data: dAB, baseOid: fakeId(0xee) }], [Bid]);
    await expect((await openPackSet(lone, PACK_DIR)).get(Bid)).rejects.toBeInstanceOf(PackError);
  });

  it("verify detects content that hashes to another id", async () => {
    const files = createInMemoryFilesApi();
    const X = enc.encode("aaaa\n".repeat(30));
    const Y = enc.encode("bbbb\n".repeat(30));
    const pa = pack([{ kind: 3, data: X }]);
    const pb = pack([{ kind: 3, data: Y }]);
    const r = await installPack(files, PACK_DIR, chunks(pa));
    // same layout, other content; pa's trailer kept so the pack/idx pairing holds
    const forged = pb.slice();
    forged.set(pa.subarray(pa.length - 20), forged.length - 20);
    await files.write(paths(r.packId).pack, [forged]);
    const set = await openPackSet(files, PACK_DIR);
    const id = oidOf("blob", X);
    expect(await content(await set.get(id))).toEqual(Y); // without verify: the wrong bytes
    const o = await set.get(id, { verify: true });
    await expect(content(o)).rejects.toBeInstanceOf(ObjectIdMismatchError);
  });

  it("a corrupt compressed entry fails with PackError when read", async () => {
    const files = createInMemoryFilesApi();
    const big = enc.encode(Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join(""));
    const r = await install(files, [{ kind: 3, data: big }]);
    const raw = await collect(files.read(paths(r.packId).pack));
    await files.write(paths(r.packId).pack, [flipAt(raw, 60)]);
    const set = await openPackSet(files, PACK_DIR);
    await expect(content(await set.get(oidOf("blob", big)))).rejects.toBeInstanceOf(PackError);
  });

  it("returned buffers are never the cached ones", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
    ]);
    const set = await openPackSet(files, PACK_DIR);
    // the first read caches B; mutating what it returned must not reach the cache
    const first = await set.get(Bid);
    for await (const c of first?.content ?? []) c.fill(0);
    // the second read is a cache hit: mutate it too
    const second = await set.get(Bid);
    for await (const c of second?.content ?? []) c.fill(0);
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
    // the base A (a checkpoint for B) is not shared either
    const a = await set.get(Aid);
    for await (const c of a?.content ?? []) c.fill(0);
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
  });

  it("a large whole object is streamed in many chunks, never materialised", async () => {
    const files = createInMemoryFilesApi();
    const big = noise(MiB, 5);
    await install(files, [{ kind: 3, data: big }]);
    const set = await openPackSet(files, PACK_DIR);
    const o = await set.get(oidOf("blob", big), { verify: true });
    let n = 0;
    let largest = 0;
    for await (const c of o?.content ?? []) {
      n++;
      largest = Math.max(largest, c.length);
    }
    expect(n).toBeGreaterThan(1);
    expect(largest).toBeLessThan(big.length);
  });
});

describe("openPackSet: corrupt packs are skipped and recorded", () => {
  /** A set over a good pack (A, B) plus `victim`, whose idx is replaced by `idx(victimIdx)`. */
  async function withBadIdx(mutate: (idx: Uint8Array, files: FilesApi) => Promise<Uint8Array>) {
    const files = createInMemoryFilesApi();
    await install(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
    ]);
    const victim = await install(files, [{ kind: 3, data: enc.encode("victim\n".repeat(10)) }]);
    const p = paths(victim.packId);
    await files.write(p.idx, [await mutate(await collect(files.read(p.idx)), files)]);
    const set = await openPackSet(files, PACK_DIR);
    expect(set.skipped.map((s) => s.pack)).toEqual([`pack-${victim.packId}`]);
    expect(set.skipped[0]?.error).toMatch(/idx|pack/);
    // the healthy pack stays readable
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
    expect((await set.packs()).length).toBe(1);
    return set;
  }

  it("an idx whose checksum is wrong", async () => {
    await withBadIdx(async (idx) => flipAt(idx, idx.length - 1));
  });

  it("a truncated idx", async () => {
    await withBadIdx(async (idx) => idx.subarray(0, idx.length - 100));
  });

  it("the idx of another pack with the same object count (trailer pairing)", async () => {
    await withBadIdx(async () => {
      const other = createInMemoryFilesApi();
      const r = await install(other, [{ kind: 3, data: enc.encode("another pack\n".repeat(10)) }]);
      return collect(other.read(paths(r.packId).idx));
    });
  });

  it("an idx whose ids are out of order", async () => {
    const files = createInMemoryFilesApi();
    const raw = await writeRaw(
      files,
      [
        { kind: 3, data: enc.encode("one\n") },
        { kind: 3, data: enc.encode("two\n") },
      ],
      [`aa${"1".repeat(38)}`, `aa${"2".repeat(38)}`],
    );
    // swap the two ids inside the same fan-out bucket and re-checksum
    const idx = raw.idx.slice();
    const at = 8 + 1024;
    const first = idx.slice(at, at + 20);
    idx.copyWithin(at, at + 20, at + 40);
    idx.set(first, at + 20);
    idx.set(
      createSha1()
        .update(idx.subarray(0, idx.length - 20))
        .digest(),
      idx.length - 20,
    );
    await files.write(raw.idxPath, [idx]);
    await expect(openPack(files, raw.packPath, raw.idxPath)).rejects.toBeInstanceOf(PackError);
    const set = await openPackSet(files, PACK_DIR);
    expect(set.skipped.map((s) => s.pack)).toEqual([`pack-${raw.packId}`]);
  });

  it("an idx without its pack is ignored, not reported", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    await files.remove(paths(r.packId).pack);
    const set = await openPackSet(files, PACK_DIR);
    expect(set.skipped).toEqual([]);
    expect(await set.has(Aid)).toBe(false);
  });

  it("a missing pack directory is an empty set", async () => {
    const set = await openPackSet(createInMemoryFilesApi(), PACK_DIR);
    expect(await set.packs()).toEqual([]);
    expect(await set.has(Aid)).toBe(false);
  });
});

describe("openPack: hostile and broken entries fail with PackError", () => {
  it("entry sizes that disagree with the data (larger, smaller)", async () => {
    const files = createInMemoryFilesApi();
    const data = enc.encode("content\n".repeat(20));
    for (const sizeOverride of [data.length + 5, data.length - 5]) {
      const raw = await writeRaw(files, [{ kind: 3, data, sizeOverride }], [fakeId(sizeOverride)]);
      const p = await openPack(files, raw.packPath, raw.idxPath);
      await expect(
        content(await p.get(fakeId(sizeOverride))),
        String(sizeOverride),
      ).rejects.toBeInstanceOf(PackError);
    }
  });

  it("a delta base declaring 1.5 GiB or 2^40 bytes is refused before allocating", async () => {
    const files = createInMemoryFilesApi();
    const base = enc.encode("abc");
    for (const size of [1.5 * 2 ** 30, 2 ** 40]) {
      const child = fakeId(1 + (size % 9999));
      const raw = await writeRaw(
        files,
        [
          { kind: 3, data: base, sizeOverride: size },
          { kind: 6, data: delta(3, 3, copyAll(3)), baseIdx: 0 },
        ],
        [fakeId(size % 9999), child],
      );
      // no size limit: only the zlib expansion bound protects
      const p = await openPack(files, raw.packPath, raw.idxPath, { maxObjectSize: 2 ** 50 });
      await expect(p.get(child), String(size)).rejects.toBeInstanceOf(PackError);
    }
  });

  it("a delta declaring more than maxObjectSize is refused before its result is allocated", async () => {
    const files = createInMemoryFilesApi();
    const base = new Uint8Array(MiB).fill(0x61);
    const copies = Array.from({ length: 8 }, () => copyAll(MiB)).flat();
    const r = await install(files, [
      { kind: 3, data: base },
      { kind: 6, data: delta(MiB, 8 * MiB, copies), baseIdx: 0 },
    ]);
    const p = paths(r.packId);
    const big = new Uint8Array(8 * MiB).fill(0x61);
    const id = oidOf("blob", big);
    const limited = await openPack(files, p.pack, p.idx, { maxObjectSize: 4 * MiB });
    await expect(limited.get(id)).rejects.toBeInstanceOf(PackError);
    const ok = await openPack(files, p.pack, p.idx, { maxObjectSize: 16 * MiB });
    expect((await content(await ok.get(id))).length).toBe(8 * MiB);
  });

  it("large offsets decode; a large-offset index outside the table is refused at open", async () => {
    const files = createInMemoryFilesApi();
    const data = enc.encode("big offset\n");
    const r = await install(files, [{ kind: 3, data }]);
    const p = paths(r.packId);
    const idx = await collect(files.read(p.idx));
    // entry 0's offset rewritten as an index into the 64-bit table, which holds the real offset
    const rebuild = (index: number) => {
      const offAt = 8 + 1024 + 20 + 4;
      const head = idx.slice(0, offAt + 4);
      new DataView(head.buffer).setUint32(offAt, (0x80000000 | index) >>> 0);
      const table = new Uint8Array(8);
      new DataView(table.buffer).setUint32(4, 12);
      const body = concat([head, table, idx.subarray(idx.length - 40, idx.length - 20)]);
      return concat([body, createSha1().update(body).digest()]);
    };
    await files.write("/other/large.idx", [rebuild(0)]);
    const ok = await openPack(files, p.pack, "/other/large.idx");
    expect(dec.decode(await content(await ok.get(oidOf("blob", data), { verify: true })))).toBe(
      "big offset\n",
    );
    await files.write("/other/bad-large.idx", [rebuild(7)]);
    await expect(openPack(files, p.pack, "/other/bad-large.idx")).rejects.toBeInstanceOf(PackError);
  });

  it("an idx naming a pack with another object count is refused", async () => {
    const files = createInMemoryFilesApi();
    const r1 = await install(files, [{ kind: 3, data: A }]);
    const r2 = await install(files, [
      { kind: 3, data: B },
      { kind: 3, data: C },
    ]);
    await expect(
      openPack(files, paths(r1.packId).pack, paths(r2.packId).idx),
    ).rejects.toBeInstanceOf(PackError);
  });
});

describe("openPack: idx version 1", () => {
  /** git's `.idx` v1: fan-out, then (4-byte offset, id) per object, the pack checksum, its SHA-1 */
  function writeIdxV1(entries: { id: string; offset: number }[], packChecksum: Uint8Array) {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    const out = new Uint8Array(1024 + sorted.length * 24 + 40);
    const v = new DataView(out.buffer);
    const fan = new Uint32Array(256);
    for (const e of sorted) (fan[Number.parseInt(e.id.slice(0, 2), 16)] as number)++;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += fan[i] as number;
      v.setUint32(i * 4, acc);
    }
    sorted.forEach((e, i) => {
      v.setUint32(1024 + i * 24, e.offset);
      out.set(hexToBytes(e.id), 1024 + i * 24 + 4);
    });
    out.set(packChecksum, 1024 + sorted.length * 24);
    out.set(
      createSha1()
        .update(out.subarray(0, out.length - 20))
        .digest(),
      out.length - 20,
    );
    return out;
  }

  it("reads objects and raw entries through a v1 idx", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
    ]);
    const checksum = built.bytes.subarray(built.bytes.length - 20);
    const packId = bytesToHex(checksum);
    const p = paths(packId);
    await files.write(p.pack, [built.bytes]);
    await files.write(p.idx, [
      writeIdxV1(
        [
          { id: Aid, offset: built.offsets[0] as number },
          { id: Bid, offset: built.offsets[1] as number },
        ],
        checksum,
      ),
    ]);
    const set = await openPackSet(files, PACK_DIR);
    expect(set.skipped).toEqual([]);
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
    const e = await set.entry(Bid);
    expect(e?.crc32).toBe(crc32(built.bytes.subarray(built.offsets[1], built.ends[1])));
    expect(await collect(e?.raw() ?? [])).toEqual(compressBlockPako(dAB));
    // a v1 idx with a flipped checksum is skipped too
    const idx = await collect(files.read(p.idx));
    await files.write(p.idx, [flipAt(idx, idx.length - 1)]);
    expect((await openPackSet(files, PACK_DIR)).skipped.length).toBe(1);
  });
});

describe("PackSet.entry: raw entries for reuse", () => {
  it("returns kind, size, base id, the idx CRC and the compressed bytes", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
      { kind: 7, data: dBC, baseOid: Bid },
    ]);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    const set = await openPackSet(files, PACK_DIR);
    const crcOf = (i: number) => crc32(built.bytes.subarray(built.offsets[i], built.ends[i]));

    const a = await set.entry(Aid);
    expect(a).toMatchObject({ kind: 3, size: A.length, crc32: crcOf(0) });
    expect(a?.baseId).toBeUndefined();
    expect(await collect(a?.raw() ?? [])).toEqual(compressBlockPako(A));

    const b = await set.entry(Bid);
    expect(b).toMatchObject({ kind: 6, size: dAB.length, baseId: Aid, crc32: crcOf(1) });
    expect(await collect(b?.raw() ?? [])).toEqual(compressBlockPako(dAB));

    const c = await set.entry(Cid);
    expect(c).toMatchObject({ kind: 7, size: dBC.length, baseId: Bid, crc32: crcOf(2) });
    expect(await collect(c?.raw() ?? [])).toEqual(compressBlockPako(dBC));
    expect(r.count).toBe(3);
  });

  it("a corrupt entry fails its CRC check with PackError at the end of raw()", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 3, data: C },
    ]);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    const p = paths(r.packId);
    // flip a byte of the second entry's compressed data (the first stays good)
    const at = (built.offsets[1] as number) + 10;
    await files.write(p.pack, [flipAt(built.bytes, at)]);
    const set = await openPackSet(files, PACK_DIR);
    const e = await set.entry(Cid);
    await expect(collect(e?.raw() ?? [])).rejects.toBeInstanceOf(PackError);
    await expect(collect((await set.entry(Aid))?.raw() ?? [])).resolves.toEqual(
      compressBlockPako(A),
    );
  });
});

describe("PackSet.install and remove", () => {
  it("install delegates to installPack and makes the pack readable at once", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [{ kind: 3, data: A }]);
    // no rescans: the installed pack must be added by install itself
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    await set.has(Bid); // a miss: the one free rescan is spent here
    const r = await set.install(
      chunks(
        pack([
          { kind: 3, data: B },
          { kind: 6, data: dBC, baseIdx: 0 },
        ]),
      ),
    );
    expect(r.count).toBe(2);
    expect(await files.exists(paths(r.packId).idx)).toBe(true);
    expect(await set.has(Bid)).toBe(true);
    expect(await content(await set.get(Cid, { verify: true }))).toEqual(C);
    expect((await set.packs()).length).toBe(2);
    // installing the same pack again keeps one copy
    await set.install(
      chunks(
        pack([
          { kind: 3, data: B },
          { kind: 6, data: dBC, baseIdx: 0 },
        ]),
      ),
    );
    expect((await set.packs()).length).toBe(2);
  });

  it("install refuses a corrupt pack with PackError and leaves the set as it was", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR);
    const bad = pack([{ kind: 3, data: A }]);
    await expect(set.install(chunks(flipAt(bad, 20)))).rejects.toBeInstanceOf(PackError);
    expect(await set.packs()).toEqual([]);
  });

  it("remove deletes the .idx first, then the .pack, .keep and .rev", async () => {
    const files = createInMemoryFilesApi();
    const r1 = await install(files, [{ kind: 3, data: A }]);
    const r2 = await install(files, [{ kind: 3, data: B }]);
    const base = `${PACK_DIR}/pack-${r1.packId}`;
    await files.write(`${base}.keep`, [enc.encode("kept\n")]);
    await files.write(`${base}.rev`, [new Uint8Array(4)]);
    const removed: string[] = [];
    const remove = files.remove.bind(files);
    files.remove = async (path) => {
      removed.push(path);
      return remove(path);
    };
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: 0 });
    await set.remove([r1.packId]);
    expect(removed.slice(0, 2)).toEqual([`${base}.idx`, `${base}.pack`]);
    expect(removed.sort()).toEqual(
      [`${base}.idx`, `${base}.keep`, `${base}.pack`, `${base}.rev`].sort(),
    );
    expect(await set.has(Aid)).toBe(false); // even after the rescan this miss triggers
    expect(await content(await set.get(Bid))).toEqual(B);
    expect((await set.packs()).map((p) => p.packId)).toEqual([r2.packId]);
    // an unknown id is ignored
    await set.remove(["0".repeat(40)]);
  });
});

describe("PackSet: rescans the directory on a miss", () => {
  it("finds a pack written after open; rescans are rate-limited; refresh forces one", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: 60_000 });
    // written by someone else (native git, another FilesApi user) after open
    await install(files, [{ kind: 3, data: B }]);
    expect(await content(await set.get(Bid))).toEqual(B);
    expect(await set.has(Bid)).toBe(true);
    // within the interval, a second miss does not list the directory again
    await install(files, [{ kind: 3, data: C }]);
    let lists = 0;
    const list = files.list.bind(files);
    files.list = (path, o) => {
      lists++;
      return list(path, o);
    };
    expect(await set.has(Cid)).toBe(false);
    expect(lists).toBe(0);
    expect(await set.refresh()).toBe(true);
    expect(await set.has(Cid)).toBe(true);
    expect(await set.refresh()).toBe(false);
  });

  it("drops a pack removed by someone else", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR);
    await files.remove(paths(r.packId).idx);
    await files.remove(paths(r.packId).pack);
    // the stale pack fails to read: it is dropped, the object is reported absent
    expect(await set.get(Aid)).toBeUndefined();
    expect(await set.packs()).toEqual([]);
  });
});

describe("the delta base cache", () => {
  // Random reads of a 50-deep chain with a cache of 4 objects: 660 inflations against 1326
  // without a cache. Caching every step instead of spaced checkpoints gives 949 (prototype 13).
  it("halves the inflations of random reads over a deep chain, within its budget", async () => {
    const files = createInMemoryFilesApi();
    const big = noise(64 * 1024, 3);
    const entries: Entry[] = [{ kind: 3, data: big }];
    for (let i = 0; i < 50; i++) {
      const len = big.length + i;
      entries.push({ kind: 6, data: delta(len, len + 1, [...copyAll(len), 1, i]), baseIdx: i });
    }
    const built = buildPack(entries);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    const p = paths(r.packId);
    // the ids, in a seeded random order
    const ids: string[] = [];
    let cur = big;
    ids.push(oidOf("blob", cur));
    for (let i = 0; i < 50; i++) {
      const next = new Uint8Array(cur.length + 1);
      next.set(cur);
      next[cur.length] = i;
      cur = next;
      ids.push(oidOf("blob", cur));
    }
    let seed = 7;
    for (let i = ids.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const j = seed % (i + 1);
      [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
    }
    const inflations: number[] = [];
    for (const cache of [4 * big.length, 0]) {
      const reader = (await openPack(files, p.pack, p.idx, { baseCacheBytes: cache })) as PackFile;
      for (const id of ids) {
        const o = await reader.get(id, { verify: true });
        expect((await content(o)).length).toBe(o?.size);
      }
      inflations.push(reader.stats.inflations);
      expect(reader.stats.peakCachedBytes).toBeLessThanOrEqual(cache);
      expect(reader.stats.cachedBytes).toBe(reader.stats.cachedEntriesBytes);
      if (cache > 0) expect(reader.stats.peakCachedBytes).toBeGreaterThan(0);
    }
    expect((inflations[0] as number) * 2).toBeLessThanOrEqual(inflations[1] as number);
  });
});

describe("storage errors", () => {
  it("pass through unchanged (not a PackError)", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR);
    const read = files.read.bind(files);
    const failure = new Error("EIO: disk on fire");
    files.read = (path, o) =>
      path.endsWith(".pack")
        ? (async function* () {
            yield* [];
            throw failure;
          })()
        : read(path, o);
    const err = await (async () => {
      const o = await set.get(Aid);
      return collect(o?.content ?? []);
    })().catch((e) => e);
    expect(err).toBe(failure);
    expect(r.count).toBe(1);
  });
});
