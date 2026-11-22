/**
 * The multi-pack-index chunk parser and encoder: round trips (duplicates, preferred pack, large
 * offsets, chains), git's refusals of damaged headers and tables of contents, and the files
 * helpers (load with a chain, clear).
 */
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import {
  badPackIntId,
  clearMultiPackIndex,
  clearMultiPackIndexNaming,
  cmpIdxOrPackName,
  encodeMultiPackIndex,
  loadMultiPackIndex,
  MAX_MIDX_CHAIN_LAYERS,
  type MidxPackSource,
  type MultiPackIndex,
  MultiPackIndexError,
  multiPackIndexBitmapPack,
  parseMultiPackIndex,
} from "../../src/pack/index.js";

const id = (n: number, first = n & 0xff) =>
  first.toString(16).padStart(2, "0") + n.toString(16).padStart(38, "0");

function pack(name: string, ids: string[], mtime: number, offsets?: number[]): MidxPackSource {
  const sorted = [...ids].sort();
  return {
    name,
    mtime,
    count: sorted.length,
    idAt: (i) => sorted[i] as string,
    offsetAt: (i) =>
      offsets?.[ids.indexOf(sorted[i] as string)] ?? 12 + 100 * ids.indexOf(sorted[i] as string),
  };
}

const packA = pack("pack-aaaa.idx", [id(1), id(2), id(3)], 100);
const packB = pack("pack-bbbb.idx", [id(3), id(4)], 200);

/** rewrites the trailing checksum after a test damaged the bytes */
function resum(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out.set(
    createSha1()
      .update(out.subarray(0, out.length - 20))
      .digest(),
    out.length - 20,
  );
  return out;
}

describe("encodeMultiPackIndex and parseMultiPackIndex", () => {
  it("round-trips: duplicates go to the newest pack, packs in name order", () => {
    const e = encodeMultiPackIndex({ packs: [packB, packA] });
    const m = parseMultiPackIndex(e.bytes, "midx");
    expect(m.version).toBe(1);
    expect(m.packNames).toEqual(["pack-aaaa.idx", "pack-bbbb.idx"]);
    expect(m.numObjects).toBe(4);
    expect(m.checksumValid()).toBe(true);
    expect(m.checksum).toBe(e.checksum);
    const pos = m.find(id(3));
    expect(m.idAt(pos)).toBe(id(3));
    expect(m.packNameAt(m.packIntIdAt(pos))).toBe("pack-bbbb.idx"); // mtime 200 > 100
    expect(m.offsetAt(pos)).toBe(12);
    expect(m.find(id(9))).toBe(-1);
    expect(m.find("zz")).toBe(-1);
    expect(m.revIndex).toBeUndefined();
    expect(m.containsPack("pack-aaaa.pack")).toBe(true);
    expect(m.containsPack("pack-aaaa.idx")).toBe(true);
    expect(m.containsPack("pack-cccc.pack")).toBe(false);
  });

  it("a preferred pack wins duplicates and comes first in the pseudo-pack order", () => {
    const e = encodeMultiPackIndex({
      packs: [packA, packB],
      preferred: 0,
      revIndex: true,
      bitmappedPacks: true,
    });
    const m = parseMultiPackIndex(e.bytes, "midx");
    expect(m.packNameAt(m.packIntIdAt(m.find(id(3))))).toBe("pack-aaaa.idx");
    expect(m.revIndex?.length).toBe(4);
    // the preferred pack's three objects first, in offset order, then pack b's one
    const order = [...(m.revIndex ?? [])].map((p) => m.idAt(p));
    expect(order).toEqual([id(1), id(2), id(3), id(4)]);
    expect(m.bitmappedPacks).toEqual([
      { pos: 0, nr: 3 },
      { pos: 3, nr: 1 },
    ]);
  });

  it("offsets past 2^32 go to LOFF (and those past 2^31 with them)", () => {
    const big = pack("pack-cccc.idx", [id(5), id(6), id(7)], 1, [12, 2 ** 31 + 5, 2 ** 33 + 7]);
    const m = parseMultiPackIndex(encodeMultiPackIndex({ packs: [big] }).bytes, "midx");
    expect(m.offsetAt(m.find(id(5)))).toBe(12);
    expect(m.offsetAt(m.find(id(6)))).toBe(2 ** 31 + 5);
    expect(m.offsetAt(m.find(id(7)))).toBe(2 ** 33 + 7);
    // below 2^32 alone, no LOFF: offsets past 2^31 stay 32-bit
    const mid = pack("pack-dddd.idx", [id(8)], 1, [2 ** 31 + 1]);
    const m2 = parseMultiPackIndex(encodeMultiPackIndex({ packs: [mid] }).bytes, "midx");
    expect(m2.offsetAt(0)).toBe(2 ** 31 + 1);
  });

  it("dropped packs are left out; nothing to index is git's error", () => {
    const e = encodeMultiPackIndex({
      packs: [packA, pack("pack-eeee.idx", [], 1)],
      dropped: new Set([1]),
    });
    expect(parseMultiPackIndex(e.bytes, "m").packNames).toEqual(["pack-aaaa.idx"]);
    expect(() => encodeMultiPackIndex({ packs: [] })).toThrow("no pack files to index.");
  });

  it("refuses damaged files with git's messages", () => {
    const good = encodeMultiPackIndex({ packs: [packA, packB] }).bytes;
    const refuse = (bytes: Uint8Array) => {
      try {
        parseMultiPackIndex(bytes, "m");
      } catch (e) {
        expect(e).toBeInstanceOf(MultiPackIndexError);
        return (e as MultiPackIndexError).lines;
      }
      throw new Error("accepted");
    };
    expect(refuse(good.subarray(0, 20))).toEqual(["error: multi-pack-index file m is too small"]);
    const sig = Uint8Array.from(good);
    sig[3] = 0x59;
    expect(refuse(sig)).toEqual([
      "fatal: multi-pack-index signature 0x4d494459 does not match signature 0x4d494458",
    ]);
    const ver = Uint8Array.from(good);
    ver[4] = 3;
    expect(refuse(ver)).toEqual(["fatal: multi-pack-index version 3 not recognized"]);
    const hash = Uint8Array.from(good);
    hash[5] = 2;
    expect(refuse(hash)).toEqual([
      "error: multi-pack-index hash version 2 does not match version 1",
    ]);
    // the first TOC entry: PNAM at 12 + 5 * 12 = 72
    const misaligned = Uint8Array.from(good);
    misaligned[12 + 11] += 1;
    expect(refuse(misaligned)).toEqual(["error: chunk id 504e414d not 4-byte aligned"]);
    const dup = Uint8Array.from(good);
    dup.set(dup.subarray(12, 16), 24); // OIDF renamed PNAM
    expect(refuse(dup)).toEqual(["error: duplicate chunk ID 504e414d found"]);
    const early = Uint8Array.from(good);
    early.fill(0, 24, 28);
    expect(refuse(early)).toEqual(["error: terminating chunk id appears earlier than expected"]);
    const finalId = Uint8Array.from(good);
    finalId[12 + 4 * 12] = 1;
    expect(refuse(finalId)).toEqual(["error: final chunk has non-zero id 1000000"]);
    const noPnam = Uint8Array.from(good);
    noPnam.set([0x58, 0x58, 0x58, 0x58], 12);
    expect(refuse(noPnam)).toEqual([
      "fatal: multi-pack-index required pack-name chunk missing or corrupted",
    ]);
    // pack names out of order (version 1)
    const swapped = Uint8Array.from(good);
    const at = 72;
    swapped.set(new TextEncoder().encode("pack-bbbb.idx\0pack-aaaa.idx\0"), at);
    expect(refuse(swapped)).toEqual([
      "fatal: multi-pack-index pack names out of order: 'pack-bbbb.idx' before 'pack-aaaa.idx'",
    ]);
    // a fanout out of order
    const fan = Uint8Array.from(good);
    const oidf = 72 + 28;
    fan.set([0, 0, 0, 9], oidf);
    expect(refuse(fan)).toEqual([
      "error: oid fanout out of order: fanout[0] = 9 > 1 = fanout[1]",
      "fatal: multi-pack-index required OID fanout chunk missing or corrupted",
    ]);
    // a damaged id byte parses, but the checksum check catches it
    const flipped = Uint8Array.from(good);
    flipped[good.length - 30] ^= 1;
    expect(parseMultiPackIndex(flipped, "m").checksumValid()).toBe(false);
    expect(parseMultiPackIndex(resum(flipped), "m").checksumValid()).toBe(true);
  });

  it("cmpIdxOrPackName matches foo.pack and foo.idx against foo.idx", () => {
    expect(cmpIdxOrPackName("pack-1.pack", "pack-1.idx")).toBe(0);
    expect(cmpIdxOrPackName("pack-1.idx", "pack-1.idx")).toBe(0);
    expect(cmpIdxOrPackName("pack-0.pack", "pack-1.idx")).toBeLessThan(0);
    expect(cmpIdxOrPackName("pack-2.idx", "pack-1.idx")).toBeGreaterThan(0);
  });
});

describe("midx files", () => {
  it("loads an incremental chain, layer positions following their base", async () => {
    const files = createInMemoryFilesApi();
    const dir = "/objects/pack";
    const layer1 = encodeMultiPackIndex({ packs: [packA] });
    const c = pack("pack-cccc.idx", [id(10), id(11)], 300);
    const layer2 = encodeMultiPackIndex({ packs: [c] });
    await files.write(`${dir}/multi-pack-index.d/multi-pack-index-${layer1.checksum}.midx`, [
      layer1.bytes,
    ]);
    await files.write(`${dir}/multi-pack-index.d/multi-pack-index-${layer2.checksum}.midx`, [
      layer2.bytes,
    ]);
    await files.write(`${dir}/multi-pack-index.d/multi-pack-index-chain`, [
      new TextEncoder().encode(`${layer1.checksum}\n${layer2.checksum}\n`),
    ]);
    const loaded = await loadMultiPackIndex(files, dir);
    expect(loaded.errors).toEqual([]);
    const m = loaded.midx;
    expect(m?.numPacksInBase).toBe(1);
    expect(m?.numObjectsInBase).toBe(3);
    expect(m?.find(id(2))).toBe(1);
    expect(m?.find(id(11))).toBe(4);
    expect(m?.packNameAt(m.packIntIdAt(4))).toBe("pack-cccc.idx");
    expect(m?.packNameAt(m.packIntIdAt(0))).toBe("pack-aaaa.idx");
    expect(m?.containsPack("pack-aaaa.pack")).toBe(true);

    // a layer missing: the chain so far, with git's warning
    await files.remove(`${dir}/multi-pack-index.d/multi-pack-index-${layer2.checksum}.midx`);
    const partial = await loadMultiPackIndex(files, dir);
    expect(partial.errors).toEqual(["warning: unable to find all multi-pack index files"]);
    expect(partial.midx?.numPacks).toBe(1);

    expect(await clearMultiPackIndexNaming(files, dir, ["pack-aaaa"])).toBe(true);
    expect(await files.exists(`${dir}/multi-pack-index.d/multi-pack-index-chain`)).toBe(false);
  });

  it("clears the midx with its bitmaps and reverse indexes only", async () => {
    const files = createInMemoryFilesApi();
    const dir = "/objects/pack";
    const e = encodeMultiPackIndex({ packs: [packA] });
    for (const name of [
      "multi-pack-index",
      `multi-pack-index-${e.checksum}.bitmap`,
      `multi-pack-index-${e.checksum}.rev`,
      "pack-aaaa.idx",
    ])
      await files.write(`${dir}/${name}`, [
        name === "multi-pack-index" ? e.bytes : new Uint8Array(1),
      ]);
    expect(await clearMultiPackIndexNaming(files, dir, ["pack-bbbb"])).toBe(false);
    await clearMultiPackIndex(files, dir);
    const left: string[] = [];
    for await (const f of files.list(dir)) left.push(f.name);
    expect(left).toEqual(["pack-aaaa.idx"]);
  });
});

/** the start of chunk `name` (4 ASCII letters) in a midx */
function chunkAt(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const want = [...name].reduce((v, ch) => v * 256 + ch.charCodeAt(0), 0);
  for (let k = 0; k < (bytes[6] as number); k++)
    if (view.getUint32(12 + 12 * k) === want) return view.getUint32(12 + 12 * k + 8);
  throw new Error(`no ${name} chunk`);
}

describe("crafted multi-pack-indexes (served repositories)", () => {
  it("refuses PNAM entries that are not plain pack-<hex>.idx names", async () => {
    for (const name of ["../x.idx", "../../../victim/pack-v.idx", "sub/pack-aaaa.idx"]) {
      const e = encodeMultiPackIndex({ packs: [pack(name, [id(1)], 1)] });
      expect(() => parseMultiPackIndex(e.bytes, "midx")).toThrow(MultiPackIndexError);
      const files = createInMemoryFilesApi();
      await files.write("/objects/pack/multi-pack-index", [e.bytes]);
      const loaded = await loadMultiPackIndex(files, "/objects/pack");
      expect(loaded.midx).toBeUndefined();
      expect(loaded.fatal).toBeUndefined();
      expect(loaded.errors).toEqual([
        `error: multi-pack-index pack name '${name}' is not a pack index name; ignoring /objects/pack/multi-pack-index`,
      ]);
    }
  });

  it("a 20,000-layer chain: lookups loop over the layers; the loader refuses it", async () => {
    const n = 20000;
    const files = createInMemoryFilesApi();
    const dir = "/objects/pack";
    const sums: string[] = [];
    let tip: MultiPackIndex | undefined;
    for (let i = 0; i < n; i++) {
      // empty layers but the first, each naming a pack of its own
      const e = encodeMultiPackIndex({
        packs: [pack(`pack-${i.toString(16).padStart(8, "0")}.idx`, i === 0 ? [id(7)] : [], i)],
      });
      sums.push(e.checksum);
      await files.write(`${dir}/multi-pack-index.d/multi-pack-index-${e.checksum}.midx`, [e.bytes]);
      tip = parseMultiPackIndex(e.bytes, `layer-${i}`, tip);
    }
    const m = tip as MultiPackIndex;
    expect(m.numPacksInBase).toBe(n - 1);
    expect(m.find(id(7))).toBe(0);
    expect(m.find(id(8))).toBe(-1);
    expect(m.containsPack("pack-00000000.pack")).toBe(true);
    expect(m.containsPack("pack-ffffffff.pack")).toBe(false);
    expect(m.packNameAt(m.packIntIdAt(0))).toBe("pack-00000000.idx");
    expect(badPackIntId(m)).toBeUndefined();

    await files.write(`${dir}/multi-pack-index.d/multi-pack-index-chain`, [
      new TextEncoder().encode(sums.map((s) => `${s}\n`).join("")),
    ]);
    const loaded = await loadMultiPackIndex(files, dir);
    expect(loaded.midx).toBeUndefined();
    expect(loaded.fatal).toBeUndefined();
    expect(loaded.errors).toEqual([
      `warning: multi-pack-index chain has too many layers (${n} > ${MAX_MIDX_CHAIN_LAYERS}); ignoring it`,
    ]);
  }, 60_000);

  it("refuses a midx bitmap over a RIDX that is no permutation or BTMP ranges that disagree", () => {
    const e = encodeMultiPackIndex({
      packs: [packA, packB],
      revIndex: true,
      bitmappedPacks: true,
    });
    const good = parseMultiPackIndex(e.bytes, "midx");
    expect(multiPackIndexBitmapPack(good).count).toBe(4);
    const craft = (edit: (view: DataView) => void) => {
      const out = Uint8Array.from(e.bytes);
      edit(new DataView(out.buffer));
      return parseMultiPackIndex(resum(out), "midx");
    };
    const ridx = chunkAt(e.bytes, "RIDX");
    const btmp = chunkAt(e.bytes, "BTMP");
    const bad = [
      craft((v) => v.setUint32(ridx + 4, v.getUint32(ridx))), // a duplicate
      craft((v) => v.setUint32(ridx, 1000)), // out of range (git: idAt() would be "")
      craft((v) => v.setUint32(btmp + 4, 1000)), // a range past the objects
      craft((v) => v.setUint32(btmp, 1)), // a range holding the other pack's objects
    ];
    for (const m of bad) expect(() => multiPackIndexBitmapPack(m)).toThrow(MultiPackIndexError);
  });

  it("badPackIntId names a pack-int-id past the packs, as git dies on it", () => {
    const e = encodeMultiPackIndex({ packs: [packA, packB] });
    const out = Uint8Array.from(e.bytes);
    new DataView(out.buffer).setUint32(chunkAt(out, "OOFF") + 8, 7);
    const m = parseMultiPackIndex(resum(out), "midx");
    expect(badPackIntId(m)).toBe("bad pack-int-id: 7 (2 total packs)");
    expect(badPackIntId(parseMultiPackIndex(e.bytes, "midx"))).toBeUndefined();
  });

  it("version 2: read by 2.5x, refused fatally as 2.43 refuses it", async () => {
    const e = encodeMultiPackIndex({ packs: [packA], version: 2 });
    const files = createInMemoryFilesApi();
    await files.write("/p/multi-pack-index", [e.bytes]);
    expect((await loadMultiPackIndex(files, "/p")).midx?.version).toBe(2);
    const old = await loadMultiPackIndex(files, "/p", { compatibility: "2.43" });
    expect(old.midx).toBeUndefined();
    expect(old.errors).toEqual(["fatal: multi-pack-index version 2 not recognized"]);
  });
});
