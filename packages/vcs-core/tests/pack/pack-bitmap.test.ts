/**
 * Pack reachability bitmaps: EWAH as git lays it out, the writer read back by the reader, and
 * the property that enumerating through a bitmap gives exactly the walk's object set, over
 * random histories (merges, equal dates, shared trees, tags, objects outside the bitmapped
 * pack).
 */
import { EwahBitmap, RawBitmap } from "@statewalker/vcs-utils";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import type { GitObjects } from "../../src/history/objects/git-objects.js";
import {
  bitmapFilterOf,
  bitmapWalk,
  listObjects,
  openPackSet,
  PackBitmapError,
  type PackFile,
  parsePackBitmap,
  writePack,
  writePackBitmap,
} from "../../src/pack/index.js";
import { parseObjectFilter } from "../../src/pack/object-filter/index.js";
import { blob, commit, memObjects, tag, tree } from "./history-builder.js";

/** A small seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface History {
  objects: GitObjects;
  commits: string[];
  tags: string[];
}

/** A random history of `n` commits: merges, roots, equal dates, shared subtrees, tags. */
async function randomHistory(seed: number, n: number): Promise<History> {
  const r = rng(seed);
  const objects = memObjects();
  const commits: string[] = [];
  const tags: string[] = [];
  const shared = await tree(objects, [["100644", "same.txt", await blob(objects, "shared\n")]]);
  let time = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const files: [string, string, string][] = [];
    const nf = 1 + Math.floor(r() * 4);
    for (let f = 0; f < nf; f++)
      files.push(["100644", `f${f}.txt`, await blob(objects, `c${Math.floor(r() * n)}-${f}\n`)]);
    if (r() < 0.5) files.push(["40000", "lib", shared]);
    if (r() < 0.3) {
      const sub = await tree(objects, [["100644", "x", await blob(objects, `sub${i % 7}\n`)]]);
      files.push(["40000", "dir", sub]);
    }
    if (r() < 0.1) files.push(["160000", "module", "1".repeat(40)]);
    const t = await tree(objects, files);
    const parents: string[] = [];
    if (commits.length > 0 && r() > 0.05) {
      parents.push(
        commits[commits.length - 1 - Math.floor(r() * Math.min(3, commits.length))] as string,
      );
      if (r() < 0.2 && commits.length > 2) {
        const other = commits[Math.floor(r() * commits.length)] as string;
        if (!parents.includes(other)) parents.push(other);
      }
    }
    // equal dates now and then, and a clock going back
    time += r() < 0.2 ? 0 : r() < 0.05 ? -50 : 60;
    commits.push(await commit(objects, t, parents, time, `m${i}`));
    if (r() < 0.1) tags.push(await tag(objects, commits[i] as string, "commit", `v${i}`));
  }
  return { objects, commits, tags };
}

async function setOf(it: AsyncIterable<{ id: string }>): Promise<Set<string>> {
  const s = new Set<string>();
  for await (const o of it) s.add(o.id);
  return s;
}

/** Packs what `tips` reach into an in-memory pack set and writes its bitmap. */
async function bitmapped(h: History, tips: string[], options: { lookupTable?: boolean } = {}) {
  const listed = [];
  for await (const o of listObjects(h.objects, { wants: tips })) listed.push(o);
  const files = createInMemoryFilesApi();
  const packs = await openPackSet(files, "/pack");
  const installed = await packs.install(writePack(h.objects, listed));
  const pack = (await packs.packs()).find((p) => p.packId === installed.packId) as PackFile;
  const bytes = await writePackBitmap({ pack, objects: h.objects, listed, ...options });
  await files.write(`/pack/pack-${pack.packId}.bitmap`, [bytes]);
  const index = await packs.bitmap?.();
  if (!index) throw new Error("bitmap not loaded");
  return { pack, bytes, index, listed, packs, files };
}

describe("EwahBitmap", () => {
  it("lays out set bits and words as git does", () => {
    // the commit type bitmap of a 15-object pack, as git 2.43 wrote it
    const e = new EwahBitmap();
    for (const b of [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) e.set(b);
    const out: number[] = [];
    e.serialize(out);
    expect(Buffer.from(out).toString("hex")).toBe(
      "0000000f" + "00000002" + "0000000200000000" + "0000000000007fef" + "00000000",
    );
    expect([...e.bits()]).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const back = EwahBitmap.read(Uint8Array.from(out), 0, out.length);
    expect(back?.bitmap.popcount()).toBe(14);
  });

  it("turns a full word into a run, and XORs as the bit sets do", () => {
    const r = rng(7);
    for (let round = 0; round < 50; round++) {
      const a = new RawBitmap();
      const b = new RawBitmap();
      const bits = 64 * (1 + Math.floor(r() * 20));
      for (let i = 0; i < bits; i++) {
        // long runs of ones and zeros, and noise
        const zone = Math.floor(i / 128) % 3;
        if (zone === 0 ? r() < 0.97 : zone === 1 ? r() < 0.02 : r() < 0.5) a.set(i);
        if (zone === 2 ? r() < 0.97 : r() < 0.3) b.set(i);
      }
      const ea = a.toEwah();
      const eb = b.toEwah();
      expect(ea.isWellFormed()).toBe(true);
      const x = EwahBitmap.xor(ea, eb);
      const want = new Set<number>();
      a.forEach((p) => {
        if (!b.get(p)) want.add(p);
      });
      b.forEach((p) => {
        if (!a.get(p)) want.add(p);
      });
      expect(new Set(x.bits())).toEqual(want);
      // XOR back gives the original
      expect([...EwahBitmap.xor(x, eb).bits()]).toEqual([...ea.bits()]);
      // ewah_set builds the same bits
      const s = new EwahBitmap();
      a.forEach((p) => {
        s.set(p);
      });
      expect([...s.bits()]).toEqual([...ea.bits()]);
    }
  });
});

describe("pack bitmaps", () => {
  it("reads back what the writer wrote, every selected commit's reach", async () => {
    const h = await randomHistory(1, 40);
    const tips = [h.commits[h.commits.length - 1] as string, ...h.tags];
    const { index, pack } = await bitmapped(h, tips, { lookupTable: true });
    expect(index.entries.length).toBeGreaterThan(0);
    for (const e of index.entries) {
      const reach = await setOf(listObjects(h.objects, { wants: [e.id] }));
      const bits = index.bitmapFor(e.id);
      const ids = new Set([...(bits?.bits() ?? [])].map((p) => index.idAt(p)));
      expect(ids).toEqual(reach);
    }
    expect(index.count).toBe(pack.count);
  });

  it("selects every commit below 100 and a spread above it", async () => {
    const h = await randomHistory(2, 260);
    const { index } = await bitmapped(h, h.commits);
    expect(index.entries.length).toBeGreaterThan(100);
    expect(index.entries.length).toBeLessThan(260);
  });

  it("enumerates exactly the walk's objects (property over random histories)", async () => {
    for (let seed = 10; seed < 22; seed++) {
      const r = rng(seed * 31);
      const n = 20 + Math.floor(r() * 140);
      const h = await randomHistory(seed, n);
      // the pack holds a prefix of the history: later commits are outside it (extended index)
      const cut = Math.floor(n * (0.5 + r() * 0.5));
      const packTips = [h.commits[cut - 1] as string, ...h.tags.slice(0, 1)];
      const { index } = await bitmapped(h, packTips);
      for (let q = 0; q < 6; q++) {
        const pick = () => h.commits[Math.floor(r() * h.commits.length)] as string;
        const wants = [pick(), ...(r() < 0.5 ? [pick()] : []), ...(r() < 0.3 ? h.tags : [])];
        const haves = q % 2 === 0 ? [] : [pick(), ...(r() < 0.3 ? [pick()] : [])];
        const got = await bitmapWalk(index, h.objects, { wants, haves });
        const ids = new Set([...got.objects()].map((o) => o.id));
        expect(ids.size).toBe(got.count);
        const reach = await setOf(listObjects(h.objects, { wants }));
        if (haves.length === 0) {
          expect(ids).toEqual(reach);
          // and through listObjects' bitmap option
          expect(await setOf(listObjects(h.objects, { wants, bitmap: index }))).toEqual(reach);
        } else {
          const theirs = await setOf(listObjects(h.objects, { wants: haves }));
          const exact = new Set([...reach].filter((id) => !theirs.has(id)));
          expect(ids).toEqual(exact);
          // the walk marks only boundary trees uninteresting: it may list more, never less
          const walked = await setOf(listObjects(h.objects, { wants, haves }));
          for (const id of ids) expect(walked.has(id)).toBe(true);
        }
      }
    }
  });

  it("applies the filters git's bitmaps support", async () => {
    const h = await randomHistory(5, 30);
    const tip = h.commits[h.commits.length - 1] as string;
    const { index } = await bitmapped(h, [tip]);
    const all = [...(await bitmapWalk(index, h.objects, { wants: [tip] })).objects()];
    const run = async (spec: string) => {
      const filter = bitmapFilterOf(spec);
      if (!filter) throw new Error(spec);
      return [...(await bitmapWalk(index, h.objects, { wants: [tip], filter })).objects()];
    };
    expect(await run("blob:none")).toEqual(all.filter((o) => o.type !== "blob"));
    expect(await run("tree:0")).toEqual(all.filter((o) => o.type === "commit" || o.type === "tag"));
    // the wants stay, whatever their type (git keeps the tips)
    expect(await run("object:type=tree")).toEqual(
      all.filter((o) => o.type === "tree" || o.id === tip),
    );
    expect(bitmapFilterOf("blob:limit=10")).toBeUndefined();
  });

  it("refuses corrupt files with git's messages", async () => {
    const h = await randomHistory(3, 12);
    const { bytes, pack } = await bitmapped(h, [h.commits[11] as string]);
    const refuse = (b: Uint8Array) => {
      try {
        parsePackBitmap(b, pack, "x.bitmap");
      } catch (e) {
        expect(e).toBeInstanceOf(PackBitmapError);
        return (e as Error).message;
      }
      return "accepted";
    };
    const header = bytes.slice();
    header[0] = 0x58;
    expect(refuse(header)).toBe("corrupted bitmap index file (wrong header)");
    const flipped = bytes.slice();
    flipped[60] = (flipped[60] as number) ^ 0xff;
    expect(refuse(flipped)).toBe("bitmap file 'x.bitmap' has invalid checksum");
    expect(refuse(bytes.subarray(0, 40))).toBe("corrupted bitmap index (too small)");
    expect(refuse(bytes)).toBe("accepted");
  });
});

/**
 * A bitmap file with each entry's stored EWAH replaced by `fn`'s, the checksum recomputed (so
 * only the content is crafted).
 */
function rewriteEntries(
  bytes: Uint8Array,
  fn: (stored: EwahBitmap, i: number, xorOffset: number) => Uint8Array,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(8);
  const end = bytes.length - 20;
  let pos = 32;
  for (let k = 0; k < 4; k++) pos = (EwahBitmap.read(bytes, pos, end) as { next: number }).next;
  const parts: Uint8Array[] = [bytes.subarray(0, pos)];
  for (let i = 0; i < entryCount; i++) {
    const r = EwahBitmap.read(bytes, pos + 6, end) as { bitmap: EwahBitmap; next: number };
    parts.push(bytes.subarray(pos, pos + 6), fn(r.bitmap, i, bytes[pos + 4] as number));
    pos = r.next;
  }
  parts.push(bytes.subarray(pos, end));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  const out = new Uint8Array(body.length + 20);
  out.set(body);
  out.set(createSha1().update(body).digest(), body.length);
  return out;
}

/** An EWAH buffer as git serializes it: bit size, word count, words (as given), RLW position. */
function rawEwah(bitSize: number, words: [hi: number, lo: number][]): Uint8Array {
  const out = new Uint8Array(12 + words.length * 8);
  const v = new DataView(out.buffer);
  v.setUint32(0, bitSize >>> 0);
  v.setUint32(4, words.length);
  words.forEach(([hi, lo], i) => {
    v.setUint32(8 + i * 8, hi >>> 0);
    v.setUint32(12 + i * 8, lo >>> 0);
  });
  v.setUint32(8 + words.length * 8, 0);
  return out;
}

const serialized = (b: EwahBitmap) => {
  const out = new Uint8Array(b.serializedSize);
  b.writeTo(out, 0);
  return out;
};

describe("crafted bitmaps (served repositories)", () => {
  async function smallBitmap() {
    const h = await randomHistory(3, 12);
    return { h, ...(await bitmapped(h, [h.commits[11] as string])) };
  }
  const refusal = (b: Uint8Array, pack: PackFile) => {
    try {
      parsePackBitmap(b, pack, "x.bitmap");
    } catch (e) {
      expect(e).toBeInstanceOf(PackBitmapError);
      return (e as Error).message;
    }
    return "accepted";
  };

  it("refuses a run longer than the pack, before expanding it", async () => {
    const { bytes, pack } = await smallBitmap();
    // one RLW: running bit 1, running length 2^32 - 1 (git's RLW_RUNNING_BITS), no literals
    const huge = rewriteEntries(bytes, (stored, i) =>
      i === 0 ? rawEwah(64, [[0x1, 0xffffffff]]) : serialized(stored),
    );
    const started = Date.now();
    expect(refusal(huge, pack)).toBe("corrupted bitmap index file (bitmap larger than its pack)");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses a bit size larger than the pack", async () => {
    const { bytes, pack } = await smallBitmap();
    const big = rewriteEntries(bytes, (stored, i) =>
      i === 0 ? rawEwah(0xffffffff, [[0, 2]]) : serialized(stored),
    );
    expect(refusal(big, pack)).toBe("corrupted bitmap index file (bitmap larger than its pack)");
  });

  it("falls back to the walk with an error line when the pack set opens one", async () => {
    const { bytes, packs, files, pack, h } = await smallBitmap();
    const huge = rewriteEntries(bytes, (stored, i) =>
      i === 0 ? rawEwah(64, [[0x1, 0xffffffff]]) : serialized(stored),
    );
    await files.write(`/pack/pack-${pack.packId}.bitmap`, [huge]);
    await packs.refresh();
    const reopened = await openPackSet(files, "/pack");
    expect(await reopened.bitmap?.()).toBeUndefined();
    expect(reopened.bitmapErrors).toEqual([
      "error: corrupted bitmap index file (bitmap larger than its pack)",
    ]);
    const tip = h.commits[11] as string;
    expect(
      await setOf(listObjects(h.objects, { wants: [tip], bitmap: await reopened.bitmap?.() })),
    ).toEqual(await setOf(listObjects(h.objects, { wants: [tip] })));
  });

  it("ignores stray bits at or above the pack's count, extended objects included", async () => {
    // a history whose packed prefix does not fill its last bitmap word
    let seed = 40;
    let found: { h: History; cut: number; built: Awaited<ReturnType<typeof bitmapped>> };
    for (;;) {
      const h = await randomHistory(seed++, 30);
      const cut = 20;
      const built = await bitmapped(h, [h.commits[cut - 1] as string]);
      if (built.pack.count % 64 !== 0 && built.pack.count % 64 < 60) {
        found = { h, cut, built };
        break;
      }
    }
    const { h, built } = found;
    const count = built.pack.count;
    const stray = rewriteEntries(built.bytes, (stored, _i, xorOffset) => {
      if (xorOffset !== 0) return serialized(stored);
      const raw = RawBitmap.fromEwah(stored);
      for (let b = count; b < Math.ceil(count / 64) * 64; b++) raw.set(b);
      return serialized(raw.toEwah());
    });
    const index = parsePackBitmap(stray, built.pack, "x.bitmap");
    // commits after the packed prefix get extended positions from `count` on
    const wants = [h.commits[h.commits.length - 1] as string];
    const got = await bitmapWalk(index, h.objects, { wants });
    const ids = new Set([...got.objects()].map((o) => o.id));
    const reach = await setOf(listObjects(h.objects, { wants }));
    expect(ids).toEqual(reach);
    expect(got.count).toBe(reach.size);
    // and as haves: nothing outside the pack is taken for theirs
    const haves = [h.commits[19] as string];
    const part = await bitmapWalk(index, h.objects, { wants, haves });
    const theirs = await setOf(listObjects(h.objects, { wants: haves }));
    expect(new Set([...part.objects()].map((o) => o.id))).toEqual(
      new Set([...reach].filter((id) => !theirs.has(id))),
    );
  });
});

describe("partial clone filters through bitmaps", () => {
  it("list what the filtered walk lists, with and without haves, wants of every type", async () => {
    const specs = [
      "blob:none",
      "blob:limit=4",
      "blob:limit=8",
      "tree:0",
      "object:type=commit",
      "object:type=tree",
      "object:type=blob",
      "object:type=tag",
      "combine:blob:none+object:type=tree",
      "combine:blob:limit=6+tree:0",
    ];
    for (const seed of [11, 12, 13]) {
      const h = await randomHistory(seed, 25);
      const tip = h.commits[h.commits.length - 1] as string;
      const { index } = await bitmapped(h, [h.commits[18] as string]);
      // tags and a subtree among the wants: kept whatever the filter says (not a commit's
      // root tree: git's walk marks those not user given before it walks the wants, its
      // bitmap keeps them, and so do ours)
      const someTree = (
        await setOfTyped(listObjects(h.objects, { wants: [h.commits[3] as string] }))
      ).find((o) => o.type === "tree" && o.path)?.id as string;
      const wantSets = [[tip], [tip, ...h.tags, someTree]];
      for (const wants of wantSets) {
        for (const haves of [[], [h.commits[10] as string]]) {
          for (const spec of specs) {
            const filter = parseObjectFilter(spec) as never;
            const walked = await setOf(listObjects(h.objects, { wants, haves, filter }));
            const viaBitmap = await setOf(
              listObjects(h.objects, { wants, haves, filter, bitmap: index }),
            );
            if (haves.length === 0)
              expect(
                [...viaBitmap]
                  .filter((x) => !walked.has(x))
                  .map(String)
                  .concat([...walked].filter((x) => !viaBitmap.has(x)).map((x) => `-${x}`)),
                `${seed} ${spec} ${wants.length}`,
              ).toEqual([]);
            else for (const id of viaBitmap) expect(walked.has(id), `${seed} ${spec}`).toBe(true);
          }
        }
      }
    }
  });
});

async function setOfTyped(it: AsyncIterable<{ id: string; type: string; path?: string }>) {
  const out: { id: string; type: string; path?: string }[] = [];
  for await (const o of it) out.push(o);
  return out;
}
