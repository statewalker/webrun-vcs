/**
 * Packs of a SHA-256 repository, in memory: pack-objects (`writePack`) streams a pack whose
 * trailer and REF_DELTA bases are SHA-256, index-pack (`installPack`) checks it and writes a
 * `.idx` v2 of 32-byte ids with its `.rev` (hash id 2), `openPack`/`openPackSet` read it, and
 * unpack-objects stores its objects loose. The native-git comparisons live in
 * vcs-commands/tests/sha256-packs-native.test.ts.
 */

import { SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import { createGitObjects } from "../../src/history/objects/git-objects.impl.js";
import {
  encodePackMtimes,
  encodeReverseIndex,
  installPack,
  type ListedObject,
  listObjects,
  openPack,
  openPackSet,
  PackError,
  parsePackMtimes,
  parseReverseIndex,
  readPackIndex,
  unpackObjects,
  writePack,
  writePackIdx,
} from "../../src/pack/index.js";
import { rawStorageStaging } from "../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../src/storage/raw/memory-raw-storage.js";

const enc = new TextEncoder();
const PACK_DIR = "/objects/pack";
const sha256Objects = () =>
  createGitObjects(rawStorageStaging(new MemoryRawStorage()), {
    objectFormat: SHA256_OBJECT_FORMAT,
  });

/** A store with a few versions of a file that deltify, and their trees. */
async function history() {
  const objects = sha256Objects();
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} of a text that deltifies`);
  const ids: ListedObject[] = [];
  for (let v = 0; v < 4; v++) {
    lines[v * 9] = `version ${v}`;
    const id = await objects.putUnsized("blob", [enc.encode(`${lines.join("\n")}\n`)]);
    ids.push({ id, type: "blob", path: "file.txt" });
  }
  return { objects, ids };
}

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("SHA-256 packs", () => {
  for (const ofsDelta of [true, false]) {
    it(`writes, indexes and reads a pack with ${ofsDelta ? "OFS" : "REF"}_DELTA entries`, async () => {
      const { objects, ids } = await history();
      const pack = await bytesOf(writePack(objects, ids, { deltaSearch: true, ofsDelta }));
      const files = createInMemoryFilesApi();
      const installed = await installPack(files, PACK_DIR, once(pack), {
        objectFormat: SHA256_OBJECT_FORMAT,
        writeReverseIndex: true,
      });
      expect(installed.packId).toMatch(/^[0-9a-f]{64}$/);
      expect(installed.count).toBe(ids.length);
      // the trailer is the SHA-256 of the pack
      const trailer = pack.subarray(pack.length - 32);
      expect(
        Buffer.from(await SHA256_OBJECT_FORMAT.digest(pack.subarray(0, pack.length - 32))),
      ).toEqual(Buffer.from(trailer));
      const name = `${PACK_DIR}/pack-${installed.packId}`;
      const idxBytes = await bytesOf(files.read(`${name}.idx`));
      const idx = readPackIndex(idxBytes, 32);
      expect(idx.objectCount).toBe(ids.length);
      expect(idx.rawLength).toBe(32);
      expect(Buffer.from(idx.packChecksum)).toEqual(Buffer.from(trailer));
      for (const { id } of ids) expect(idx.has(id)).toBe(true);
      // the .rev carries SHA-256's hash id and checksums
      const rev = await bytesOf(files.read(`${name}.rev`));
      expect(new DataView(rev.buffer, rev.byteOffset).getUint32(8)).toBe(2);
      expect(
        parseReverseIndex(rev, ids.length, "rev", {
          verify: true,
          objectFormat: SHA256_OBJECT_FORMAT,
        }),
      ).toHaveLength(ids.length);

      const opened = await openPack(files, `${name}.pack`, `${name}.idx`, {
        objectFormat: SHA256_OBJECT_FORMAT,
        verifyIndex: true,
      });
      // read before the pack order is first needed (an OFS_DELTA's extent computes it)
      expect(await opened.loadReverseIndex?.()).toBe("loaded");
      let deltas = 0;
      for (const { id } of ids) {
        const entry = await opened.entry(id);
        if (entry && entry.kind > 4) {
          deltas++;
          expect(entry.kind).toBe(ofsDelta ? 6 : 7);
          expect(entry.baseId).toMatch(/^[0-9a-f]{64}$/);
        }
        const obj = await opened.get(id, { verify: true });
        const want = await objects.get(id);
        expect(Buffer.from(await bytesOf(obj?.content ?? once(new Uint8Array())))).toEqual(
          Buffer.from(await bytesOf(want?.content ?? once(new Uint8Array()))),
        );
      }
      expect(deltas).toBeGreaterThan(0);
      expect(await opened.verifyReverseIndex?.()).toBeUndefined();
      opened.close();

      // a pack set of the directory, and a SHA-1 one that does not take it
      const set = await openPackSet(files, PACK_DIR, { objectFormat: SHA256_OBJECT_FORMAT });
      for (const { id } of ids) expect(await set.has(id)).toBe(true);
      expect(await set.bitmap?.()).toBeUndefined();
      const sha1Set = await openPackSet(files, PACK_DIR);
      expect(await sha1Set.packs()).toEqual([]);

      // unpack-objects of the same pack
      const target = sha256Objects();
      const unpacked = await unpackObjects(target, once(pack));
      expect(unpacked.count).toBe(ids.length);
      for (const { id } of ids) expect(await target.has(id)).toBe(true);
    });
  }

  it("writes git's idx layout: writePackIdx takes the width from the checksum", async () => {
    const { objects, ids } = await history();
    const pack = await bytesOf(writePack(objects, ids));
    const files = createInMemoryFilesApi();
    const installed = await installPack(files, PACK_DIR, once(pack), {
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    const name = `${PACK_DIR}/pack-${installed.packId}`;
    const idxBytes = await bytesOf(files.read(`${name}.idx`));
    const idx = readPackIndex(idxBytes, 32);
    const entries = [...idx.entries()].map((e) => ({
      id: e.id,
      offset: e.offset,
      crc32: e.crc32 ?? 0,
    }));
    const again = writePackIdx(entries, pack.subarray(pack.length - 32), SHA256_OBJECT_FORMAT);
    expect(Buffer.from(again)).toEqual(Buffer.from(idxBytes));
    // 8 + 1024 + n * (32 + 4 + 4) + 2 * 32
    expect(idxBytes.length).toBe(8 + 1024 + ids.length * 40 + 64);
  });

  it("refuses a pack whose trailer is not its SHA-256", async () => {
    const { objects, ids } = await history();
    const pack = await bytesOf(writePack(objects, ids));
    pack[pack.length - 1] ^= 1;
    await expect(
      installPack(createInMemoryFilesApi(), PACK_DIR, once(pack), {
        objectFormat: SHA256_OBJECT_FORMAT,
      }),
    ).rejects.toThrow(PackError);
    // and a SHA-256 pack read as SHA-1 is not one
    const good = await bytesOf(writePack(objects, ids));
    await expect(installPack(createInMemoryFilesApi(), PACK_DIR, once(good))).rejects.toThrow(
      PackError,
    );
  });

  it("encodes and reads .mtimes with SHA-256 checksums", () => {
    const checksum = new Uint8Array(32).fill(7);
    const bytes = encodePackMtimes([1, 2, 3], checksum, SHA256_OBJECT_FORMAT);
    expect(bytes.length).toBe(12 + 3 * 4 + 64);
    expect(new DataView(bytes.buffer).getUint32(8)).toBe(2);
    expect([...parsePackMtimes(bytes, 3, "x", SHA256_OBJECT_FORMAT)]).toEqual([1, 2, 3]);
  });

  it("lists the objects of SHA-256 trees", async () => {
    const objects = sha256Objects();
    const blob = await objects.putUnsized("blob", [enc.encode("hello\n")]);
    const raw = new Uint8Array([...enc.encode("100644 a.txt\0"), ...Buffer.from(blob, "hex")]);
    const tree = await objects.putUnsized("tree", [raw]);
    const listed: ListedObject[] = [];
    for await (const o of listObjects(objects, { wants: [tree] })) listed.push(o);
    expect(listed.map((o) => [o.id, o.type, o.path])).toEqual([
      [tree, "tree", ""],
      [blob, "blob", "a.txt"],
    ]);
  });

  // review of #236 (medium): a `.rev`/`.mtimes` must carry the repository's hash id
  it("refuses a .rev or .mtimes of the other format", async () => {
    // git sizes the file by the repository's hash first (`is corrupt`), then wants its id
    const sha1Rev = encodeReverseIndex([0, 1], new Uint8Array(20));
    expect(() =>
      parseReverseIndex(sha1Rev, 2, "x.rev", { objectFormat: SHA256_OBJECT_FORMAT }),
    ).toThrow(/reverse-index file x.rev is (too small|corrupt)/);
    const sha256Rev = encodeReverseIndex([0, 1], new Uint8Array(32), SHA256_OBJECT_FORMAT);
    expect([
      ...parseReverseIndex(sha256Rev, 2, "x.rev", { objectFormat: SHA256_OBJECT_FORMAT }),
    ]).toEqual([0, 1]);
    expect(() => parseReverseIndex(sha256Rev, 2, "x.rev")).toThrow(
      "reverse-index file x.rev is corrupt",
    );
    // the right size, the other hash id
    const wrongId = sha256Rev.slice();
    new DataView(wrongId.buffer).setUint32(8, 1);
    expect(() =>
      parseReverseIndex(wrongId, 2, "x.rev", { objectFormat: SHA256_OBJECT_FORMAT }),
    ).toThrow("reverse-index file x.rev has unsupported hash id 1");
    const mtimes = encodePackMtimes([5], new Uint8Array(32), SHA256_OBJECT_FORMAT);
    expect([...parsePackMtimes(mtimes, 1, "x.mtimes", SHA256_OBJECT_FORMAT)]).toEqual([5]);
    const wrongMtimes = mtimes.slice();
    new DataView(wrongMtimes.buffer).setUint32(8, 1);
    expect(() => parsePackMtimes(wrongMtimes, 1, "x.mtimes", SHA256_OBJECT_FORMAT)).toThrow(
      "mtimes file x.mtimes has unsupported hash id 1",
    );
    expect(() => parsePackMtimes(mtimes, 1, "x.mtimes")).toThrow();
    // the encoders are told the format, never guess it from the checksum
    expect(() => encodeReverseIndex([0], new Uint8Array(32))).toThrow();
    expect(() => encodePackMtimes([0], new Uint8Array(20), SHA256_OBJECT_FORMAT)).toThrow();
    expect(() => writePackIdx([], new Uint8Array(32))).toThrow();
  });

  it("a SHA-256 pack ignores a .rev of the other format", async () => {
    const { objects, ids } = await history();
    const pack = await bytesOf(writePack(objects, ids));
    const files = createInMemoryFilesApi();
    const installed = await installPack(files, PACK_DIR, once(pack), {
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    const name = `${PACK_DIR}/pack-${installed.packId}`;
    await files.write(`${name}.rev`, [
      encodeReverseIndex(new Uint32Array(ids.length), new Uint8Array(20)),
    ]);
    const opened = await openPack(files, `${name}.pack`, `${name}.idx`, {
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    expect(await opened.loadReverseIndex?.()).toMatch(
      /^error: reverse-index file .* (hash id 1|corrupt|too small)$/,
    );
    opened.close();
  });
});
