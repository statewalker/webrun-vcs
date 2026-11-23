import { SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";
import {
  encodeMultiPackIndex,
  type MidxPackSource,
  MultiPackIndexError,
  parseMultiPackIndex,
} from "../../src/pack/index.js";

/** A pack of `ids` at offsets 12, 112, ... */
const source = (name: string, ids: string[]): MidxPackSource => ({
  name,
  mtime: 1,
  count: ids.length,
  idAt: (i) => ids[i] as string,
  offsetAt: (i) => 12 + 100 * i,
});
const ids = (width: number, n: number) =>
  Array.from({ length: n }, (_, i) =>
    (i * 37 + 5)
      .toString(16)
      .padStart(2, "0")
      .repeat(width / 2),
  ).sort();

describe("multi-pack-index of SHA-256 repositories", () => {
  it("writes hash version 2 with 32-byte ids and reads it back in that format only", () => {
    const list = ids(64, 5);
    const encoded = encodeMultiPackIndex({
      packs: [source(`pack-${"a".repeat(64)}.idx`, list)],
      objectFormat: SHA256_OBJECT_FORMAT,
      revIndex: true,
    });
    expect(encoded.bytes[5]).toBe(2);
    expect(encoded.checksum).toHaveLength(64);
    const midx = parseMultiPackIndex(encoded.bytes, "multi-pack-index", undefined, {
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    expect(midx.checksumValid()).toBe(true);
    expect(midx.checksum).toBe(encoded.checksum);
    for (const [i, id] of list.entries()) {
      expect(midx.find(id)).toBe(i);
      expect(midx.idAt(i)).toBe(id);
      expect(midx.offsetAt(i)).toBe(12 + 100 * i);
    }
    // a 40-digit id is no id of this midx
    expect(midx.find((list[0] as string).slice(0, 40))).toBe(-1);
    // read as SHA-1: git's refusal of the hash version
    expect(() => parseMultiPackIndex(encoded.bytes, "multi-pack-index")).toThrow(
      new MultiPackIndexError("multi-pack-index hash version 2 does not match version 1"),
    );
  });

  it("refuses ids of the other width", () => {
    expect(() =>
      encodeMultiPackIndex({
        packs: [source(`pack-${"a".repeat(64)}.idx`, ids(40, 3))],
        objectFormat: SHA256_OBJECT_FORMAT,
      }),
    ).toThrow(MultiPackIndexError);
    expect(() =>
      encodeMultiPackIndex({
        packs: [source(`pack-${"a".repeat(40)}.idx`, ids(64, 3))],
        objectFormat: SHA1_OBJECT_FORMAT,
      }),
    ).toThrow(MultiPackIndexError);
  });
});
