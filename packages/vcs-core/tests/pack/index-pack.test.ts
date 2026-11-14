/**
 * installPack: git's index-pack over FilesApi, on hand-built packs in memory.
 *
 * The packs are built here (vcs-core cannot depend on vcs-testing); the native-git
 * comparisons live in vcs-store-files/tests/pack/index-pack.git.test.ts.
 */

import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../src/common/files/index.js";
import { CorruptObjectError } from "../../src/history/objects/git-objects.js";
import {
  type ExternalBase,
  installPack,
  PackError,
  readPackIndex,
  sweepPackTemporaries,
  writePackIdx,
} from "../../src/pack/index.js";

const enc = new TextEncoder();
const PACK_DIR = "/objects/pack";

// --- a tiny pack builder -------------------------------------------------------------------

interface Entry {
  kind: number; // 1-4 whole object, 6 OFS_DELTA, 7 REF_DELTA
  data: Uint8Array;
  baseOid?: string;
  baseIdx?: number;
  back?: number;
  sizeOverride?: number;
}

const sha1hex = (b: Uint8Array) => bytesToHex(createSha1().update(b).digest());
const oidOf = (type: string, data: Uint8Array) =>
  bytesToHex(
    createSha1()
      .update(enc.encode(`${type} ${data.length}\0`))
      .update(data)
      .digest(),
  );
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const delta = (baseLen: number, resultLen: number, ops: number[]) =>
  Uint8Array.from([...varint(baseLen), ...varint(resultLen), ...ops]);
const copyAll = (n: number) => [0xf0, n & 255, (n >> 8) & 255, (n >> 16) & 255];
/** `base` followed by `tail`, and the delta producing it */
const extend = (base: Uint8Array, tail: string) => {
  const t = enc.encode(tail);
  const data = new Uint8Array(base.length + t.length);
  data.set(base);
  data.set(t, base.length);
  return { data, d: delta(base.length, data.length, [...copyAll(base.length), t.length, ...t]) };
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A pack with a valid trailer, and where each entry starts and ends. */
function buildPack(entries: Entry[], opts: { count?: number; version?: number } = {}) {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"));
  const v = new DataView(head.buffer);
  v.setUint32(4, opts.version ?? 2);
  v.setUint32(8, opts.count ?? entries.length);
  const parts: Uint8Array[] = [head];
  const offsets: number[] = [];
  const ends: number[] = [];
  let pos = 12;
  for (const e of entries) {
    offsets.push(pos);
    const h: number[] = [];
    let size = e.sizeOverride ?? e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      h.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    h.push(b);
    if (e.kind === 6) {
      let back = e.back ?? pos - (offsets[e.baseIdx as number] as number);
      const bs = [back & 127];
      back = Math.floor(back / 128);
      while (back) {
        back--;
        bs.unshift(0x80 | (back & 127));
        back = Math.floor(back / 128);
      }
      h.push(...bs);
    }
    if (e.kind === 7) h.push(...hexToBytes(e.baseOid as string));
    const entry = concat([Uint8Array.from(h), compressBlockPako(e.data)]);
    parts.push(entry);
    pos += entry.length;
    ends.push(pos);
  }
  const body = concat(parts);
  const bytes = concat([body, createSha1().update(body).digest()]);
  return { bytes, offsets, ends };
}
const pack = (entries: Entry[], opts?: { count?: number; version?: number }) =>
  buildPack(entries, opts).bytes;

async function* chunks(bytes: Uint8Array, size = 4096) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
async function collect(s: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return concat(parts);
}
async function listed(files: FilesApi, dir = PACK_DIR) {
  const out: string[] = [];
  if (!(await files.exists(dir))) return out;
  for await (const e of files.list(dir)) out.push(e.name);
  return out.sort();
}
async function readIdx(files: FilesApi, packId: string) {
  return collect(files.read(`${PACK_DIR}/pack-${packId}.idx`));
}
/** id → [offset, crc32] from an installed idx */
async function idxEntries(files: FilesApi, packId: string) {
  const idx = readPackIndex(await readIdx(files, packId));
  const out = new Map<string, [number, number | undefined]>();
  for (const e of idx.entries()) out.set(e.id, [e.offset, e.crc32]);
  return out;
}
/** Counts `read` calls (storage reads) on a files API. */
function countingReads(files: FilesApi) {
  const counter = { reads: 0, lengths: [] as number[] };
  const read = files.read.bind(files);
  files.read = (path, o) => {
    counter.reads++;
    if (o?.length !== undefined) counter.lengths.push(o.length);
    return read(path, o);
  };
  return counter;
}
/** installPack is expected to refuse: a PackError, and nothing left in the pack directory. */
async function refused(bytes: Uint8Array, opts?: Parameters<typeof installPack>[3]) {
  const files = createInMemoryFilesApi();
  const err = await installPack(files, PACK_DIR, chunks(bytes), opts).catch((e) => e);
  expect(err).toBeInstanceOf(PackError);
  expect(await listed(files)).toEqual([]);
  return err as PackError;
}

// --- objects used by the cases -------------------------------------------------------------

const A = enc.encode("base object A\n".repeat(20));
const { data: B, d: dAB } = extend(A, "plus B\n");
const { data: C, d: dBC } = extend(B, "plus C\n");
const dBA = delta(B.length, A.length, copyAll(A.length));
const Aid = oidOf("blob", A);
const Bid = oidOf("blob", B);
const Cid = oidOf("blob", C);

describe("installPack: complete packs", () => {
  it("installs whole objects: pack and idx under the pack's id, git's offsets and CRCs", async () => {
    const tree = enc.encode(`100644 a\0${"\x01".repeat(20)}`);
    const commit = enc.encode("tree 0000000000000000000000000000000000000000\n\nmsg\n");
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 2, data: tree },
      { kind: 1, data: commit },
    ]);
    const files = createInMemoryFilesApi();
    const r = await installPack(files, PACK_DIR, chunks(built.bytes, 7));
    const packId = sha1hex(built.bytes.subarray(0, built.bytes.length - 20));
    expect(r).toEqual({ packId, count: 3, appended: 0 });
    expect(await listed(files)).toEqual([`pack-${packId}.idx`, `pack-${packId}.pack`]);
    expect(await collect(files.read(`${PACK_DIR}/pack-${packId}.pack`))).toEqual(built.bytes);
    const ids = [oidOf("blob", A), oidOf("tree", tree), oidOf("commit", commit)];
    const entries = await idxEntries(files, packId);
    ids.forEach((id, i) => {
      const at = built.offsets[i] as number;
      const crc = crc32(built.bytes.subarray(at, built.ends[i]));
      expect(entries.get(id)).toEqual([at, crc]);
    });
  });

  it("resolves OFS_DELTA and REF_DELTA entries", async () => {
    const files = createInMemoryFilesApi();
    const r = await installPack(
      files,
      PACK_DIR,
      chunks(
        pack([
          { kind: 3, data: A },
          { kind: 6, baseIdx: 0, data: dAB },
          { kind: 7, baseOid: Bid, data: dBC },
        ]),
      ),
    );
    expect(r.count).toBe(3);
    expect([...(await idxEntries(files, r.packId)).keys()].sort()).toEqual([Aid, Bid, Cid].sort());
  });

  it("resolves a forward REF_DELTA (base after the delta)", async () => {
    const files = createInMemoryFilesApi();
    const r = await installPack(
      files,
      PACK_DIR,
      chunks(
        pack([
          { kind: 7, baseOid: Aid, data: dAB },
          { kind: 3, data: A },
        ]),
      ),
    );
    expect([...(await idxEntries(files, r.packId)).keys()].sort()).toEqual([Aid, Bid].sort());
  });

  it("resolves a REF_DELTA on a REF_DELTA, and an OFS_DELTA on a REF_DELTA", async () => {
    const files = createInMemoryFilesApi();
    const { data: D, d: dCD } = extend(C, "plus D\n");
    const r = await installPack(
      files,
      PACK_DIR,
      chunks(
        pack([
          { kind: 3, data: A },
          { kind: 7, baseOid: Aid, data: dAB },
          { kind: 7, baseOid: Bid, data: dBC },
          { kind: 6, baseIdx: 2, data: dCD },
        ]),
      ),
    );
    expect([...(await idxEntries(files, r.packId)).keys()].sort()).toEqual(
      [Aid, Bid, Cid, oidOf("blob", D)].sort(),
    );
  });

  it("indexes the same object twice (both entries, pack order)", async () => {
    const files = createInMemoryFilesApi();
    const built = buildPack([
      { kind: 3, data: A },
      { kind: 3, data: A },
    ]);
    const r = await installPack(files, PACK_DIR, chunks(built.bytes));
    expect(r.count).toBe(2);
    const idx = readPackIndex(await readIdx(files, r.packId));
    expect([...idx.entries()].map((e) => e.offset)).toEqual(built.offsets);
  });

  it("installs a pack with zero objects", async () => {
    const files = createInMemoryFilesApi();
    const r = await installPack(files, PACK_DIR, chunks(pack([])));
    expect(r.count).toBe(0);
    expect(await listed(files)).toHaveLength(2);
  });

  it("renames the pack into place before the idx; temporaries never take final names", async () => {
    const files = createInMemoryFilesApi();
    const moves: string[] = [];
    const move = files.move.bind(files);
    files.move = async (a, b) => {
      const name = (p: string) => p.split("/").pop() ?? p;
      moves.push(
        `${name(a).replace(/_[0-9a-f]+$/, "_*")} -> ${name(b).replace(/[0-9a-f]{40}/, "<id>")}`,
      );
      return move(a, b);
    };
    await installPack(files, PACK_DIR, chunks(pack([{ kind: 3, data: A }])));
    expect(moves).toEqual(["tmp_pack_* -> pack-<id>.pack", "tmp_idx_* -> pack-<id>.idx"]);
  });

  it("keeps an already installed pack (a repeated fetch)", async () => {
    const files = createInMemoryFilesApi();
    const bytes = pack([{ kind: 3, data: A }]);
    const r1 = await installPack(files, PACK_DIR, chunks(bytes));
    const r2 = await installPack(files, PACK_DIR, chunks(bytes));
    expect(r2).toEqual(r1);
    expect(await listed(files)).toEqual([`pack-${r1.packId}.idx`, `pack-${r1.packId}.pack`]);
  });
});

describe("installPack: refusals leave the pack directory empty", () => {
  const good = buildPack([
    { kind: 3, data: A },
    { kind: 6, baseIdx: 0, data: dAB },
    { kind: 7, baseOid: Bid, data: dBC },
  ]).bytes;
  const flip = (b: Uint8Array, at: number) => {
    const c = b.slice();
    c[at] = (c[at] as number) ^ 0x40;
    return c;
  };

  it("PackError is a CorruptObjectError", async () => {
    const err = await refused(good.subarray(0, 40));
    expect(err).toBeInstanceOf(CorruptObjectError);
    expect(err.name).toBe("PackError");
  });
  it("a REF_DELTA cycle", async () => {
    await refused(
      pack([
        { kind: 7, baseOid: Bid, data: dAB },
        { kind: 7, baseOid: Aid, data: dBA },
      ]),
    );
  });
  it("a missing base without externalBase (a thin pack)", async () => {
    const err = await refused(pack([{ kind: 7, baseOid: Aid, data: dAB }]));
    expect(err.message).toMatch(/thin pack/);
  });
  it("a bad trailer", async () => {
    await refused(flip(good, good.length - 1));
  });
  it("truncation", async () => {
    await refused(good.subarray(0, good.length - 30));
    await refused(good.subarray(0, good.length - 1));
  });
  it("bytes after the trailer", async () => {
    await refused(concat([good, Uint8Array.of(1, 2, 3)]));
  });
  it("a compressed byte flipped", async () => {
    await refused(flip(good, Math.floor(good.length / 2)));
  });
  it("an object count too high, or too low", async () => {
    await refused(pack([{ kind: 3, data: A }], { count: 2 }));
    await refused(
      pack(
        [
          { kind: 3, data: A },
          { kind: 3, data: B },
        ],
        { count: 1 },
      ),
    );
  });
  it("pack version 4", async () => {
    await refused(pack([{ kind: 3, data: A }], { version: 4 }));
  });
  it("an OFS_DELTA base before the pack start, or not at an entry", async () => {
    await refused(
      pack([
        { kind: 3, data: A },
        { kind: 6, back: 5000, data: dAB },
      ]),
    );
    await refused(
      pack([
        { kind: 3, data: A },
        { kind: 6, back: 3, data: dAB },
      ]),
    );
  });
  it("an entry inflating past its declared size (an inflate bomb) stops early", async () => {
    const bomb = pack([{ kind: 3, data: new Uint8Array(16 * 2 ** 20), sizeOverride: 10 }]);
    const t0 = performance.now();
    const err = await refused(bomb);
    expect(err.message).toMatch(/past its declared/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it("an object over maxObjectSize, by its header", async () => {
    const err = await refused(pack([{ kind: 3, data: new Uint8Array(4096) }]), {
      maxObjectSize: 1000,
    });
    expect(err.message).toMatch(/over the limit/);
  });
  it("a delta declaring a result over maxObjectSize, before allocating it", async () => {
    const huge = pack([
      { kind: 3, data: A },
      { kind: 7, baseOid: Aid, data: delta(A.length, 2 ** 40, copyAll(A.length)) },
    ]);
    await refused(huge);
    await refused(huge, { maxObjectSize: 2 ** 50 }); // still checked against the instructions
  });
  it("a pack over maxPackSize, while it is stored", async () => {
    const big = pack(Array.from({ length: 40 }, (_, i) => ({ kind: 3, data: enc.encode(`${i}`) })));
    const err = await refused(big, { maxPackSize: 100 });
    expect(err.message).toMatch(/over the limit of 100 bytes/);
  });
  it("a stream that is not a pack, at its first chunk", async () => {
    let pulled = 0;
    async function* garbage() {
      for (let i = 0; i < 100; i++) {
        pulled++;
        yield new Uint8Array(4096).fill(0x41);
      }
    }
    const files = createInMemoryFilesApi();
    const err = await installPack(files, PACK_DIR, garbage()).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(err.message).toMatch(/no PACK signature/);
    expect(pulled).toBe(1);
    expect(await listed(files)).toEqual([]);
  });
  it("a header declaring more entries than the pack can hold, before allocating", async () => {
    const err = await refused(pack([{ kind: 3, data: new Uint8Array(10) }], { count: 0xffffffff }));
    expect(err.message).toMatch(/entries/);
  });
});

describe("installPack: delta resolution memory", () => {
  // A ← B ← {C1, C2 ← D2}, all REF_DELTA
  const a = enc.encode("root ".repeat(30));
  const b = extend(a, "B");
  const c1 = extend(b.data, "C1");
  const c2 = extend(b.data, "C2");
  const d2 = extend(c2.data, "D2");
  const tree = pack([
    { kind: 3, data: a },
    { kind: 7, baseOid: oidOf("blob", a), data: b.d },
    { kind: 7, baseOid: oidOf("blob", b.data), data: c1.d },
    { kind: 7, baseOid: oidOf("blob", b.data), data: c2.d },
    { kind: 7, baseOid: oidOf("blob", c2.data), data: d2.d },
  ]);

  it("an evicted base is re-derived through its REF links (same idx, more reads)", async () => {
    // windowBytes 1: every entry load is one storage read, so reads count loads
    const run = async (baseCacheBytes: number) => {
      const files = createInMemoryFilesApi();
      const counter = countingReads(files);
      const r = await installPack(files, PACK_DIR, chunks(tree), {
        baseCacheBytes,
        windowBytes: 1,
      });
      return { reads: counter.reads, idx: await readIdx(files, r.packId) };
    };
    const kept = await run(2 ** 20);
    const evicted = await run(1);
    expect(evicted.idx).toEqual(kept.idx);
    // phase 1 is one read; with the cache, each of the 5 entries is loaded once
    expect(kept.reads).toBe(1 + 5);
    expect(evicted.reads).toBeGreaterThan(kept.reads);
  });

  it("phase 2 reads through one bounded window", async () => {
    const entries: Entry[] = [{ kind: 3, data: A }];
    let prev = A;
    for (let i = 0; i < 100; i++) {
      const next = extend(prev, `+${i}`);
      entries.push({ kind: 6, baseIdx: i, data: next.d });
      prev = next.data;
    }
    const bytes = pack(entries);
    const files = createInMemoryFilesApi();
    const counter = countingReads(files);
    await installPack(files, PACK_DIR, chunks(bytes), { windowBytes: 1024 });
    // the phase-1 pass, then window refills: far fewer than the 101 entry loads
    expect(counter.reads).toBeGreaterThan(2);
    expect(counter.reads).toBeLessThan(20);
    expect(Math.max(...counter.lengths)).toBeLessThanOrEqual(1024);
  });
});

describe("installPack: thin packs completed through externalBase (--fix-thin)", () => {
  const other = enc.encode("an unrelated blob");
  let calls: string[] = [];
  const baseOf =
    (objs: Record<string, Uint8Array>): ExternalBase =>
    async (id) => {
      calls.push(id);
      const data = objs[id];
      return data ? { type: "blob", data } : undefined;
    };

  it("appends the missing base; the completed pack is valid on its own", async () => {
    calls = [];
    // B = A + δ (A external), C = B + δ (REF on B: exists once A is appended), and a second delta
    // on A: one lookup, one appended base
    const thin = pack([
      { kind: 7, baseOid: Aid, data: dAB },
      { kind: 7, baseOid: Bid, data: dBC },
      { kind: 7, baseOid: Aid, data: delta(A.length, A.length, copyAll(A.length)) },
    ]);
    const files = createInMemoryFilesApi();
    const r = await installPack(files, PACK_DIR, chunks(thin), {
      externalBase: baseOf({ [Aid]: A }),
    });
    expect(calls).toEqual([Aid]);
    expect(r.appended).toBe(1);
    expect(r.count).toBe(4);
    expect(await listed(files)).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
    const completed = await collect(files.read(`${PACK_DIR}/pack-${r.packId}.pack`));
    // named after its own trailer, the header counts the appended entry
    expect(sha1hex(completed.subarray(0, completed.length - 20))).toBe(r.packId);
    expect(bytesToHex(completed.subarray(completed.length - 20))).toBe(r.packId);
    expect(new DataView(completed.buffer, completed.byteOffset).getUint32(8)).toBe(4);
    // the received entries are kept as they were
    expect(completed.subarray(12, thin.length - 20)).toEqual(thin.subarray(12, thin.length - 20));
    const idx = await readIdx(files, r.packId);
    const ids = [...readPackIndex(idx).entries()].map((e) => e.id);
    expect(ids).toEqual([Aid, Aid, Bid, Cid].sort());
    // installed again without externalBase, the completed pack gives the same id and idx
    const again = createInMemoryFilesApi();
    const r2 = await installPack(again, PACK_DIR, chunks(completed));
    expect(r2).toEqual({ packId: r.packId, count: 4, appended: 0 });
    expect(await readIdx(again, r.packId)).toEqual(idx);
  });

  it("an unknown base is refused; the message counts the deltas, the id is asked once", async () => {
    calls = [];
    const err = await refused(
      pack([
        { kind: 3, data: other },
        { kind: 7, baseOid: Aid, data: dAB },
        { kind: 7, baseOid: Aid, data: dAB.slice() },
      ]),
      { externalBase: baseOf({}) },
    );
    expect(err.message).toMatch(/2 unresolved deltas/);
    expect(calls).toEqual([Aid]);
  });

  it("a base whose content hashes to another id is refused", async () => {
    calls = [];
    const err = await refused(pack([{ kind: 7, baseOid: Aid, data: dAB }]), {
      externalBase: baseOf({ [Aid]: other }),
    });
    expect(err.message).toMatch(/hashes to/);
  });

  it("a complete pack never calls externalBase and keeps its id", async () => {
    calls = [];
    const bytes = pack([
      { kind: 3, data: A },
      { kind: 6, baseIdx: 0, data: dAB },
    ]);
    const r = await installPack(createInMemoryFilesApi(), PACK_DIR, chunks(bytes), {
      externalBase: baseOf({}),
    });
    expect(calls).toEqual([]);
    expect(r.appended).toBe(0);
    expect(r.packId).toBe(sha1hex(bytes.subarray(0, bytes.length - 20)));
  });

  it("detects the stored pack changing while it is completed", async () => {
    const thin = pack([
      { kind: 3, data: other },
      { kind: 7, baseOid: Aid, data: dAB },
    ]);
    const files = createInMemoryFilesApi();
    const read = files.read.bind(files);
    // the completion re-reads the received part [12, size - 20): flip a byte in that read only
    files.read = (path, o) =>
      (async function* () {
        const copy =
          /tmp_pack_[^/]*$/.test(path) && o?.start === 12 && o.length === thin.length - 32;
        for await (const c of read(path, o)) {
          if (!copy) yield c;
          else {
            const x = c.slice();
            x[0] = (x[0] as number) ^ 1;
            yield x;
          }
        }
      })();
    const err = await installPack(files, PACK_DIR, chunks(thin), {
      externalBase: baseOf({ [Aid]: A }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(err.message).toMatch(/changed/);
    expect(await listed(files)).toEqual([]);
  });

  it("re-reads an evicted appended base (small and over the window)", async () => {
    for (const big of [false, true]) {
      const X = big ? new Uint8Array(300_000).map((_, i) => (i * 7919) % 251) : A;
      const Y = enc.encode("second external ".repeat(30));
      const b = extend(X, "B");
      const c = extend(X, "C");
      const e = extend(Y, "E");
      const f = extend(b.data, "F");
      const g = extend(c.data, "G");
      const thin = pack([
        { kind: 7, baseOid: oidOf("blob", X), data: b.d },
        { kind: 7, baseOid: oidOf("blob", Y), data: e.d },
        { kind: 7, baseOid: oidOf("blob", b.data), data: f.d },
        { kind: 7, baseOid: oidOf("blob", X), data: c.d },
        { kind: 7, baseOid: oidOf("blob", c.data), data: g.d },
      ]);
      const files = createInMemoryFilesApi();
      const r = await installPack(files, PACK_DIR, chunks(thin), {
        baseCacheBytes: 1,
        windowBytes: 4096,
        externalBase: baseOf({ [oidOf("blob", X)]: X, [oidOf("blob", Y)]: Y }),
      });
      expect(r.appended).toBe(2);
      const completed = await collect(files.read(`${PACK_DIR}/pack-${r.packId}.pack`));
      const again = createInMemoryFilesApi();
      await installPack(again, PACK_DIR, chunks(completed));
      expect(await readIdx(again, r.packId)).toEqual(await readIdx(files, r.packId));
    }
  });

  it("writes 50 appended bases in a few batches, not a file each", async () => {
    const bases: Record<string, Uint8Array> = {};
    const entries: Entry[] = [];
    for (let k = 0; k < 50; k++) {
      const X = enc.encode(`external base ${k} `.repeat(40));
      bases[oidOf("blob", X)] = X;
      entries.push({ kind: 7, baseOid: oidOf("blob", X), data: extend(X, `+${k}`).d });
    }
    const files = createInMemoryFilesApi();
    const write = files.write.bind(files);
    const written: string[] = [];
    files.write = (path, content) => {
      written.push(path);
      return write(path, content);
    };
    const r = await installPack(files, PACK_DIR, chunks(pack(entries)), {
      externalBase: baseOf(bases),
    });
    expect(r).toMatchObject({ appended: 50, count: 100 });
    expect(written.filter((w) => /tmp_thin_/.test(w)).length).toBeLessThanOrEqual(2);
    expect(await listed(files)).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
  });
});

describe("writePackIdx", () => {
  it("writes idx v2: sorted ids, fan-out, CRCs, offsets (64-bit past 2 GiB), checksums", () => {
    const ids = ["ff", "00", "7f"].map((p) => p + "1".repeat(38));
    const offsets = [12, 2 ** 31, 2 ** 40 + 3];
    const entries = ids.map((id, i) => ({ id, offset: offsets[i] as number, crc32: i + 1 }));
    const packChecksum = hexToBytes("ab".repeat(20));
    const idx = writePackIdx(entries, packChecksum);
    const read = readPackIndex(idx);
    expect(read.version).toBe(2);
    expect(read.objectCount).toBe(3);
    expect(read.offset64Count).toBe(2);
    expect([...read.entries()]).toEqual(
      [...entries].sort((x, y) => (x.id < y.id ? -1 : 1)).map((e) => ({ ...e })),
    );
    expect(idx.subarray(idx.length - 40, idx.length - 20)).toEqual(packChecksum);
    expect(sha1hex(idx.subarray(0, idx.length - 20))).toBe(
      bytesToHex(idx.subarray(idx.length - 20)),
    );
  });
});

describe("sweepPackTemporaries", () => {
  it("removes stale tmp_* files only; keeps young ones, packs and other files", async () => {
    const files = createInMemoryFilesApi();
    const one = [new Uint8Array(1)];
    for (const n of ["tmp_pack_old", "tmp_idx_old", "tmp_thin_old_0", "pack-old.pack", "x.txt"])
      await files.write(`${PACK_DIR}/${n}`, one);
    const oldTime = (await files.stats(`${PACK_DIR}/tmp_pack_old`))?.lastModified as number;
    await new Promise((r) => setTimeout(r, 30));
    await files.write(`${PACK_DIR}/tmp_pack_young`, one);
    const youngTime = (await files.stats(`${PACK_DIR}/tmp_pack_young`))?.lastModified as number;
    expect(youngTime).toBeGreaterThan(oldTime);
    const threshold = (youngTime - oldTime) / 2;
    expect(await sweepPackTemporaries(files, PACK_DIR, threshold, oldTime)).toEqual([]);
    const removed = await sweepPackTemporaries(files, `${PACK_DIR}/`, threshold, youngTime);
    expect(removed.sort()).toEqual(
      ["tmp_idx_old", "tmp_pack_old", "tmp_thin_old_0"].map((n) => `${PACK_DIR}/${n}`),
    );
    expect(await listed(files)).toEqual(["pack-old.pack", "tmp_pack_young", "x.txt"]);
  });
  it("returns nothing for a missing directory", async () => {
    expect(await sweepPackTemporaries(createInMemoryFilesApi(), PACK_DIR, 0)).toEqual([]);
  });
});
