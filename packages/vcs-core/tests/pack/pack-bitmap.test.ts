/**
 * Pack reachability bitmaps: EWAH as git lays it out, the writer read back by the reader, and
 * the property that enumerating through a bitmap gives exactly the walk's object set, over
 * random histories (merges, equal dates, shared trees, tags, objects outside the bitmapped
 * pack).
 */
import { EwahBitmap, RawBitmap } from "@statewalker/vcs-utils";
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
