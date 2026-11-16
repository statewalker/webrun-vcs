import { describe, expect, it } from "vitest";
import {
  autoAbbrevLength,
  createGitObjects,
  findAbbrevLengths,
  type GitObjects,
  MemoryRawStorage,
  parseCoreAbbrev,
  rawStorageStaging,
} from "../../../src/index.js";

const enc = new TextEncoder();

describe("abbreviated object ids (repo_find_unique_abbrev)", () => {
  it("takes git's automatic length from the object count", () => {
    expect(autoAbbrevLength(0)).toBe(7);
    expect(autoAbbrevLength(16383)).toBe(7);
    expect(autoAbbrevLength(16384)).toBe(8);
    expect(autoAbbrevLength(65535)).toBe(8);
    expect(autoAbbrevLength(65536)).toBe(9);
    expect(autoAbbrevLength(262143)).toBe(9);
    expect(autoAbbrevLength(262144)).toBe(10);
    expect(autoAbbrevLength(4_000_000)).toBe(11);
    expect(autoAbbrevLength(4_200_000)).toBe(12);
  });

  it("reads core.abbrev as git does", () => {
    expect(parseCoreAbbrev(undefined)).toBe(-1);
    expect(parseCoreAbbrev("auto")).toBe(-1);
    expect(parseCoreAbbrev("no")).toBe(40);
    expect(parseCoreAbbrev("false")).toBe(40);
    expect(parseCoreAbbrev("12")).toBe(12);
    expect(parseCoreAbbrev("3")).toBeUndefined();
    expect(parseCoreAbbrev("yes")).toBeUndefined();
  });

  it("lengthens an id until no other object shares its prefix", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const bytes = enc.encode(`blob ${i}\n`);
      ids.push(await objects.put("blob", bytes.length, [bytes]));
    }
    const lengths = await findAbbrevLengths(objects, ids, 1);
    const sorted = [...ids].sort();
    for (const [i, id] of sorted.entries()) {
      // the shortest prefix that no neighbour shares
      let need = 1;
      for (const other of [sorted[i - 1], sorted[i + 1]]) {
        if (!other) continue;
        let common = 0;
        while (id[common] === other[common]) common++;
        need = Math.max(need, common + 1);
      }
      expect(lengths.get(id)).toBe(need);
    }
    // an id that is not stored (a worktree file's) gets the same treatment
    const absent = `${sorted[0].slice(0, 6)}${"0".repeat(34)}`;
    const forAbsent = await findAbbrevLengths(objects, [absent], 4);
    expect(forAbsent.get(absent)).toBeGreaterThanOrEqual(7);
  });

  it("counts objects with approximateCount, else by listing them", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const bytes = enc.encode("x\n");
    const id = await objects.put("blob", bytes.length, [bytes]);
    expect(await objects.approximateCount?.()).toBe(1);
    const big: GitObjects = { ...objects, approximateCount: async () => 20000 };
    expect((await findAbbrevLengths(big, [id])).get(id)).toBe(8);
    const { approximateCount: _drop, ...listed } = objects;
    expect((await findAbbrevLengths(listed, [id])).get(id)).toBe(7);
    expect((await findAbbrevLengths(objects, [id], 0)).get(id)).toBe(40);
  });
});
