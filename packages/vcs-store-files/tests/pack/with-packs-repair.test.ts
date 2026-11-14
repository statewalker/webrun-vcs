/**
 * withPacks over a PackSet when packs go away or turn out corrupt: writes are not dropped for a
 * copy that cannot be read, a corrupt packed copy gives way to a loose one, and misses do not
 * list the pack directory each time.
 */
import {
  createInMemoryFilesApi,
  type FilesApi,
  installPack,
  joinPath,
  writePackIdx,
} from "@statewalker/vcs-core";
import { buildPack, copyAll, craftDelta, oidOf } from "@statewalker/vcs-testing";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, repack } from "../../src/index.js";

const enc = new TextEncoder();
const PACK_DIR = joinPath(".git", "objects", "pack");
const X = enc.encode("the object X\n".repeat(20));
const Xid = oidOf("blob", X);

async function* chunks(bytes: Uint8Array) {
  yield bytes;
}
async function text(s: AsyncIterable<Uint8Array> | undefined) {
  let out = "";
  for await (const c of s ?? []) out += new TextDecoder().decode(c, { stream: true });
  return out;
}
const packFiles = async (files: FilesApi) => {
  const out: string[] = [];
  for await (const e of files.list(PACK_DIR)) out.push(e.name);
  return out;
};
async function backend() {
  const files = createInMemoryFilesApi();
  const b = await createGitFilesBackend({ files, create: true });
  return { files, ...b };
}
/** Deletes every pack file behind the backend's back (as `git repack -a -d` or gc would). */
async function deletePacks(files: FilesApi) {
  for (const name of await packFiles(files)) await files.remove(joinPath(PACK_DIR, name));
}

describe("writes are not dropped for a packed copy that cannot be read", () => {
  it("put of an object whose pack was deleted externally writes it loose", async () => {
    const { files, objects, packs } = await backend();
    await packs.install(chunks(buildPack([{ kind: 3, data: X }])));
    expect(await objects.has(Xid)).toBe(true);
    await deletePacks(files);
    expect(await objects.put("blob", X.length, [X])).toBe(Xid);
    expect(await text((await objects.get(Xid))?.content)).toBe(new TextDecoder().decode(X));
  });

  it("putRaw of an object whose pack was deleted externally writes it loose", async () => {
    const { files, objects, packs } = await backend();
    await packs.install(chunks(buildPack([{ kind: 3, data: X }])));
    await deletePacks(files);
    await objects.putRaw(Xid, [enc.encode(`blob ${X.length}\0`), X]);
    expect(await text((await objects.get(Xid))?.content)).toBe(new TextDecoder().decode(X));
  });

  it("a write repairs an object whose only packed copy is corrupt", async () => {
    const { files, objects } = await backend();
    // X stored as a REF_DELTA on a base that exists nowhere: reading it fails
    const bytes = buildPack([
      { kind: 7, baseOid: "e".repeat(40), data: craftDelta(5, X.length, copyAll(5)) },
    ]);
    const checksum = bytes.subarray(bytes.length - 20);
    const name = `pack-${Buffer.from(checksum).toString("hex")}`;
    await files.write(joinPath(PACK_DIR, `${name}.pack`), [bytes]);
    await files.write(joinPath(PACK_DIR, `${name}.idx`), [
      writePackIdx([{ id: Xid, offset: 12, crc32: 0 }], checksum),
    ]);
    await expect(objects.get(Xid)).rejects.toThrow();
    await objects.put("blob", X.length, [X]);
    expect(await text((await objects.get(Xid))?.content)).toBe(new TextDecoder().decode(X));
  });
});

describe("a corrupt packed whole object gives way to a good loose copy", () => {
  it("get returns the loose content, now and next time", async () => {
    const { files, objects } = await backend();
    await objects.put("blob", X.length, [X]); // the good loose copy
    const big = enc.encode(Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join(""));
    const bigId = oidOf("blob", big);
    await objects.put("blob", big.length, [big]);
    // a pack holding the same object, its zlib stream corrupted after install
    const r = await installPack(files, PACK_DIR, chunks(buildPack([{ kind: 3, data: big }])));
    const path = joinPath(PACK_DIR, `pack-${r.packId}.pack`);
    const parts: Uint8Array[] = [];
    for await (const c of files.read(path)) parts.push(c);
    const raw = Uint8Array.from(Buffer.concat(parts));
    raw[60] = (raw[60] as number) ^ 0x40;
    await files.write(path, [raw]);
    const { objects: reopened } = await createGitFilesBackend({ files });
    for (let i = 0; i < 2; i++) {
      const o = await reopened.get(bigId, { verify: true });
      expect(await text(o?.content)).toBe(new TextDecoder().decode(big));
    }
    expect(await text(reopened.getRaw(bigId))).toBe(
      `blob ${big.length}\0${new TextDecoder().decode(big)}`,
    );
    expect(hexToBytes(Xid).length).toBe(20);
  });
});

describe("misses are rate-limited", () => {
  it("100 misses list the pack directory at most twice", async () => {
    const files = createInMemoryFilesApi();
    const { objects } = await createGitFilesBackend({ files, create: true });
    let lists = 0;
    const list = files.list.bind(files);
    files.list = (path, o) => {
      if (path.endsWith("pack")) lists++;
      return list(path, o);
    };
    for (let i = 0; i < 100; i++) {
      const id = i.toString(16).padStart(40, "0");
      expect(await objects.has(id)).toBe(false);
      expect(await objects.get(id)).toBeUndefined();
    }
    expect(lists).toBeLessThanOrEqual(2);
  });

  it("a pack written by an in-process repack is read at once by the same backend", async () => {
    const files = createInMemoryFilesApi();
    const { history, objects, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    const id = await history.blobs.store([enc.encode("pack me")]);
    expect(await objects.has("0".repeat(40))).toBe(false); // spends the free rescan
    await repack({ looseStorage, packDirectory, files });
    expect(await looseStorage.has(id)).toBe(false);
    expect(await text((await objects.get(id))?.content)).toBe("pack me");
  });
});
