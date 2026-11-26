/**
 * Pseudo-merge bitmaps: the writer's section read back, the walk through pseudo-merges giving
 * exactly the plain walk's objects, and crafted sections (served repositories) refused before
 * any pseudo-merge is used. Byte equality with git is in vcs-store-files'
 * `pack-bitmap-pseudo-merge.git.test.ts`.
 */
import { compilePosixRegex, EwahBitmap } from "@statewalker/vcs-utils";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import type { GitObjects } from "../../src/history/objects/git-objects.js";
import {
  bitmapWalk,
  encodePseudoMerges,
  listObjects,
  openPackSet,
  PackBitmapError,
  type PackFile,
  type PseudoMergeGroup,
  parsePackBitmap,
  writePack,
  writePackBitmap,
} from "../../src/pack/index.js";
import { blob, commit, memObjects, tree } from "./history-builder.js";

/** A history of `n` commits (a merge every 7th), each tagged `refs/tags/t<i>`. */
async function history(n: number): Promise<{ objects: GitObjects; commits: string[] }> {
  const objects = memObjects();
  const commits: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await tree(objects, [["100644", `f${i % 5}.txt`, await blob(objects, `c${i}\n`)]]);
    const parents = i === 0 ? [] : [commits[i - 1] as string];
    if (i % 7 === 6 && i > 3) parents.push(commits[i - 4] as string);
    commits.push(await commit(objects, t, parents, 1_700_000_000 + i * 60, `m${i}`));
  }
  return { objects, commits };
}

const group = (over: Partial<PseudoMergeGroup> = {}): PseudoMergeGroup => ({
  name: "test",
  pattern: compilePosixRegex("^refs/tags/", { extended: true }),
  decay: 1,
  maxMerges: 4,
  sampleRate: 1,
  stableSize: 512,
  threshold: Number.POSITIVE_INFINITY,
  stableThreshold: 0,
  ...over,
});

async function bitmapped(n: number, groups: PseudoMergeGroup[]) {
  const h = await history(n);
  const tip = h.commits[n - 1] as string;
  const listed = [];
  for await (const o of listObjects(h.objects, { wants: [tip] })) listed.push(o);
  const files = createInMemoryFilesApi();
  const packs = await openPackSet(files, "/pack");
  const installed = await packs.install(writePack(h.objects, listed));
  const pack = (await packs.packs()).find((p) => p.packId === installed.packId) as PackFile;
  const refs = h.commits.map((id, i) => ({ name: `refs/tags/t${String(i).padStart(4, "0")}`, id }));
  const bytes = await writePackBitmap({
    pack,
    objects: h.objects,
    listed,
    hashCache: false,
    pseudoMerges: { groups, refs },
  });
  return { h, pack, bytes };
}

/** The trailing checksum recomputed after an edit. */
function resum(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  out.set(
    createSha1()
      .update(out.subarray(0, out.length - 20))
      .digest(),
    out.length - 20,
  );
  return out;
}

describe("pseudo-merge bitmaps", () => {
  it("are read back, and walks through them list exactly the plain walk's objects", async () => {
    // 150 commits: above 100 only some get bitmaps of their own, the rest become pseudo-merges
    const { h, pack, bytes } = await bitmapped(150, [group()]);
    const index = parsePackBitmap(bytes, pack);
    expect(index.pseudoMerges.length).toBeGreaterThan(0);
    for (const m of index.pseudoMerges) {
      const parents = [...m.commits.bits()].map((p) => index.idAt(p));
      const reach = new Set<string>();
      for await (const o of listObjects(h.objects, { wants: parents })) reach.add(o.id);
      expect(new Set([...m.bitmap.bits()].map((p) => index.idAt(p)))).toEqual(reach);
    }
    const all = await bitmapWalk(index, h.objects, { wants: h.commits });
    expect(all.pseudoMergesSatisfied).toBe(index.pseudoMerges.length);
    expect(all.count).toBe(pack.count);
    for (const cut of [10, 77, 120]) {
      const wants = h.commits.slice(cut);
      const haves = h.commits.slice(0, cut - 5);
      const got = await bitmapWalk(index, h.objects, { wants, haves });
      const mine = new Set<string>();
      for await (const o of listObjects(h.objects, { wants })) mine.add(o.id);
      const theirs = new Set<string>();
      for await (const o of listObjects(h.objects, { wants: haves })) theirs.add(o.id);
      expect(new Set([...got.objects()].map((o) => o.id))).toEqual(
        new Set([...mine].filter((id) => !theirs.has(id))),
      );
    }
  });

  it("are left out when no ref matches, and git's older readers skip them", async () => {
    const none = await bitmapped(20, [
      group({ pattern: compilePosixRegex("^refs/heads/", { extended: true }) }),
    ]);
    expect(none.bytes[7] & 0x20).toBe(0);
    const some = await bitmapped(20, [group({ stableThreshold: Number.POSITIVE_INFINITY })]);
    expect(some.bytes[7] & 0x20).toBe(0x20);
    // the same entries either way (the section only adds)
    const a = parsePackBitmap(some.bytes, some.pack);
    expect(a.entries.length).toBe(20);
    expect(a.pseudoMerges.length).toBe(1);
  });

  describe("crafted sections are refused", () => {
    const refusal = (b: Uint8Array, pack: PackFile) => {
      try {
        parsePackBitmap(resum(b), pack, "x.bitmap");
      } catch (e) {
        expect(e).toBeInstanceOf(PackBitmapError);
        return (e as Error).message;
      }
      return "accepted";
    };
    /** The section's trailer: count, commit count, table offset, size (before the hash). */
    const trailer = (b: Uint8Array) => {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const end = b.length - 20;
      return { v, end, size: Number(v.getBigUint64(end - 8)), nr: v.getUint32(end - 24) };
    };

    it("a pseudo-merge count larger than the section", async () => {
      const { pack, bytes } = await bitmapped(20, [group({ stableThreshold: Infinity })]);
      const b = bytes.slice();
      const { v, end } = trailer(b);
      v.setUint32(end - 24, 0x10000000);
      expect(refusal(b, pack)).toContain("pseudo-merge table too short");
    });

    it("a section size larger than the file", async () => {
      const { pack, bytes } = await bitmapped(20, [group({ stableThreshold: Infinity })]);
      const b = bytes.slice();
      const { v, end } = trailer(b);
      v.setBigUint64(end - 8, 1n << 40n);
      expect(refusal(b, pack)).toContain("too short to fit pseudo-merge table");
    });

    it("a pseudo-merge offset outside the section, or a commit table past its end", async () => {
      const { pack, bytes } = await bitmapped(20, [group({ stableThreshold: Infinity })]);
      const b = bytes.slice();
      const { v, end, nr } = trailer(b);
      v.setBigUint64(end - 24 - nr * 8, 3n);
      expect(refusal(b, pack)).toContain("out-of-bounds pseudo-merge");
      const c = bytes.slice();
      const t = trailer(c);
      t.v.setUint32(t.end - 20, 0x0fffffff);
      expect(refusal(c, pack)).toContain("too many commits");
    });

    it("parents that are not commits, none, or a bitmap missing its parents", async () => {
      const { pack, bytes } = await bitmapped(20, [
        group({ pattern: compilePosixRegex("^refs/heads/", { extended: true }) }),
      ]);
      const index = parsePackBitmap(bytes, pack);
      const commitBits = [...index.commits.bits()];
      const treeBit = [...index.trees.bits()][0] as number;
      const reach = index.bitmapFor(index.idAt(commitBits[0] as number)) as EwahBitmap;
      const ewah = (bits: number[]) => {
        const e = new EwahBitmap();
        for (const bit of [...bits].sort((x, y) => x - y)) e.set(bit);
        return e;
      };
      /** `bytes` (no section, no hash cache, no lookup table) with a hand-made section. */
      const withSection = (parents: EwahBitmap, bitmap: EwahBitmap) => {
        const start = bytes.length - 20;
        const section = encodePseudoMerges({
          start,
          parents: [parents],
          bitmaps: [bitmap],
          commits: new Map(),
          idOf: (p) => index.idAt(p),
        });
        const out = new Uint8Array(start + section.length + 20);
        out.set(bytes.subarray(0, start));
        out.set(section, start);
        out[7] = (out[7] as number) | 0x20;
        return out;
      };
      const first = commitBits[0] as number;
      expect(refusal(withSection(ewah([first]), reach), pack)).toBe("accepted");
      expect(refusal(withSection(ewah([treeBit]), reach), pack)).toContain("not commits");
      expect(refusal(withSection(ewah([]), reach), pack)).toContain("not commits");
      expect(refusal(withSection(ewah([first]), ewah([treeBit])), pack)).toContain(
        "does not reach its parents",
      );
      expect(refusal(withSection(ewah([first]), ewah([pack.count + 70])), pack)).toContain(
        "bitmap larger than its pack",
      );
    });
  });
});
