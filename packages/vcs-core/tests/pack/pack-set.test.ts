/**
 * Reading installed packs: `openPack` (one `.pack` + `.idx`) and `openPackSet` (every pack of a
 * directory), on hand-built packs in memory. The native-git comparisons live in
 * vcs-store-files/tests/pack/pack-set.git.test.ts.
 */

import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it, vi } from "vitest";
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
    // the first chunk is read before get returns: get itself rejects
    await expect((async () => content(await set.get(oidOf("blob", big))))()).rejects.toBeInstanceOf(
      PackError,
    );
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

describe("review of P2.3: copies that cannot serve a read", () => {
  it("freshen is false for a pack deleted behind the set's back, and drops it", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    // freshen trusts a pack it checked within the rescan interval: 0 makes it check each time
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: 0 });
    expect(await set.freshen(Aid)).toBe(true);
    await files.remove(paths(r.packId).idx);
    await files.remove(paths(r.packId).pack);
    expect(await set.freshen(Aid)).toBe(false);
    expect(await set.packs()).toEqual([]);
  });

  it("has and freshen are false for a copy found corrupt (JGit's hasObject, git's fill_pack_entry)", async () => {
    const files = createInMemoryFilesApi();
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: fakeId(0xee) }], [Bid]);
    const set = await openPackSet(files, PACK_DIR);
    expect(await set.has(Bid)).toBe(true); // not known to be bad yet
    await expect(set.get(Bid)).rejects.toBeInstanceOf(PackError);
    expect(await set.has(Bid)).toBe(false);
    expect(await set.freshen(Bid)).toBe(false);
  });

  it("a corrupt whole object fails get() itself (its first chunk is read before returning)", async () => {
    const files = createInMemoryFilesApi();
    const big = enc.encode(Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join(""));
    const r = await install(files, [{ kind: 3, data: big }]);
    const raw = await collect(files.read(paths(r.packId).pack));
    await files.write(paths(r.packId).pack, [flipAt(raw, 60)]);
    const set = await openPackSet(files, PACK_DIR);
    await expect(set.get(oidOf("blob", big))).rejects.toBeInstanceOf(PackError);
    expect(await set.has(oidOf("blob", big))).toBe(false);
  });

  it("a stream that fails after its first chunk marks the copy bad", async () => {
    const files = createInMemoryFilesApi();
    const big = noise(MiB, 9);
    const built = buildPack([{ kind: 3, data: big }]);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    // corrupt the end of the zlib stream: the first chunks inflate, the end does not
    const at = (built.ends[0] as number) - 6;
    await files.write(paths(r.packId).pack, [flipAt(built.bytes, at)]);
    const set = await openPackSet(files, PACK_DIR);
    const id = oidOf("blob", big);
    const o = await set.get(id);
    await expect(content(o)).rejects.toBeInstanceOf(PackError);
    expect(await set.has(id)).toBe(false);
  });

  it("entry().raw() checks the CRC before it yields a byte", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 3, data: C },
    ]);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    await files.write(paths(r.packId).pack, [
      flipAt(built.bytes, (built.offsets[1] as number) + 10),
    ]);
    const set = await openPackSet(files, PACK_DIR);
    const e = await set.entry(Cid);
    let yielded = 0;
    const err = await (async () => {
      for await (const _ of e?.raw() ?? []) yielded++;
    })().catch((x) => x);
    expect(err).toBeInstanceOf(PackError);
    expect(yielded).toBe(0);
  });

  it("list yields an object held by two packs once", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [{ kind: 3, data: A }]);
    await install(files, [
      { kind: 3, data: A },
      { kind: 3, data: B },
    ]);
    const set = await openPackSet(files, PACK_DIR);
    const listed: string[] = [];
    for await (const id of set.list()) listed.push(id);
    expect(listed.sort()).toEqual([Aid, Bid].sort());
  });
});

describe("review of P2.3: packs seen while they are written", () => {
  it("a pack seen with a half-written idx is found once the idx is complete", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([{ kind: 3, data: A }]);
    const checksum = built.bytes.subarray(built.bytes.length - 20);
    const packId = bytesToHex(checksum);
    const idx = writePackIdx(
      [{ id: Aid, offset: 12, crc32: crc32(built.bytes.subarray(12, built.ends[0])) }],
      checksum,
    );
    await files.write(paths(packId).pack, [built.bytes]);
    await files.write(paths(packId).idx, [idx.subarray(0, 600)]); // written in place, not yet complete
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    expect(set.skipped.map((s) => s.pack)).toEqual([`pack-${packId}`]);
    await files.write(paths(packId).idx, [idx]);
    await set.refresh();
    expect(set.skipped).toEqual([]);
    expect(await content(await set.get(Aid))).toEqual(A);
  });

  it("a corrupt pack whose files do not change is not reopened by later scans", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const idx = await collect(files.read(paths(r.packId).idx));
    await files.write(paths(r.packId).idx, [flipAt(idx, idx.length - 1)]);
    const set = await openPackSet(files, PACK_DIR);
    let idxReads = 0;
    const read = files.read.bind(files);
    files.read = (path, o) => {
      if (path.endsWith(".idx")) idxReads++;
      return read(path, o);
    };
    await set.refresh();
    expect(idxReads).toBe(0);
    expect(set.skipped.length).toBe(1);
  });
});

describe("review of P2.3: concurrent scans, installs and removals", () => {
  /** A one-shot gate: `wait()` blocks the first caller until `open()`. */
  function gate() {
    let release = () => {};
    const opened = new Promise<void>((r) => {
      release = r;
    });
    let used = false;
    return {
      open: () => release(),
      async wait(): Promise<boolean> {
        if (used) return false;
        used = true;
        await opened;
        return true;
      },
    };
  }

  it("refresh starts a new scan when the running one started before the call", async () => {
    const files = createInMemoryFilesApi();
    await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const g = gate();
    let listed = () => {};
    const listedP = new Promise<void>((r) => {
      listed = r;
    });
    const list = files.list.bind(files);
    files.list = (path, o) =>
      (async function* () {
        const entries = [];
        for await (const e of list(path, o)) entries.push(e);
        listed();
        await g.wait();
        yield* entries;
      })();
    const first = set.refresh();
    await listedP; // the first scan has its listing
    const r = await install(files, [{ kind: 3, data: B }]);
    const second = set.refresh();
    g.open();
    await Promise.all([first, second]);
    expect((await set.packs()).map((p) => p.packId)).toContain(r.packId);
  });

  it("remove wins over a scan that is opening the pack", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const r = await install(files, [{ kind: 3, data: A }]);
    const g = gate();
    let opening = () => {};
    const openingP = new Promise<void>((res) => {
      opening = res;
    });
    const stats = files.stats.bind(files);
    files.stats = async (path) => {
      if (path === paths(r.packId).pack) {
        opening();
        await g.wait();
      }
      return stats(path);
    };
    const scan = set.refresh();
    await openingP; // the scan read the idx and is about to check the pack
    await set.remove([r.packId]);
    g.open();
    await scan;
    expect(await set.packs()).toEqual([]);
    expect(set.skipped).toEqual([]);
  });

  it("an install during a scan that is opening the same pack adds it once", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const bytes = pack([{ kind: 3, data: A }]);
    const r = await installPack(files, PACK_DIR, chunks(bytes));
    const g = gate();
    let opening = () => {};
    const openingP = new Promise<void>((res) => {
      opening = res;
    });
    const stats = files.stats.bind(files);
    files.stats = async (path) => {
      if (path === paths(r.packId).pack) {
        opening();
        await g.wait();
      }
      return stats(path);
    };
    const scan = set.refresh();
    await openingP;
    const installed = set.install(chunks(bytes));
    await new Promise((res) => setTimeout(res, 50)); // the install reaches its open meanwhile
    g.open();
    await Promise.all([scan, installed]);
    expect((await set.packs()).map((p) => p.packId)).toEqual([r.packId]);
  });
});

/** A promise with its resolver, for gating steps of a race deterministically. */
function deferred<T = void>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** Counts the reads `files` has open (started and neither finished, failed nor returned). */
function countOpenReads(files: FilesApi) {
  let open = 0;
  const read = files.read.bind(files);
  files.read = (path, o) => ({
    [Symbol.asyncIterator]() {
      const it = read(path, o)[Symbol.asyncIterator]();
      open++;
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          open--;
        }
      };
      return {
        async next() {
          try {
            const r = await it.next();
            if (r.done) close();
            return r;
          } catch (e) {
            close();
            throw e;
          }
        },
        async return(v?: unknown) {
          close();
          await it.return?.(v);
          return { done: true as const, value: undefined };
        },
      };
    },
  });
  return () => open;
}

describe("re-review of P2.3: reads are released", () => {
  async function bigPack() {
    const files = createInMemoryFilesApi();
    const big = noise(MiB, 21);
    await install(files, [{ kind: 3, data: big }]);
    const set = await openPackSet(files, PACK_DIR);
    return { files, set, id: oidOf("blob", big) };
  }

  it("get then return without iterating closes the pack read", async () => {
    const { files, set, id } = await bigPack();
    const open = countOpenReads(files);
    const o = await set.get(id);
    expect(open()).toBe(1); // the first chunk was read: the stream is open
    await o?.content[Symbol.asyncIterator]().return?.();
    expect(open()).toBe(0);
  });

  it("reading only the first chunk, then return, closes the pack read", async () => {
    const { files, set, id } = await bigPack();
    const open = countOpenReads(files);
    const o = await set.get(id);
    const it = o?.content[Symbol.asyncIterator]();
    const first = await it?.next();
    expect(first?.done).toBe(false);
    await it?.return?.();
    expect(open()).toBe(0);
  });

  it("a whole read leaves nothing open", async () => {
    const { files, set, id } = await bigPack();
    const open = countOpenReads(files);
    expect((await content(await set.get(id, { verify: true }))).length).toBe(MiB);
    expect(open()).toBe(0);
  });
});

describe("re-review of P2.3: scans", () => {
  it("a storage error while scanning one pack does not hide the others", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    await install(files, [{ kind: 3, data: A }]);
    await new Promise((r) => setTimeout(r, 5));
    await install(files, [{ kind: 3, data: B }]);
    // the second pack the scan checks fails once with EIO
    let checked = 0;
    let failed = false;
    const exists = files.exists.bind(files);
    files.exists = async (path) => {
      if (path.endsWith(".pack") && ++checked === 2 && !failed) {
        failed = true;
        throw new Error("EIO");
      }
      return exists(path);
    };
    await set.refresh().catch(() => {});
    await set.refresh();
    expect((await set.packs()).length).toBe(2);
    expect(await content(await set.get(Aid))).toEqual(A);
    expect(await content(await set.get(Bid))).toEqual(B);
  });

  it("an idx completed right after a failed read is found by the next refresh", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([{ kind: 3, data: A }]);
    const checksum = built.bytes.subarray(built.bytes.length - 20);
    const packId = bytesToHex(checksum);
    const idx = writePackIdx(
      [{ id: Aid, offset: 12, crc32: crc32(built.bytes.subarray(12, built.ends[0])) }],
      checksum,
    );
    await files.write(paths(packId).pack, [built.bytes]);
    await files.write(paths(packId).idx, [idx.subarray(0, 600)]);
    // the writer finishes the idx just after the scan read the partial one
    const read = files.read.bind(files);
    let completed = false;
    files.read = (path, o) =>
      (async function* () {
        yield* read(path, o);
        if (path === paths(packId).idx && !completed) {
          completed = true;
          await files.write(paths(packId).idx, [idx]);
        }
      })();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    expect(set.skipped.length).toBe(1);
    await set.refresh();
    expect(set.skipped).toEqual([]);
    expect(await content(await set.get(Aid))).toEqual(A);
  });

  it("freshen checks the pack file at most once per rescan interval", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    let checks = 0;
    const exists = files.exists.bind(files);
    files.exists = async (path) => {
      if (path === paths(r.packId).pack) checks++;
      return exists(path);
    };
    for (let i = 0; i < 100; i++) expect(await set.freshen(Aid)).toBe(true);
    expect(checks).toBe(1);
  });
});

describe("re-review of P2.3: a REF_DELTA base whose packed copies are all bad", () => {
  it("falls back to externalBase (a repaired loose base)", async () => {
    const files = createInMemoryFilesApi();
    // the only packed copy of A is broken; B is a REF_DELTA on A in another pack
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: fakeId(0xee) }], [Aid]);
    await writeRaw(files, [{ kind: 7, data: dAB, baseOid: Aid }], [Bid]);
    const set = await openPackSet(files, PACK_DIR, {
      externalBase: async (id) =>
        id === Aid
          ? {
              type: "blob",
              size: A.length,
              content: (async function* () {
                yield A;
              })(),
            }
          : undefined,
    });
    await expect(set.get(Aid)).rejects.toBeInstanceOf(PackError); // the bad copy is marked
    expect(await content(await set.get(Bid, { verify: true }))).toEqual(B);
  });
});

describe("re-review of P2.3: removals and installs racing scans", () => {
  /** Holds the first call matching `match` until `release()`; `reached` resolves when it arrives. */
  function holdFirst(match: (path: string) => boolean) {
    const reached = deferred();
    const released = deferred();
    let used = false;
    return {
      reached: reached.promise,
      release: () => released.resolve(),
      async maybeHold(path: string) {
        if (used || !match(path)) return;
        used = true;
        reached.resolve();
        await released.promise;
      },
    };
  }

  it("a scan that starts while remove() deletes the files does not re-add the pack", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const hold = holdFirst((p) => p === paths(r.packId).idx);
    const remove = files.remove.bind(files);
    files.remove = async (path) => {
      await hold.maybeHold(path);
      return remove(path);
    };
    const removing = set.remove([r.packId]);
    await hold.reached; // remove() is about to delete the idx
    await set.refresh(); // a scan starting now still sees the files
    hold.release();
    await removing;
    expect(await set.packs()).toEqual([]);
    expect(await set.has(Aid)).toBe(false);
  });

  it("remove() wins over a scan whose open succeeds while the removal is in progress", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const r = await install(files, [{ kind: 3, data: A }]);
    // the scan is held inside openPack, reading the idx (after the signature); remove() is held
    // before it deletes anything, so the open succeeds and only the check after it can drop the
    // pack (the scan began before remove(), so this is the removed-since-scan check)
    const opening = holdFirst((p) => p === paths(r.packId).idx);
    const read = files.read.bind(files);
    files.read = (path, o) =>
      (async function* () {
        await opening.maybeHold(path);
        yield* read(path, o);
      })();
    const deleting = holdFirst((p) => p === paths(r.packId).idx);
    const remove = files.remove.bind(files);
    files.remove = async (path) => {
      await deleting.maybeHold(path);
      return remove(path);
    };
    const scan = set.refresh();
    await opening.reached;
    const removing = set.remove([r.packId]);
    await deleting.reached;
    opening.release();
    await scan;
    deleting.release();
    await removing;
    expect(await set.packs()).toEqual([]);
    expect(set.skipped).toEqual([]);
  });

  it("a scan that joins an install's open adds the pack once", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const bytes = pack([{ kind: 3, data: A }]);
    const r = await installPack(files, PACK_DIR, chunks(bytes));
    // install's open is held; the scan then joins the same open; install resumes first
    const opening = holdFirst((p) => p === paths(r.packId).pack);
    const stats = files.stats.bind(files);
    files.stats = async (path) => {
      await opening.maybeHold(path);
      return stats(path);
    };
    const installed = set.install(chunks(bytes));
    await opening.reached;
    const scanChecked = deferred();
    let watch = true;
    const exists = files.exists.bind(files);
    files.exists = async (path) => {
      const found = await exists(path);
      if (watch && path === paths(r.packId).pack) {
        watch = false;
        scanChecked.resolve();
      }
      return found;
    };
    const scan = set.refresh();
    await scanChecked.promise;
    await new Promise((res) => setTimeout(res, 0)); // the scan's continuation joins the open
    opening.release();
    await Promise.all([installed, scan]);
    expect((await set.packs()).map((p) => p.packId)).toEqual([r.packId]);
  });
});

describe("re-review 2 of P2.3: freshen expiry and stale skips", () => {
  it("freshen re-checks a pack after at most a second, even with rescans turned off", async () => {
    const files = createInMemoryFilesApi();
    const r = await install(files, [{ kind: 3, data: A }]);
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    expect(await set.freshen(Aid)).toBe(true);
    await files.remove(paths(r.packId).idx);
    await files.remove(paths(r.packId).pack);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    try {
      expect(await set.freshen(Aid)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("drops a skipped entry once its pack is gone from the directory", async () => {
    const files = createInMemoryFilesApi();
    const set = await openPackSet(files, PACK_DIR, { rescanIntervalMs: Number.POSITIVE_INFINITY });
    const r = await install(files, [{ kind: 3, data: A }]);
    const exists = files.exists.bind(files);
    let fail = true;
    files.exists = async (path) => {
      if (fail && path === paths(r.packId).pack) throw new Error("EIO");
      return exists(path);
    };
    await set.refresh();
    expect(set.skipped.map((s) => s.pack)).toEqual([`pack-${r.packId}`]);
    fail = false;
    await files.remove(paths(r.packId).idx);
    await files.remove(paths(r.packId).pack);
    await set.refresh();
    expect(set.skipped).toEqual([]);
  });
});
