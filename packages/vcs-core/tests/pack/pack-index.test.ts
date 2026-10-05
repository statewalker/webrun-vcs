/**
 * Tests for pack index reading and writing
 *
 * Based on storage-git pack-index tests and JGit PackIndexTest
 */

import { setCompressionUtils } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PackIndexWriterEntry,
  readPackIndex,
  writePackIndexV1,
  writePackIndexV2,
} from "../../src/pack/index.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Generate a sample pack checksum for tests
 */
async function samplePackChecksum(): Promise<Uint8Array> {
  return await sha1(new TextEncoder().encode("sample pack data"));
}

describe("pack-index", () => {
  describe("writePackIndexV2 and readPackIndex roundtrip", () => {
    it("writes and reads empty index", async () => {
      const packChecksum = await samplePackChecksum();
      const indexData = await writePackIndexV2([], packChecksum);

      const index = readPackIndex(indexData);

      expect(index.version).toBe(2);
      expect(index.objectCount).toBe(0);
      expect(Array.from(index.packChecksum)).toEqual(Array.from(packChecksum));
    });

    it("writes and reads single entry", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          offset: 12,
          crc32: 0x12345678,
        },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.version).toBe(2);
      expect(index.objectCount).toBe(1);
      expect(index.has("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
      expect(index.findOffset("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(12);
      expect(index.findCRC32("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(0x12345678);
    });

    it("writes and reads multiple entries in sorted order", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "1111111111111111111111111111111111111111", offset: 12, crc32: 0x11111111 },
        { id: "2222222222222222222222222222222222222222", offset: 100, crc32: 0x22222222 },
        { id: "3333333333333333333333333333333333333333", offset: 200, crc32: 0x33333333 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.objectCount).toBe(3);
      expect(index.findOffset("1111111111111111111111111111111111111111")).toBe(12);
      expect(index.findOffset("2222222222222222222222222222222222222222")).toBe(100);
      expect(index.findOffset("3333333333333333333333333333333333333333")).toBe(200);
    });

    it("returns -1 for unknown objects", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.findOffset("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(-1);
      expect(index.has("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
    });

    it("supports entries across different fanout buckets", async () => {
      const packChecksum = await samplePackChecksum();
      // These IDs start with different bytes: 0x11, 0x55, 0xaa, 0xff
      const entries: PackIndexWriterEntry[] = [
        { id: "11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 100, crc32: 1 },
        { id: "55bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", offset: 200, crc32: 2 },
        { id: "aacccccccccccccccccccccccccccccccccccccc", offset: 300, crc32: 3 },
        { id: "ffdddddddddddddddddddddddddddddddddddddd", offset: 400, crc32: 4 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.objectCount).toBe(4);
      expect(index.findOffset("11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(100);
      expect(index.findOffset("55bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(200);
      expect(index.findOffset("aacccccccccccccccccccccccccccccccccccccc")).toBe(300);
      expect(index.findOffset("ffdddddddddddddddddddddddddddddddddddddd")).toBe(400);
    });
  });

  describe("writePackIndexV1 and readPackIndex roundtrip", () => {
    it("writes and reads empty index", async () => {
      const packChecksum = await samplePackChecksum();
      const indexData = await writePackIndexV1([], packChecksum);

      const index = readPackIndex(indexData);

      expect(index.version).toBe(1);
      expect(index.objectCount).toBe(0);
    });

    it("writes and reads single entry", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV1(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.version).toBe(1);
      expect(index.objectCount).toBe(1);
      expect(index.has("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
      expect(index.findOffset("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(12);
    });

    it("V1 does not support CRC32", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0x12345678 },
      ];

      const indexData = await writePackIndexV1(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.hasCRC32Support()).toBe(false);
      expect(index.findCRC32("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
    });
  });

  describe("index iteration", () => {
    it("iterates entries in sorted order", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "1111111111111111111111111111111111111111", offset: 12, crc32: 1 },
        { id: "2222222222222222222222222222222222222222", offset: 24, crc32: 2 },
        { id: "3333333333333333333333333333333333333333", offset: 36, crc32: 3 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const iterated = Array.from(index.entries());
      expect(iterated.length).toBe(3);
      expect(iterated[0].id).toBe("1111111111111111111111111111111111111111");
      expect(iterated[1].id).toBe("2222222222222222222222222222222222222222");
      expect(iterated[2].id).toBe("3333333333333333333333333333333333333333");
    });

    it("lists all object IDs", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
        { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", offset: 24, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const ids = Array.from(index.listObjects());
      expect(ids.length).toBe(2);
      expect(ids).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(ids).toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    });
  });

  describe("prefix resolution", () => {
    it("resolves full ID", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const matches = index.resolve("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(matches).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    });

    it("resolves short prefix", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aa11111111111111111111111111111111111111", offset: 12, crc32: 0 },
        { id: "aa22222222222222222222222222222222222222", offset: 24, crc32: 0 },
        { id: "bb33333333333333333333333333333333333333", offset: 36, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const matches = index.resolve("aa");
      expect(matches.length).toBe(2);
      expect(matches).toContain("aa11111111111111111111111111111111111111");
      expect(matches).toContain("aa22222222222222222222222222222222222222");
    });

    it("respects limit", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aa11111111111111111111111111111111111111", offset: 12, crc32: 0 },
        { id: "aa22222222222222222222222222222222222222", offset: 24, crc32: 0 },
        { id: "aa33333333333333333333333333333333333333", offset: 36, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const matches = index.resolve("aa", 2);
      expect(matches.length).toBe(2);
    });

    it("returns empty for no matches", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      const matches = index.resolve("bb");
      expect(matches).toEqual([]);
    });
  });

  describe("getObjectId and getOffset by position", () => {
    it("gets object at nth position", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "1111111111111111111111111111111111111111", offset: 100, crc32: 0 },
        { id: "2222222222222222222222222222222222222222", offset: 200, crc32: 0 },
        { id: "3333333333333333333333333333333333333333", offset: 300, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.getObjectId(0)).toBe("1111111111111111111111111111111111111111");
      expect(index.getObjectId(1)).toBe("2222222222222222222222222222222222222222");
      expect(index.getObjectId(2)).toBe("3333333333333333333333333333333333333333");
      expect(index.getOffset(0)).toBe(100);
      expect(index.getOffset(1)).toBe(200);
      expect(index.getOffset(2)).toBe(300);
    });
  });

  describe("findPosition", () => {
    it("finds position of object", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "1111111111111111111111111111111111111111", offset: 100, crc32: 0 },
        { id: "2222222222222222222222222222222222222222", offset: 200, crc32: 0 },
        { id: "3333333333333333333333333333333333333333", offset: 300, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(index.findPosition("1111111111111111111111111111111111111111")).toBe(0);
      expect(index.findPosition("2222222222222222222222222222222222222222")).toBe(1);
      expect(index.findPosition("3333333333333333333333333333333333333333")).toBe(2);
      expect(index.findPosition("4444444444444444444444444444444444444444")).toBe(-1);
    });
  });

  describe("checksums", () => {
    it("stores pack checksum", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      expect(Array.from(index.packChecksum)).toEqual(Array.from(packChecksum));
    });

    it("computes and stores index checksum", async () => {
      const packChecksum = await samplePackChecksum();
      const entries: PackIndexWriterEntry[] = [
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", offset: 12, crc32: 0 },
      ];

      const indexData = await writePackIndexV2(entries, packChecksum);
      const index = readPackIndex(indexData);

      // Index checksum should be 20 bytes
      expect(index.indexChecksum.length).toBe(20);
    });
  });
});
