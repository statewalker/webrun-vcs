/**
 * `maxObjectSize` guards what a read must hold in memory (a delta's instructions, a delta's
 * result, a whole object read as a delta's base); a whole object read on its own streams, as
 * git's `open_istream` streams a blob above core.bigFileThreshold, so it may exceed the limit
 * (statewalker/webrun-vcs#477: git's t5004 "zip archive with files bigger than 4GB" packs a
 * 4100 MiB blob). The limit is lowered here so that a few MiB stand for gigabytes.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi } from "../../src/common/files/index.js";
import { installPack, openPack, openPackSet, PackError } from "../../src/pack/index.js";
import { buildPack, chunks, delta, oidOf } from "./pack-builder.js";

const MiB = 1024 * 1024;
const PACK_DIR = "/objects/pack";

/** A blob of `size` bytes, not all equal. */
const blobOf = (size: number) => {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i += 4093) b[i] = (i >> 12) & 255;
  return b;
};

async function packOf(entries: Parameters<typeof buildPack>[0]) {
  const files = createInMemoryFilesApi();
  const r = await installPack(files, PACK_DIR, chunks(buildPack(entries).bytes, 64 * 1024));
  const base = `${PACK_DIR}/pack-${r.packId}`;
  return { files, packPath: `${base}.pack`, idxPath: `${base}.idx` };
}

async function bytesOf(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of content) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

describe("packed objects above maxObjectSize (statewalker/webrun-vcs#477)", () => {
  const big = blobOf(3 * MiB);
  const bigId = oidOf("blob", big);
  // a delta of 10 bytes over the big blob: its base must be held
  const small = big.subarray(0, 10);
  const smallId = oidOf("blob", small);

  it("a whole blob over the limit gives its size from the header and streams", async () => {
    const { files, packPath, idxPath } = await packOf([{ kind: 3, data: big }]);
    const pack = await openPack(files, packPath, idxPath, { maxObjectSize: MiB });
    expect(await pack.header(bigId)).toEqual({ type: "blob", size: big.length });
    expect(await pack.objectType(bigId)).toBe("blob");
    for (const verify of [false, true]) {
      const o = await pack.get(bigId, { verify });
      expect(o?.type).toBe("blob");
      expect(o?.size).toBe(big.length);
      // streamed, never handed out whole
      expect(o?.bytes).toBeUndefined();
      expect(equal(await bytesOf(o?.content as AsyncIterable<Uint8Array>), big)).toBe(true);
    }
  });

  it("through a pack set, as the files backend opens it", async () => {
    const { files } = await packOf([{ kind: 3, data: big }]);
    const set = await openPackSet(files, PACK_DIR, { maxObjectSize: MiB });
    expect(await set.header?.(bigId)).toEqual({ type: "blob", size: big.length });
    const o = await set.get(bigId, { verify: true });
    expect(equal(await bytesOf(o?.content as AsyncIterable<Uint8Array>), big)).toBe(true);
  });

  it("a whole object over the limit is still refused as a delta's base", async () => {
    const { files, packPath, idxPath } = await packOf([
      { kind: 3, data: big },
      { kind: 6, data: delta(big.length, 10, [0x90, 10]), baseIdx: 0 },
    ]);
    const pack = await openPack(files, packPath, idxPath, { maxObjectSize: MiB });
    await expect(pack.get(smallId)).rejects.toThrow(/over the limit of 1048576/);
    await expect(pack.get(smallId)).rejects.toBeInstanceOf(PackError);
    // the base itself still streams
    const o = await pack.get(bigId);
    expect(equal(await bytesOf(o?.content as AsyncIterable<Uint8Array>), big)).toBe(true);
    // under the default limit the delta resolves
    const open = await openPack(files, packPath, idxPath);
    const r = await open.get(smallId);
    expect(equal(await bytesOf(r?.content as AsyncIterable<Uint8Array>), small)).toBe(true);
  });

  it("a delta whose instructions or result exceed the limit is refused", async () => {
    // a delta copying the whole big blob: its result would be held
    const { files, packPath, idxPath } = await packOf([
      { kind: 3, data: small },
      {
        kind: 6,
        // inserts of 127 bytes, enough of them to pass 1 MiB of instructions
        data: delta(
          10,
          10 * 1024 * 127,
          Array.from({ length: 10 * 1024 }, () => [127, ...new Array(127).fill(65)]).flat(),
        ),
        baseIdx: 0,
      },
    ]);
    const pack = await openPack(files, packPath, idxPath, { maxObjectSize: MiB });
    const id = oidOf("blob", new Uint8Array(10 * 1024 * 127).fill(65));
    await expect(pack.get(id)).rejects.toThrow(/over the limit of 1048576/);
  });
});
