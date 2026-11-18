/**
 * `scanPackObjects`, counted: a REF_DELTA whose base is an earlier entry of the same pack is
 * unpacked as an OFS_DELTA is (git's pack-objects writes bases first either way), a pack whose
 * deltas mostly cannot be resolved (bases in no earlier entry) is not read to its end, and
 * `visit` returning false stops the read.
 */
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { createInMemoryFilesApi, type FilesApi } from "../../src/common/files/index.js";
import { readPackIndex, scanPackObjects, writePackIdx } from "../../src/pack/index.js";
import { buildPack, type Entry, extend, oidOf } from "./pack-builder.js";

const enc = new TextEncoder();
const PACK_DIR = "/objects/pack";

/** Writes the pack of `entries` with an idx naming them `ids`; the bytes read are counted. */
async function write(entries: Entry[], ids: string[]) {
  const files = createInMemoryFilesApi();
  const built = buildPack(entries);
  const checksum = built.bytes.subarray(built.bytes.length - 20);
  const idxBytes = writePackIdx(
    ids.map((id, i) => ({
      id,
      offset: built.offsets[i] as number,
      crc32: crc32(built.bytes.subarray(built.offsets[i], built.ends[i])),
    })),
    checksum,
  );
  const packPath = `${PACK_DIR}/pack-${bytesToHex(checksum)}.pack`;
  await files.write(packPath, [built.bytes]);
  const read = { bytes: 0 };
  const counted = new Proxy(files, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "read") return typeof value === "function" ? value.bind(target) : value;
      return async function* (path: string, o?: unknown) {
        for await (const c of (value as FilesApi["read"]).call(target, path, o as never)) {
          read.bytes += c.length;
          yield c;
        }
      };
    },
  }) as FilesApi;
  return { files: counted, packPath, idxBytes, idx: readPackIndex(idxBytes), built, read };
}

/** `n` trees, each the one before with a line more: whole first, then REF_DELTAs on it. */
function refChain(n: number) {
  const versions = [enc.encode("100644 a\0".padEnd(400, "x"))];
  const entries: Entry[] = [{ kind: 2, data: versions[0] as Uint8Array }];
  for (let i = 1; i < n; i++) {
    const { data, d } = extend(versions[i - 1] as Uint8Array, `entry ${i}\n`);
    versions.push(data);
    entries.push({ kind: 7, data: d, baseOid: oidOf("tree", versions[i - 1] as Uint8Array) });
  }
  return { versions, entries, ids: versions.map((v) => oidOf("tree", v)) };
}

describe("scanPackObjects", () => {
  it("unpacks REF_DELTAs whose base is an earlier entry of the pack", async () => {
    const { versions, entries, ids } = refChain(40);
    const p = await write(entries, ids);
    const seen = new Map<string, Uint8Array>();
    const count = await scanPackObjects(
      p.files,
      p.packPath,
      p.idxBytes,
      p.idx,
      (type) => type === 2,
      (pos, type, content) => {
        expect(type).toBe(2);
        const at = 8 + 1024 + pos * 20;
        seen.set(bytesToHex(p.idxBytes.subarray(at, at + 20)), content.slice());
        return undefined;
      },
    );
    expect(count).toBe(40);
    for (const [i, id] of ids.entries()) {
      expect(
        Buffer.from(seen.get(id) as Uint8Array).equals(Buffer.from(versions[i] as Uint8Array)),
      ).toBe(true);
    }
    expect(p.read.bytes).toBe(p.built.bytes.length);
  });

  it("stops reading a pack whose deltas mostly have no base in it", async () => {
    // a thin pack: 600 REF_DELTAs on objects it does not hold, then 600 whole trees
    const entries: Entry[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 600; i++) {
      const data = enc.encode(`delta ${i}\n`.padEnd(200, "d"));
      entries.push({ kind: 7, data, baseOid: oidOf("blob", enc.encode(`absent ${i}`)) });
      ids.push(oidOf("tree", enc.encode(`fake ${i}`)));
    }
    for (let i = 0; i < 600; i++) {
      const data = enc.encode(`tree ${i}\n`.padEnd(200, "t"));
      entries.push({ kind: 2, data });
      ids.push(oidOf("tree", data));
    }
    const p = await write(entries, ids);
    const count = await scanPackObjects(
      p.files,
      p.packPath,
      p.idxBytes,
      p.idx,
      () => true,
      () => undefined,
    );
    // given up after 257 unresolved deltas: the 600 whole trees after them are not unpacked
    // (the store reads them when needed)
    expect(count).toBe(0);
  });

  it("stops where visit returns false", async () => {
    const { entries, ids } = refChain(40);
    const p = await write(entries, ids);
    let visits = 0;
    const count = await scanPackObjects(
      p.files,
      p.packPath,
      p.idxBytes,
      p.idx,
      () => true,
      () => ++visits < 10,
    );
    expect(visits).toBe(10);
    expect(count).toBe(10);
  });
});
