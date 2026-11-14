/**
 * unpackObjects (git's unpack-objects) and importPack (unpackLimit: keep or unpack), on
 * hand-built packs streamed into the object kernel.
 */

import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import { createGitObjects } from "../../src/history/objects/git-objects.impl.js";
import type { GitObjects } from "../../src/history/objects/git-objects.js";
import {
  importPack,
  ObjectCollisionError,
  openPackSet,
  PackError,
  type UnpackTarget,
  unpackObjects,
} from "../../src/pack/index.js";
import { rawStorageStaging } from "../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../src/storage/raw/memory-raw-storage.js";
import { chunks, collect, concat, copyAll, delta, extend, oidOf, pack } from "./pack-builder.js";

const enc = new TextEncoder();
const memObjects = () => createGitObjects(rawStorageStaging(new MemoryRawStorage()));

const A = enc.encode("the quick brown fox jumps over the lazy dog\n".repeat(4));
const { data: B, d: dAB } = extend(A, "plus B\n");
const { data: C, d: dBC } = extend(B, "plus C\n");
const Aid = oidOf("blob", A);
const Bid = oidOf("blob", B);
const Cid = oidOf("blob", C);

async function content(objects: GitObjects, id: string): Promise<Uint8Array | undefined> {
  const obj = await objects.get(id);
  return obj ? collect(obj.content) : undefined;
}

async function rawOf(objects: GitObjects, id: string): Promise<Uint8Array> {
  return collect(objects.getRaw(id));
}

async function refused(objects: UnpackTarget, bytes: Uint8Array | AsyncIterable<Uint8Array>) {
  const err = await unpackObjects(
    objects,
    bytes instanceof Uint8Array ? chunks(bytes, 5) : bytes,
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PackError);
  return err as PackError;
}

describe("unpackObjects: whole objects and deltas", () => {
  it("writes each object byte-exact, as git frames it", async () => {
    // a commit with an extra header and odd spacing: parsing and re-encoding would change its id
    const commit = enc.encode(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\nx-extra  kept as is\n\nmsg\n",
    );
    const tree = enc.encode(`100644 a\0${"\x01".repeat(20)}`);
    const objects = memObjects();
    const r = await unpackObjects(
      objects,
      chunks(
        pack([
          { kind: 3, data: A },
          { kind: 2, data: tree },
          { kind: 1, data: commit },
        ]),
        3,
      ),
    );
    expect(r).toEqual({
      count: 3,
      written: 3,
      existing: 0,
      deltas: 0,
      types: { commit: 1, tree: 1, blob: 1, tag: 0 },
    });
    const commitId = oidOf("commit", commit);
    expect(await rawOf(objects, commitId)).toEqual(
      concat([enc.encode(`commit ${commit.length}\0`), commit]),
    );
    expect(await content(objects, oidOf("tree", tree))).toEqual(tree);
    expect(await content(objects, Aid)).toEqual(A);
  });

  it("resolves OFS_DELTA and REF_DELTA entries against earlier entries", async () => {
    const objects = memObjects();
    const ids: string[] = [];
    const r = await unpackObjects(
      objects,
      chunks(
        pack([
          { kind: 3, data: A },
          { kind: 6, baseIdx: 0, data: dAB },
          { kind: 7, baseOid: Bid, data: dBC },
        ]),
      ),
      { onObject: (id) => ids.push(id) },
    );
    expect(r.deltas).toBe(2);
    expect(ids).toEqual([Aid, Bid, Cid]);
    expect(await content(objects, Bid)).toEqual(B);
    expect(await content(objects, Cid)).toEqual(C);
  });

  it("resolves a delta chain, also with every base evicted from the cache", async () => {
    let data = A;
    const entries: Parameters<typeof pack>[0] = [{ kind: 3, data: A }];
    const expected: [string, Uint8Array][] = [[Aid, A]];
    for (let k = 1; k <= 30; k++) {
      const next = extend(data, `line ${k}\n`);
      entries.push({ kind: 6, baseIdx: k - 1, data: next.d });
      data = next.data;
      expected.push([oidOf("blob", data), data]);
    }
    const objects = memObjects();
    const r = await unpackObjects(objects, chunks(pack(entries), 64), { baseCacheBytes: 0 });
    expect(r.count).toBe(31);
    for (const [id, bytes] of expected) expect(await content(objects, id)).toEqual(bytes);
  });

  it("resolves a REF_DELTA whose base comes later, and an OFS_DELTA on top of it", async () => {
    const objects = memObjects();
    await unpackObjects(
      objects,
      chunks(
        pack([
          { kind: 7, baseOid: Aid, data: dAB },
          { kind: 6, baseIdx: 0, data: dBC },
          { kind: 3, data: A },
        ]),
      ),
    );
    expect(await content(objects, Bid)).toEqual(B);
    expect(await content(objects, Cid)).toEqual(C);
  });

  it("completes a thin pack from the objects the store has", async () => {
    const objects = memObjects();
    await objects.put("blob", A.length, [A]);
    const r = await unpackObjects(
      objects,
      chunks(
        pack([
          { kind: 7, baseOid: Aid, data: dAB },
          { kind: 6, baseIdx: 0, data: dBC },
        ]),
      ),
    );
    expect(r).toMatchObject({ count: 2, written: 2, deltas: 2 });
    expect(await content(objects, Cid)).toEqual(C);
  });

  it("an object already stored with the same bytes is kept, not rewritten", async () => {
    const objects = memObjects();
    await objects.put("blob", A.length, [A]);
    const r = await unpackObjects(objects, chunks(pack([{ kind: 3, data: A }])));
    expect(r).toMatchObject({ written: 0, existing: 1 });
  });
});

describe("unpackObjects: refusals", () => {
  const good = pack([
    { kind: 3, data: A },
    { kind: 6, baseIdx: 0, data: dAB },
  ]);

  it("a bad trailer", async () => {
    const bad = good.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect((await refused(memObjects(), bad)).message).toMatch(/checksum mismatch/);
  });

  it("truncation, anywhere", async () => {
    for (const cut of [5, 14, 30, good.length - 25, good.length - 1]) {
      expect((await refused(memObjects(), good.subarray(0, cut))).message).toMatch(/truncated/);
    }
  });

  it("bytes after the trailer", async () => {
    const err = await refused(memObjects(), concat([good, Uint8Array.of(0)]));
    expect(err.message).toMatch(/after the pack trailer/);
  });

  it("not a pack, or an unknown version", async () => {
    expect((await refused(memObjects(), enc.encode("NOPE0000000000000"))).message).toMatch(
      /signature/,
    );
    expect((await refused(memObjects(), pack([], { version: 4 }))).message).toMatch(/version/);
  });

  it("a bad delta", async () => {
    const bad = pack([
      { kind: 3, data: A },
      { kind: 6, baseIdx: 0, data: delta(A.length + 1, 5, copyAll(5)) },
    ]);
    expect((await refused(memObjects(), bad)).message).toMatch(/delta at/);
  });

  it("an entry whose size lies, either way", async () => {
    const over = pack([{ kind: 3, data: A, sizeOverride: A.length - 1 }]);
    expect((await refused(memObjects(), over)).message).toMatch(/past its declared/);
    const under = pack([{ kind: 3, data: A, sizeOverride: A.length + 1 }]);
    expect((await refused(memObjects(), under)).message).toMatch(/inflates to/);
  });

  it("a header count larger than the entries (and a smaller one)", async () => {
    expect(
      (await refused(memObjects(), pack([{ kind: 3, data: A }], { count: 2 }))).message,
    ).toMatch(/truncated|checksum|inflate|type/);
    const fewer = pack(
      [
        { kind: 3, data: A },
        { kind: 3, data: B },
      ],
      { count: 1 },
    );
    expect((await refused(memObjects(), fewer)).message).toMatch(/checksum mismatch/);
  });

  it("an OFS_DELTA not pointing at an earlier entry", async () => {
    const bad = pack([
      { kind: 3, data: A },
      { kind: 6, back: 3, data: dAB },
    ]);
    expect((await refused(memObjects(), bad)).message).toMatch(/not an earlier entry/);
  });

  it("a thin pack whose base the store does not have", async () => {
    const err = await refused(memObjects(), pack([{ kind: 7, baseOid: Aid, data: dAB }]));
    expect(err.message).toMatch(/thin pack\? first missing base/);
  });

  it("an object over maxObjectSize, by its header or as a delta result", async () => {
    const objects = memObjects();
    const err = await unpackObjects(objects, chunks(good), { maxObjectSize: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
  });

  it("a collision: an incoming object whose id is stored with other bytes", async () => {
    // the store holds B's bytes under A's id: what a SHA-1 collision would look like
    const backing = new MemoryRawStorage();
    const rawB = concat([enc.encode(`blob ${B.length}\0`), B]);
    await backing.store(Aid, [compressBlockPako(rawB)]);
    const colliding = createGitObjects(rawStorageStaging(backing));
    const err = await refused(colliding, pack([{ kind: 3, data: A }]));
    expect(err).toBeInstanceOf(ObjectCollisionError);
    expect(err.message).toMatch(new RegExp(Aid));
  });

  it("a collision on a delta result", async () => {
    const backing = new MemoryRawStorage();
    const rawA = concat([enc.encode(`blob ${A.length}\0`), A]);
    await backing.store(Bid, [compressBlockPako(rawA)]);
    const colliding = createGitObjects(rawStorageStaging(backing));
    const err = await refused(
      colliding,
      pack([
        { kind: 3, data: A },
        { kind: 6, baseIdx: 0, data: dAB },
      ]),
    );
    expect(err).toBeInstanceOf(ObjectCollisionError);
  });
});

describe("importPack: unpackLimit decides between a pack and loose objects", () => {
  const blobs = (n: number) =>
    Array.from({ length: n }, (_, k) => ({ kind: 3, data: enc.encode(`blob ${k}\n`) }));

  async function setup() {
    const files = createInMemoryFilesApi();
    const objects = memObjects();
    const packs = await openPackSet(files, "/objects/pack", {
      externalBase: (id) => objects.get(id),
    });
    return { files, objects, packs };
  }

  it("keeps a pack of unpackLimit objects or more as a pack", async () => {
    const { objects, packs } = await setup();
    const r = await importPack(objects, chunks(pack(blobs(100)), 7), { packs });
    expect(r.kept?.count).toBe(100);
    expect(r.unpacked).toBeUndefined();
    expect(r.types.blob).toBe(100);
    expect(await packs.has(oidOf("blob", enc.encode("blob 42\n")))).toBe(true);
    expect(await objects.has(oidOf("blob", enc.encode("blob 42\n")))).toBe(false);
  });

  it("unpacks a smaller pack into loose objects", async () => {
    const { objects, packs } = await setup();
    const r = await importPack(objects, chunks(pack(blobs(99)), 7), { packs });
    expect(r.kept).toBeUndefined();
    expect(r.unpacked?.written).toBe(99);
    expect(await objects.has(oidOf("blob", enc.encode("blob 42\n")))).toBe(true);
    expect((await packs.packs()).length).toBe(0);
  });

  it("honours a custom unpackLimit, and always unpacks without a pack set", async () => {
    const { objects, packs } = await setup();
    const kept = await importPack(objects, chunks(pack(blobs(3))), { packs, unpackLimit: 3 });
    expect(kept.kept).toBeDefined();
    expect((await packs.packs()).length).toBe(1);
    const mem = memObjects();
    const r = await importPack(mem, chunks(pack(blobs(150))));
    expect(r.unpacked?.written).toBe(150);
  });

  it("keeps a thin pack, completed with bases from the store", async () => {
    const { objects, packs } = await setup();
    await objects.put("blob", A.length, [A]);
    const r = await importPack(
      objects,
      chunks(pack([{ kind: 7, baseOid: Aid, data: dAB }, ...blobs(2)])),
      { packs, unpackLimit: 1 },
    );
    expect(r.kept?.appended).toBe(1);
    expect(await packs.has(Bid)).toBe(true);
  });

  it("reads only the pack header to decide: the rest is pulled by the importer", async () => {
    const { objects, packs } = await setup();
    const bytes = pack(blobs(100));
    let pulled = 0;
    let pulledWhenInstallStarted = -1;
    const counted = (async function* () {
      for await (const c of chunks(bytes, 16)) {
        pulled += c.length;
        yield c;
      }
    })();
    const watched = {
      install: (source: AsyncIterable<Uint8Array>, o?: Parameters<typeof packs.install>[1]) => {
        pulledWhenInstallStarted = pulled;
        return packs.install(source, o);
      },
    };
    await importPack(objects, counted, { packs: watched });
    expect(pulledWhenInstallStarted).toBe(16);
    expect(pulled).toBe(bytes.length);
  });

  it("an empty stream imports nothing", async () => {
    const r = await importPack(memObjects(), chunks(new Uint8Array(0)));
    expect(r.count).toBe(0);
  });
});

describe("unpackObjects: bounded memory", () => {
  /** zlib with stored blocks (no compression), so a big pack is cheap to generate */
  function* storedZlib(data: Uint8Array): Generator<Uint8Array> {
    yield Uint8Array.of(0x78, 0x01);
    let a = 1;
    let b = 0;
    for (let o = 0; o < data.length || o === 0; o += 65535) {
      const block = data.subarray(o, o + 65535);
      const last = o + 65535 >= data.length;
      const len = block.length;
      yield Uint8Array.of(last ? 1 : 0, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255);
      yield block;
      for (const x of block) {
        a = (a + x) % 65521;
        b = (b + a) % 65521;
      }
      if (last) break;
    }
    yield Uint8Array.of(b >> 8, b & 255, a >> 8, a & 255);
  }

  function entryHeader(type: number, size: number): Uint8Array {
    const out: number[] = [];
    let c = (type << 4) | (size & 15);
    let s = Math.floor(size / 16);
    while (s) {
      out.push(c | 0x80);
      c = s & 127;
      s = Math.floor(s / 128);
    }
    out.push(c);
    return Uint8Array.from(out);
  }

  /** A pack of `sizes` blobs, generated as it is read; `progress.yielded` counts bytes handed out. */
  function lazyPack(sizes: number[], progress: { yielded: number }) {
    return (async function* () {
      const hash = createSha1();
      const out = (c: Uint8Array) => {
        hash.update(c);
        progress.yielded += c.length;
        return c;
      };
      const head = new Uint8Array(12);
      head.set(enc.encode("PACK"));
      new DataView(head.buffer).setUint32(4, 2);
      new DataView(head.buffer).setUint32(8, sizes.length);
      yield out(head);
      for (const [k, size] of sizes.entries()) {
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i += 4096) data[i] = (k + i / 4096) & 255;
        yield out(entryHeader(3, size));
        for (const c of storedZlib(data)) yield out(c.slice());
      }
      const trailer = hash.digest();
      progress.yielded += trailer.length;
      yield trailer;
    })();
  }

  it("streams a 50 MiB pack with bounded lag between reading and storing", async () => {
    const MiB = 2 ** 20;
    const sizes = [...Array.from({ length: 30 }, () => MiB), 20 * MiB];
    const progress = { yielded: 0 };
    let maxLag = 0;
    let stored = 0;
    let storedBytes = 0;
    const sink: UnpackTarget = {
      has: async () => false,
      get: async () => undefined,
      getRaw: () => (async function* () {})(),
      async putRaw(_id, raw) {
        for await (const c of raw) {
          maxLag = Math.max(maxLag, progress.yielded - storedBytes); // read, not yet stored
          storedBytes += c.length;
        }
        stored++;
      },
      async put(type, size, body) {
        const h = createSha1().update(enc.encode(`${type} ${size}\0`));
        for await (const c of body) {
          h.update(c);
          maxLag = Math.max(maxLag, progress.yielded - storedBytes);
          storedBytes += c.length;
        }
        stored++;
        return bytesToHex(h.digest());
      },
    };
    const r = await unpackObjects(sink, lazyPack(sizes, progress));
    expect(r.count).toBe(31);
    expect(stored).toBe(31);
    expect(progress.yielded).toBeGreaterThan(50 * MiB);
    // never more than about one object (1 MiB) and some framing ahead of the store
    expect(maxLag).toBeLessThan(2 * MiB);
  }, 60_000);
});

describe("DefaultSerializationApi.importPack delegates to importPack", () => {
  it("keeps commit headers it does not model (the bytes, hence the id)", async () => {
    const { createMemoryHistoryWithOperations } = await import("../../src/history/index.js");
    const history = createMemoryHistoryWithOperations();
    await history.initialize();
    const commit = enc.encode(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\nmergetag object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n type commit\n\nmsg\n",
    );
    const id = oidOf("commit", commit);
    const r = await history.serialization.importPack(chunks(pack([{ kind: 1, data: commit }])));
    expect(r.commitsImported).toBe(1);
    expect(await history.commits.has(id)).toBe(true);
    expect(await collect(history.objects?.getRaw(id) ?? [])).toEqual(
      concat([enc.encode(`commit ${commit.length}\0`), commit]),
    );
  });
});
