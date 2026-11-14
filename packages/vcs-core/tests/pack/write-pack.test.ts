/**
 * writePack (git pack-objects): whole objects, reuse from a PackSet, OFS offset rewriting, the
 * fallbacks of reused deltas, the windowed delta search and thin packs. Every pack written is
 * read back by unpackObjects and installPack, byte for byte.
 */
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import type { GitObject, GitObjects } from "../../src/history/objects/git-objects.js";
import {
  installPack,
  listObjects,
  openPackSet,
  type PackObjectRef,
  type PackSet,
  unpackObjects,
  type WritePackOptions,
  type WrittenPackEntry,
  writePack,
} from "../../src/pack/index.js";
import { blob, commit, memObjects, tree } from "./history-builder.js";
import { chunks, collect, extend, oidOf, pack } from "./pack-builder.js";

const enc = new TextEncoder();

const A = enc.encode("base object A\n".repeat(20));
const { data: B, d: dAB } = extend(A, "plus B\n");
const { data: C, d: dBC } = extend(B, "plus C\n");
const Aid = oidOf("blob", A);
const Bid = oidOf("blob", B);
const Cid = oidOf("blob", C);

async function write(
  objects: Pick<GitObjects, "get">,
  ids: readonly PackObjectRef[],
  options: WritePackOptions = {},
): Promise<{ bytes: Uint8Array; entries: WrittenPackEntry[] }> {
  const entries: WrittenPackEntry[] = [];
  const bytes = await collect(
    writePack(objects, ids, { ...options, onEntry: (e) => entries.push(e) }),
  );
  return { bytes, entries };
}

/** Unpacks `bytes` into a fresh store (or `into`) and checks each object is byte-exact. */
async function checkUnpacks(bytes: Uint8Array, source: Pick<GitObjects, "get">, into?: GitObjects) {
  const target = into ?? memObjects();
  const r = await unpackObjects(target, chunks(bytes, 777));
  for (const id of await idsOf(bytes, into ? (id) => target.get(id) : undefined)) {
    const want = await source.get(id);
    const got = await target.get(id);
    expect(got?.type).toBe(want?.type);
    expect(await collect((got as GitObject).content)).toEqual(
      await collect((want as GitObject).content),
    );
  }
  return r;
}

/** The ids of a pack, as installPack indexes them (also checks the pack is valid). */
async function idsOf(
  bytes: Uint8Array,
  externalBase?: (id: string) => Promise<GitObject | undefined>,
) {
  const files = createInMemoryFilesApi();
  const installed = await installPack(files, "/p", chunks(bytes, 1000), {
    externalBase: externalBase
      ? async (id) => {
          const o = await externalBase(id);
          return o ? { type: o.type, data: await collect(o.content) } : undefined;
        }
      : undefined,
  });
  const set = await openPackSet(files, "/p");
  const ids: string[] = [];
  for await (const id of set.list()) ids.push(id);
  expect(ids.length).toBe(installed.count);
  return ids;
}

/** A pack set holding A whole, B as an OFS delta on A and C as a REF delta on B. */
async function packedABC(): Promise<PackSet> {
  const files = createInMemoryFilesApi();
  const set = await openPackSet(files, "/objects/pack");
  await set.install(
    chunks(
      pack([
        { kind: 3, data: A },
        { kind: 6, baseIdx: 0, data: dAB },
        { kind: 7, baseOid: Bid, data: dBC },
      ]),
    ),
  );
  return set;
}

/** Wraps a pack set: counts `get` and `raw()` calls per id. */
function spied(set: PackSet) {
  const gets: string[] = [];
  const raws: string[] = [];
  const wrapped: PackSet = {
    ...set,
    get: (id, o) => {
      gets.push(id);
      return set.get(id, o);
    },
    async entry(id) {
      const e = await set.entry(id);
      if (!e) return e;
      return {
        ...e,
        raw() {
          raws.push(id);
          return e.raw();
        },
      };
    },
  };
  return { set: wrapped, gets, raws };
}

describe("writePack: whole objects", () => {
  it("writes a valid v2 pack (header count, SHA-1 trailer) that reads back byte for byte", async () => {
    const objects = memObjects();
    const b1 = await blob(objects, "hello\n");
    const t = await tree(objects, [["100644", "hello.txt", b1]]);
    const c = await commit(objects, t, [], 1000);
    const { bytes, entries } = await write(objects, [c, t, b1, c]);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PACK");
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4)).toBe(2);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(8)).toBe(3); // deduplicated
    const body = bytes.subarray(0, bytes.length - 20);
    expect(bytesToHex(bytes.subarray(bytes.length - 20))).toBe(
      bytesToHex(createSha1().update(body).digest()),
    );
    expect(entries.map((e) => e.id)).toEqual([c, t, b1]);
    expect(entries[0]?.offset).toBe(12);
    const r = await checkUnpacks(bytes, objects);
    expect(r.count).toBe(3);
  });

  it("writes an empty pack for no ids", async () => {
    const { bytes } = await write(memObjects(), []);
    expect(bytes.length).toBe(32);
  });

  it("fails on an id the store does not have", async () => {
    await expect(write(memObjects(), ["1".repeat(40)])).rejects.toThrow(/missing/);
  });

  it("takes listObjects' output directly", async () => {
    const objects = memObjects();
    const b1 = await blob(objects, "x\n");
    const t = await tree(objects, [["100644", "x", b1]]);
    const c = await commit(objects, t, [], 1);
    const listed = [];
    for await (const o of listObjects(objects, { wants: [c] })) listed.push(o);
    const { bytes } = await write(objects, listed);
    expect((await checkUnpacks(bytes, objects)).count).toBe(3);
  });
});

describe("writePack: reuse from a PackSet", () => {
  it("copies stored entries without inflating them, and rewrites OFS offsets", async () => {
    const { set, gets, raws } = spied(await packedABC());
    // C first: its base B, and B's base A, must be written before it
    const { bytes, entries } = await write(set, [Cid, Bid, Aid], { packs: set });
    expect(gets).toEqual([]);
    expect(raws.sort()).toEqual([Aid, Bid, Cid].sort());
    expect(entries.map((e) => e.id)).toEqual([Aid, Bid, Cid]);
    const [ea, eb, ec] = entries as [WrittenPackEntry, WrittenPackEntry, WrittenPackEntry];
    expect(ea.kind).toBe(3);
    expect(eb).toMatchObject({ kind: 6, baseId: Aid, reused: true });
    expect(ec).toMatchObject({ kind: 6, baseId: Bid, reused: true }); // REF in, OFS out
    expect((await checkUnpacks(bytes, set)).deltas).toBe(2);
  });

  it("keeps reused deltas as REF deltas when ofsDelta is off", async () => {
    const set = await packedABC();
    const { bytes, entries } = await write(set, [Aid, Bid, Cid], { packs: set, ofsDelta: false });
    expect(entries.map((e) => e.kind)).toEqual([3, 7, 7]);
    await checkUnpacks(bytes, set);
  });

  it("writes a reused delta whole when its base is not in the pack", async () => {
    const { set, gets } = spied(await packedABC());
    const { bytes, entries } = await write(set, [Cid], { packs: set });
    expect(entries).toMatchObject([{ id: Cid, kind: 3 }]);
    expect(gets).toEqual([Cid]);
    const r = await checkUnpacks(bytes, set);
    expect(r.deltas).toBe(0);
  });

  it("does not reuse when asked not to", async () => {
    const { set, raws } = spied(await packedABC());
    const { bytes, entries } = await write(set, [Aid, Bid], {
      packs: set,
      reuseObjects: false,
      reuseDeltas: false,
    });
    expect(raws).toEqual([]);
    expect(entries.map((e) => e.kind)).toEqual([3, 3]);
    await checkUnpacks(bytes, set);
  });
});

describe("writePack: thin packs", () => {
  it("keeps a reused delta on a have as a REF delta, without the have", async () => {
    const set = await packedABC();
    const { bytes, entries } = await write(set, [Cid], { packs: set, thin: true, haves: [Bid] });
    expect(entries).toMatchObject([{ id: Cid, kind: 7, baseId: Bid }]);
    // completes against a store with B, and only there
    const withB = memObjects();
    await withB.put("blob", B.length, [B]);
    await checkUnpacks(bytes, set, withB);
    await expect(unpackObjects(memObjects(), chunks(bytes))).rejects.toThrow();
  });

  it("deltifies against haves found by the search", async () => {
    const objects = memObjects();
    await objects.put("blob", A.length, [A]);
    await objects.put("blob", B.length, [B]);
    const { bytes, entries } = await write(objects, [{ id: Bid, type: "blob", path: "f" }], {
      deltaSearch: true,
      thin: true,
      haves: [{ id: Aid, type: "blob", path: "f" }],
    });
    expect(entries).toMatchObject([{ id: Bid, kind: 7, baseId: Aid }]);
    const withA = memObjects();
    await withA.put("blob", A.length, [A]);
    await checkUnpacks(bytes, objects, withA);
  });
});

describe("writePack: delta search", () => {
  /** `n` versions of a text file, each an edit of the previous one. */
  async function versions(objects: GitObjects, n: number) {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet`);
    const refs: PackObjectRef[] = [];
    for (let v = 0; v < n; v++) {
      lines[(v * 37) % lines.length] = `edited in version ${v}`;
      const id = await blob(objects, `${lines.join("\n")}\n`);
      refs.push({ id, type: "blob", path: "notes.txt" });
    }
    return refs;
  }

  it("produces a smaller pack of deltas that reads back byte for byte", async () => {
    const objects = memObjects();
    const refs = await versions(objects, 12);
    const plain = await write(objects, refs);
    const searched = await write(objects, refs, { deltaSearch: true });
    expect(searched.bytes.length).toBeLessThan(plain.bytes.length / 3);
    expect(searched.entries.filter((e) => e.kind === 6).length).toBeGreaterThan(8);
    const r = await checkUnpacks(searched.bytes, objects);
    expect(r.count).toBe(12);
  });

  it("respects the maximum depth of delta chains", async () => {
    const objects = memObjects();
    const refs = await versions(objects, 12);
    const { bytes, entries } = await write(objects, refs, { deltaSearch: { depth: 2 } });
    const base = new Map(entries.map((e) => [e.id, e.baseId]));
    const depth = (id: string): number => {
      const b = base.get(id);
      return b ? 1 + depth(b) : 0;
    };
    const depths = entries.map((e) => depth(e.id));
    expect(Math.max(...depths)).toBe(2);
    await checkUnpacks(bytes, objects);
  });

  it("does not deltify blobs over bigFileThreshold", async () => {
    const objects = memObjects();
    const refs = await versions(objects, 4);
    const { entries } = await write(objects, refs, { deltaSearch: true, bigFileThreshold: 1000 });
    expect(entries.every((e) => e.kind === 3)).toBe(true);
  });

  it("writes deltas as REF deltas when ofsDelta is off", async () => {
    const objects = memObjects();
    const refs = await versions(objects, 4);
    const { bytes, entries } = await write(objects, refs, { deltaSearch: true, ofsDelta: false });
    expect(entries.some((e) => e.kind === 7)).toBe(true);
    expect(entries.some((e) => e.kind === 6)).toBe(false);
    await checkUnpacks(bytes, objects);
  });
});

describe("writePack: bounded memory", () => {
  it("streams a lazily generated 60 MiB blob while the consumer lags behind", async () => {
    const MiB = 2 ** 20;
    const size = 60 * MiB;
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    /** incompressible bytes, so the pack is as large as the blob */
    async function* content() {
      let x = 0x2545f491;
      for (let at = 0; at < size; at += MiB) {
        const words = new Uint32Array(MiB / 4);
        for (let i = 0; i < words.length; i++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          words[i] = x >>> 0;
        }
        produced += MiB;
        yield new Uint8Array(words.buffer);
      }
    }
    const id = "b".repeat(40);
    const source = {
      async get(oid: string): Promise<GitObject | undefined> {
        return oid === id ? { type: "blob", size, content: content() } : undefined;
      },
    };
    const hash = createSha1();
    let tail = new Uint8Array(0);
    let pulls = 0;
    for await (const chunk of writePack(source, [id], { deltaSearch: true })) {
      consumed += chunk.length;
      maxAhead = Math.max(maxAhead, produced - consumed);
      // keep the last 20 bytes aside: they are the trailer
      const all = new Uint8Array(tail.length + chunk.length);
      all.set(tail);
      all.set(chunk, tail.length);
      const cut = Math.max(0, all.length - 20);
      hash.update(all.subarray(0, cut));
      tail = all.slice(cut);
      // a slow consumer: every few chunks, wait for the next macrotask
      if (++pulls % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    expect(produced).toBe(size);
    expect(consumed).toBeGreaterThan(size);
    expect(maxAhead).toBeLessThan(8 * MiB);
    expect(bytesToHex(tail)).toBe(bytesToHex(hash.digest()));
  }, 120_000);
});
