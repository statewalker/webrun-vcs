/**
 * The small-object read path of `openPack`: an entry is read from the pack window holding it
 * (one FilesApi read per 64 KiB window, none once the window is loaded), inflated in one pass
 * into its result, and handed out whole (`GitObject.bytes`); delta chains resolve through the
 * delta base cache. These tests count the work and check the results at the edges: objects at
 * the size thresholds, entries across window boundaries, chains of OFS and REF deltas, and
 * corrupt data.
 */
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../src/common/files/index.js";
import {
  installPack,
  openPack,
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
const WINDOW = 64 * 1024;
const WHOLE_MAX = 1024 * 1024;

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

const text = (n: number, tag: string) =>
  enc.encode(Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join(""));

/** Counts the FilesApi reads started on paths ending with `suffix`. */
function countReads(files: FilesApi, suffix: string): () => number {
  let n = 0;
  const read = files.read.bind(files);
  files.read = (path, o) => {
    if (path.endsWith(suffix)) n++;
    return read(path, o);
  };
  return () => n;
}

async function open(files: FilesApi, entries: Entry[]) {
  const built = buildPack(entries);
  const r = await installPack(files, PACK_DIR, chunks(built.bytes));
  const base = `${PACK_DIR}/pack-${r.packId}`;
  return {
    built,
    base,
    pack: (await openPack(files, `${base}.pack`, `${base}.idx`)) as PackFile,
  };
}

async function bytesOf(o: { content: AsyncIterable<Uint8Array> } | undefined) {
  if (!o) throw new Error("object not found");
  return collect(o.content);
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("openPack: small objects in one read", () => {
  it("reads a small object's window once, and no more for its neighbours", async () => {
    const files = createInMemoryFilesApi();
    const blobs = Array.from({ length: 20 }, (_, i) => text(10, `blob ${i}`));
    const { pack } = await open(
      files,
      blobs.map((data) => ({ kind: 3, data })),
    );
    const reads = countReads(files, ".pack");
    const first = await pack.get(oidOf("blob", blobs[0] as Uint8Array));
    expect(same(first?.bytes as Uint8Array, blobs[0] as Uint8Array)).toBe(true);
    expect(reads()).toBe(1); // the window
    for (const b of blobs) {
      const o = await pack.get(oidOf("blob", b));
      expect(o?.type).toBe("blob");
      expect(o?.size).toBe(b.length);
      expect(same(o?.bytes as Uint8Array, b)).toBe(true);
      expect(same(await bytesOf(o), b)).toBe(true); // `content` yields the same bytes
    }
    expect(reads()).toBe(1);
    expect(pack.stats.inflations).toBe(21);
  });

  it("hands out whole objects up to 1 MiB, streams larger ones, and never with verify", async () => {
    const files = createInMemoryFilesApi();
    const max = new Uint8Array(WHOLE_MAX).fill(97);
    max[0] = 120;
    const over = new Uint8Array(WHOLE_MAX + 1).fill(98);
    const small = text(3, "small");
    const { pack } = await open(files, [
      { kind: 3, data: max },
      { kind: 3, data: over },
      { kind: 3, data: small },
    ]);
    const m = await pack.get(oidOf("blob", max));
    expect(m?.bytes?.length).toBe(WHOLE_MAX);
    expect(same(m?.bytes as Uint8Array, max)).toBe(true);
    const o = await pack.get(oidOf("blob", over));
    expect(o?.bytes).toBeUndefined();
    let n = 0;
    let total = 0;
    for await (const c of o?.content ?? []) {
      n++;
      total += c.length;
    }
    expect(n).toBeGreaterThan(1);
    expect(total).toBe(WHOLE_MAX + 1);
    const v = await pack.get(oidOf("blob", small), { verify: true });
    expect(v?.bytes).toBeUndefined();
    expect(same(await bytesOf(v), small)).toBe(true);
  });

  it("reads entries that cross a window boundary, or start just before one", async () => {
    // a filler entry ends `gap` bytes before the window boundary, then small entries follow
    for (const gap of [1, 10, 30, 63, 64, 65, 100, 700, 2000]) {
      const files = createInMemoryFilesApi();
      const follow = Array.from({ length: 6 }, (_, i) => text(40 + i * 7, `gap ${gap} ${i}`));
      // the filler's compressed size is about its length: aim its end at the boundary
      let fill = WINDOW - 12 - gap - 40;
      let built = buildPack([{ kind: 3, data: noise(fill, gap) }]);
      for (let k = 0; k < 4; k++) {
        const end = built.ends[0] as number;
        fill += WINDOW - gap - end;
        built = buildPack([{ kind: 3, data: noise(fill, gap) }]);
      }
      expect(WINDOW - (built.ends[0] as number)).toBe(gap);
      const entries: Entry[] = [
        { kind: 3, data: noise(fill, gap) },
        ...follow.map((data) => ({ kind: 3, data })),
      ];
      const { pack } = await open(files, entries);
      for (const b of follow) {
        const o = await pack.get(oidOf("blob", b));
        expect(same(o?.bytes as Uint8Array, b), `gap ${gap}`).toBe(true);
      }
      expect(
        same(
          (await pack.get(oidOf("blob", noise(fill, gap))))?.bytes as Uint8Array,
          noise(fill, gap),
        ),
      ).toBe(true);
    }
  });
});

describe("openPack: delta chains", () => {
  const A = text(30, "base A");
  const { data: B, d: dAB } = extend(A, "plus B\n");
  const { data: C, d: dBC } = extend(B, "plus C\n");
  const { data: D, d: dCD } = extend(C, "plus D\n");

  it("resolves deltas of deltas, OFS and REF mixed, and serves its bases from the base cache", async () => {
    const files = createInMemoryFilesApi();
    const { pack } = await open(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
      { kind: 7, data: dBC, baseOid: oidOf("blob", B) },
      { kind: 6, data: dCD, baseIdx: 2 },
    ]);
    const d = await pack.get(oidOf("blob", D));
    expect(d?.type).toBe("blob");
    expect(same(d?.bytes as Uint8Array, D)).toBe(true);
    expect(pack.stats.inflations).toBe(4); // the base and three deltas
    // asked again: as git, the object asked for was handed over, not cached; its base C was,
    // so one delta is applied
    const again = await pack.get(oidOf("blob", D));
    expect(pack.stats.inflations).toBe(5);
    expect(same(again?.bytes as Uint8Array, D)).toBe(true);
    again?.bytes?.fill(0);
    expect(same((await pack.get(oidOf("blob", D)))?.bytes as Uint8Array, D)).toBe(true);
    // C, a base on the way, is served from the cache (copied: zeroing it changes nothing)
    const before = pack.stats.inflations;
    const c = await pack.get(oidOf("blob", C));
    expect(same(c?.bytes as Uint8Array, C)).toBe(true);
    expect(pack.stats.inflations - before).toBe(0);
    c?.bytes?.fill(0);
    expect(same((await pack.get(oidOf("blob", D)))?.bytes as Uint8Array, D)).toBe(true);
    for (const [data, id] of [
      [A, oidOf("blob", A)],
      [B, oidOf("blob", B)],
    ] as const) {
      expect(same(await bytesOf(await pack.get(id, { verify: true })), data)).toBe(true);
    }
  });

  it("resolves a 60-deep chain whose deltas sit across window boundaries", async () => {
    const files = createInMemoryFilesApi();
    const base = noise(20_000, 9);
    const entries: Entry[] = [{ kind: 3, data: base }];
    const results: Uint8Array[] = [base];
    for (let i = 0; i < 60; i++) {
      const prev = results[i] as Uint8Array;
      const tail = noise(1500, 100 + i); // incompressible: the entries spread over windows
      const next = new Uint8Array(prev.length + tail.length);
      next.set(prev);
      next.set(tail, prev.length);
      results.push(next);
      entries.push({
        kind: 6,
        data: delta(prev.length, next.length, [
          ...copyAll(prev.length),
          ...Array.from({ length: Math.ceil(tail.length / 127) }, (_, k) => {
            const part = tail.subarray(k * 127, (k + 1) * 127);
            return [part.length, ...part];
          }).flat(),
        ]),
        baseIdx: i,
      });
    }
    const { pack } = await open(files, entries);
    const top = results[60] as Uint8Array;
    const o = await pack.get(oidOf("blob", top));
    expect(o?.size).toBe(top.length);
    expect(same(await bytesOf(o), top)).toBe(true);
    expect(
      same(
        await bytesOf(await pack.get(oidOf("blob", results[31] as Uint8Array), { verify: true })),
        results[31] as Uint8Array,
      ),
    ).toBe(true);
  });
});

describe("openPack: corrupt small entries", () => {
  /** the pack's bytes with the entry `i`'s compressed data changed by `damage` */
  async function damaged(entries: Entry[], i: number, damage: (entry: Uint8Array) => void) {
    const files = createInMemoryFilesApi();
    const { built, base } = await open(files, entries);
    const bytes = built.bytes.slice();
    damage(bytes.subarray((built.offsets[i] as number) + 3, built.ends[i]));
    await files.write(`${base}.pack`, [bytes]);
    return (await openPack(files, `${base}.pack`, `${base}.idx`)) as PackFile;
  }

  it("a broken whole object fails its content with PackError (the lookup itself succeeds)", async () => {
    const data = text(50, "whole");
    const pack = await damaged([{ kind: 3, data }], 0, (e) => {
      e[10] = (e[10] as number) ^ 0x55;
    });
    const o = await pack.get(oidOf("blob", data));
    expect(o?.bytes).toBeUndefined();
    await expect(bytesOf(o)).rejects.toBeInstanceOf(PackError);
  });

  it("sizes that disagree with the data fail with PackError", async () => {
    const data = text(20, "sized");
    for (const [sizeOverride, message] of [
      [data.length + 1, /truncated or corrupt/],
      [data.length - 1, /inflates past/],
    ] as const) {
      // written directly: installPack refuses such a pack
      const files = createInMemoryFilesApi();
      const built = buildPack([{ kind: 3, data, sizeOverride }]);
      const checksum = built.bytes.subarray(built.bytes.length - 20);
      const id = "1".repeat(40);
      const idx = writePackIdx(
        [{ id, offset: 12, crc32: crc32(built.bytes.subarray(12, built.ends[0])) }],
        checksum,
      );
      const base = `${PACK_DIR}/pack-${bytesToHex(checksum)}`;
      await files.write(`${base}.pack`, [built.bytes]);
      await files.write(`${base}.idx`, [idx]);
      const pack = await openPack(files, `${base}.pack`, `${base}.idx`);
      await expect(bytesOf(await pack.get(id))).rejects.toThrow(message);
    }
  });

  it("a broken delta fails get() with PackError", async () => {
    const A = text(30, "base");
    const { data: B, d } = extend(A, "more\n");
    const pack = await damaged(
      [
        { kind: 3, data: A },
        { kind: 6, data: d, baseIdx: 0 },
      ],
      1,
      (e) => {
        e[e.length - 6] = (e[e.length - 6] as number) ^ 0xff;
      },
    );
    await expect(pack.get(oidOf("blob", B))).rejects.toBeInstanceOf(PackError);
  });

  it("an entry whose zlib stream is cut short fails, also at the end of the pack", async () => {
    const data = text(40, "cut");
    const pack = await damaged([{ kind: 3, data }], 0, (e) => {
      // a stored-looking garbage tail: the stream cannot end where it should
      e.fill(0, Math.floor(e.length / 2));
    });
    await expect(bytesOf(await pack.get(oidOf("blob", data)))).rejects.toBeInstanceOf(PackError);
  });
});

describe("openPack: getNow, without a promise when nothing is read", () => {
  it("answers with a promise before the window is loaded and with the object after", async () => {
    const files = createInMemoryFilesApi();
    const blobs = Array.from({ length: 5 }, (_, i) => text(20, `now ${i}`));
    const base = text(200, "now base");
    const { data: top, d: topDelta } = extend(base, "now tail\n");
    const { pack } = await open(files, [
      ...blobs.map((data) => ({ kind: 3, data })),
      { kind: 3, data: base },
      { kind: 6, data: topDelta, baseIdx: 5 },
    ]);
    const first = pack.getNow(oidOf("blob", blobs[0] as Uint8Array));
    expect(first).toBeInstanceOf(Promise);
    expect(same((await first)?.bytes as Uint8Array, blobs[0] as Uint8Array)).toBe(true);
    for (const b of blobs) {
      const o = pack.getNow(oidOf("blob", b));
      expect(o).not.toBeInstanceOf(Promise);
      expect(same((o as { bytes: Uint8Array }).bytes, b)).toBe(true);
    }
    // a delta whose chain is in the loaded window resolves at once too
    const resolved = pack.getNow(oidOf("blob", top));
    expect(resolved).not.toBeInstanceOf(Promise);
    expect(same((resolved as { bytes: Uint8Array }).bytes, top)).toBe(true);
    expect(pack.getNow(oidOf("blob", text(1, "absent")))).toBeUndefined();
    // `get` gives the same objects, as promises
    expect(same((await pack.get(oidOf("blob", top)))?.bytes as Uint8Array, top)).toBe(true);
  });
});

describe("openPack: header, the type and size from the entry headers", () => {
  const A = text(30, "head A");
  const { data: B, d: dAB } = extend(A, "plus B\n");
  const { data: C, d: dBC } = extend(B, "plus C\n");
  const { data: D, d: dCD } = extend(C, "plus D\n");
  const tree = enc.encode("100644 a\0aaaaaaaaaaaaaaaaaaaa");

  it("answers as `get` for whole entries and OFS/REF chains, without resolving them", async () => {
    const files = createInMemoryFilesApi();
    const { pack } = await open(files, [
      { kind: 3, data: A },
      { kind: 6, data: dAB, baseIdx: 0 },
      { kind: 7, data: dBC, baseOid: oidOf("blob", B) },
      { kind: 6, data: dCD, baseIdx: 2 },
      { kind: 2, data: tree },
    ]);
    const header = pack.header?.bind(pack);
    expect(header).toBeDefined();
    for (const [type, data] of [
      ["blob", A],
      ["blob", B],
      ["blob", C],
      ["blob", D],
      ["tree", tree],
    ] as const) {
      expect(await header?.(oidOf(type, data))).toEqual({ type, size: data.length });
    }
    for (const [type, data] of [
      ["blob", D],
      ["tree", tree],
    ] as const) {
      expect(await pack.objectType?.(oidOf(type, data))).toBe(type);
    }
    expect(await pack.objectType?.(oidOf("blob", text(1, "absent")))).toBeUndefined();
    // headers only: no delta was applied, nothing was cached
    expect(pack.stats.inflations).toBe(0);
    expect(pack.stats.cachedBytes).toBe(0);
    expect(await header?.(oidOf("blob", text(1, "absent")))).toBeUndefined();
    // with the chain's bases cached (by a read), the answers stay the same
    await pack.get(oidOf("blob", D));
    for (const data of [B, C, D]) {
      expect(await header?.(oidOf("blob", data))).toEqual({ type: "blob", size: data.length });
    }
  });

  it("leaves a REF_DELTA whose base is outside the pack to `get`", async () => {
    const files = createInMemoryFilesApi();
    const outside = text(10, "outside");
    const { data: top, d } = extend(outside, "top\n");
    const built = buildPack([{ kind: 7, data: d, baseOid: oidOf("blob", outside) }]);
    const base = `${PACK_DIR}/pack-thin`;
    await files.write(`${base}.pack`, [built.bytes]);
    const entry = built.bytes.subarray(built.offsets[0] as number, built.ends[0] as number);
    const idx = writePackIdx(
      [{ id: oidOf("blob", top), offset: built.offsets[0] as number, crc32: crc32(entry) }],
      built.bytes.subarray(built.bytes.length - 20),
    );
    await files.write(`${base}.idx`, [idx]);
    const pack = (await openPack(files, `${base}.pack`, `${base}.idx`)) as PackFile;
    expect(await pack.header?.(oidOf("blob", top))).toBeUndefined();
  });
});
