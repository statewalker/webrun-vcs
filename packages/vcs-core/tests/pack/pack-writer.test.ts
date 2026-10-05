/**
 * Tests for pack file writing
 *
 * Based on storage-git pack-writer tests and JGit BasePackWriterTest
 */

import { setCompressionUtils } from "@statewalker/vcs-utils";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PackObjectType,
  type PackWriterObject,
  PackWriterStream,
  writePack,
} from "../../src/pack/index.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Compute SHA-1 hash of data (for pack name verification)
 */
async function sha1Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha1(data));
}

describe("pack-writer", () => {
  describe("crc32", () => {
    it("computes CRC32 of empty data", () => {
      expect(crc32(new Uint8Array([]))).toBe(0);
    });

    it("computes CRC32 of simple data", () => {
      const data = new TextEncoder().encode("hello");
      const result = crc32(data);
      // Known CRC32 of "hello"
      expect(result).toBe(0x3610a686);
    });

    it("computes CRC32 of binary data", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
      const result = crc32(data);
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe("writePack", () => {
    it("writes pack with single blob", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("foobar"),
        },
      ];

      const result = await writePack(objects);

      // Verify pack structure
      expect(result.packData.length).toBeGreaterThan(12 + 20); // header + checksum
      expect(result.packChecksum.length).toBe(20);
      expect(result.indexEntries.length).toBe(1);
      expect(result.indexEntries[0].id).toBe(objects[0].id);
    });

    it("writes pack with multiple objects", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "1111111111111111111111111111111111111111",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("content1"),
        },
        {
          id: "2222222222222222222222222222222222222222",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("content2"),
        },
        {
          id: "3333333333333333333333333333333333333333",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("content3"),
        },
      ];

      const result = await writePack(objects);

      expect(result.indexEntries.length).toBe(3);
      // Entries should be sorted by ID
      expect(result.indexEntries[0].id).toBe("1111111111111111111111111111111111111111");
      expect(result.indexEntries[1].id).toBe("2222222222222222222222222222222222222222");
      expect(result.indexEntries[2].id).toBe("3333333333333333333333333333333333333333");
    });

    it("produces valid pack header", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "0000000000000000000000000000000000000001",
          type: PackObjectType.BLOB,
          content: new Uint8Array([1, 2, 3]),
        },
      ];

      const result = await writePack(objects);

      // Check PACK signature
      expect(result.packData[0]).toBe(0x50); // P
      expect(result.packData[1]).toBe(0x41); // A
      expect(result.packData[2]).toBe(0x43); // C
      expect(result.packData[3]).toBe(0x4b); // K

      // Check version (2)
      expect(result.packData[4]).toBe(0);
      expect(result.packData[5]).toBe(0);
      expect(result.packData[6]).toBe(0);
      expect(result.packData[7]).toBe(2);

      // Check object count (1)
      expect(result.packData[8]).toBe(0);
      expect(result.packData[9]).toBe(0);
      expect(result.packData[10]).toBe(0);
      expect(result.packData[11]).toBe(1);
    });

    it("appends checksum at the end", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "0000000000000000000000000000000000000001",
          type: PackObjectType.BLOB,
          content: new Uint8Array([1, 2, 3]),
        },
      ];

      const result = await writePack(objects);

      // Last 20 bytes should be the checksum
      const checksumFromPack = result.packData.subarray(result.packData.length - 20);
      expect(Array.from(checksumFromPack)).toEqual(Array.from(result.packChecksum));
    });
  });

  describe("PackWriterStream", () => {
    it("builds pack incrementally", async () => {
      const writer = new PackWriterStream();

      await writer.addObject(
        "1111111111111111111111111111111111111111",
        PackObjectType.BLOB,
        new TextEncoder().encode("content1"),
      );
      await writer.addObject(
        "2222222222222222222222222222222222222222",
        PackObjectType.BLOB,
        new TextEncoder().encode("content2"),
      );

      const result = await writer.finalize();

      expect(result.indexEntries.length).toBe(2);
      expect(result.packChecksum.length).toBe(20);
    });

    it("tracks object offsets", async () => {
      const writer = new PackWriterStream();

      await writer.addObject(
        "1111111111111111111111111111111111111111",
        PackObjectType.BLOB,
        new TextEncoder().encode("content1"),
      );

      const offset1Before = writer.getObjectOffset("1111111111111111111111111111111111111111");
      expect(offset1Before).toBeDefined();

      await writer.addObject(
        "2222222222222222222222222222222222222222",
        PackObjectType.BLOB,
        new TextEncoder().encode("content2"),
      );

      const offset2Before = writer.getObjectOffset("2222222222222222222222222222222222222222");
      expect(offset2Before).toBeDefined();
      expect(offset1Before).toBeDefined();
      expect(offset2Before).toBeGreaterThan(offset1Before ?? 0);
    });

    it("prevents adding after finalization", async () => {
      const writer = new PackWriterStream();

      await writer.addObject(
        "1111111111111111111111111111111111111111",
        PackObjectType.BLOB,
        new Uint8Array([1]),
      );
      await writer.finalize();

      await expect(
        writer.addObject(
          "2222222222222222222222222222222222222222",
          PackObjectType.BLOB,
          new Uint8Array([2]),
        ),
      ).rejects.toThrow("Pack has been finalized");
    });

    it("prevents double finalization", async () => {
      const writer = new PackWriterStream();

      await writer.addObject(
        "1111111111111111111111111111111111111111",
        PackObjectType.BLOB,
        new Uint8Array([1]),
      );
      await writer.finalize();

      await expect(writer.finalize()).rejects.toThrow("Pack has already been finalized");
    });
  });

  /**
   * Empty pack tests
   * Based on JGit BasePackWriterTest
   */
  describe("empty pack", () => {
    it("writes empty pack with writePack", async () => {
      const result = await writePack([]);

      // Pack should have header (12 bytes) + checksum (20 bytes)
      expect(result.packData.length).toBe(12 + 20);

      // Verify header
      expect(result.packData[0]).toBe(0x50); // P
      expect(result.packData[1]).toBe(0x41); // A
      expect(result.packData[2]).toBe(0x43); // C
      expect(result.packData[3]).toBe(0x4b); // K

      // Version 2
      expect(result.packData[7]).toBe(2);

      // Object count 0
      expect(result.packData[11]).toBe(0);

      // No index entries
      expect(result.indexEntries.length).toBe(0);
    });

    it("writes empty pack with PackWriterStream", async () => {
      const writer = new PackWriterStream();
      const result = await writer.finalize();

      // Pack should have header (12 bytes) + checksum (20 bytes)
      expect(result.packData.length).toBe(12 + 20);

      // Verify header
      expect(result.packData[0]).toBe(0x50); // P
      expect(result.packData[1]).toBe(0x41); // A
      expect(result.packData[2]).toBe(0x43); // C
      expect(result.packData[3]).toBe(0x4b); // K

      // No index entries
      expect(result.indexEntries.length).toBe(0);
    });

    it("empty pack has valid checksum", async () => {
      const result = await writePack([]);

      // Checksum is SHA-1 of pack data (excluding the checksum itself)
      const dataWithoutChecksum = result.packData.subarray(0, result.packData.length - 20);
      const expectedChecksum = await sha1Hex(dataWithoutChecksum);

      // Verify checksum matches
      const actualChecksum = Array.from(result.packChecksum)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      expect(actualChecksum).toBe(expectedChecksum);
    });
  });

  /**
   * Pack name computation tests
   * Based on JGit BasePackWriterTest
   */
  describe("pack name computation", () => {
    it("pack checksum can be used as pack name", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("test content"),
        },
      ];

      const result = await writePack(objects);

      // Pack name is derived from checksum
      const packName = Array.from(result.packChecksum)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      expect(packName.length).toBe(40); // SHA-1 is 40 hex chars
      expect(/^[0-9a-f]{40}$/.test(packName)).toBe(true);
    });

    it("same objects produce same pack checksum", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("consistent content"),
        },
      ];

      const result1 = await writePack(objects);
      const result2 = await writePack(objects);

      // Same input should produce same checksum
      expect(Array.from(result1.packChecksum)).toEqual(Array.from(result2.packChecksum));
    });

    it("different objects produce different pack checksums", async () => {
      const objects1: PackWriterObject[] = [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("content A"),
        },
      ];

      const objects2: PackWriterObject[] = [
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("content B"),
        },
      ];

      const result1 = await writePack(objects1);
      const result2 = await writePack(objects2);

      // Different content should produce different checksums
      expect(Array.from(result1.packChecksum)).not.toEqual(Array.from(result2.packChecksum));
    });

    it("checksum is appended to pack data", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "cccccccccccccccccccccccccccccccccccccccc",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("checksum test"),
        },
      ];

      const result = await writePack(objects);

      // Last 20 bytes of pack data should be the checksum
      const lastBytes = result.packData.subarray(result.packData.length - 20);
      expect(Array.from(lastBytes)).toEqual(Array.from(result.packChecksum));
    });

    it("checksum is computed over all preceding data", async () => {
      const objects: PackWriterObject[] = [
        {
          id: "dddddddddddddddddddddddddddddddddddddddd",
          type: PackObjectType.BLOB,
          content: new TextEncoder().encode("verify checksum"),
        },
      ];

      const result = await writePack(objects);

      // Compute expected checksum
      const dataWithoutChecksum = result.packData.subarray(0, result.packData.length - 20);
      const expectedChecksum = await sha1Hex(dataWithoutChecksum);

      const actualChecksum = Array.from(result.packChecksum)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      expect(actualChecksum).toBe(expectedChecksum);
    });
  });

  describe("object types", () => {
    it("writes COMMIT objects", async () => {
      const commitContent =
        "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
        "author Test <test@test.com> 1234567890 +0000\n" +
        "committer Test <test@test.com> 1234567890 +0000\n\n" +
        "Test commit\n";

      const objects: PackWriterObject[] = [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          type: PackObjectType.COMMIT,
          content: new TextEncoder().encode(commitContent),
        },
      ];

      const result = await writePack(objects);

      expect(result.indexEntries.length).toBe(1);
      expect(result.indexEntries[0].id).toBe(objects[0].id);
    });

    it("writes TREE objects", async () => {
      const treeContent = new Uint8Array([
        // Tree entry: "100644 test.txt\0" + 20-byte SHA
        ...new TextEncoder().encode("100644 test.txt"),
        0,
        ...new Uint8Array(20).fill(0xab),
      ]);

      const objects: PackWriterObject[] = [
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          type: PackObjectType.TREE,
          content: treeContent,
        },
      ];

      const result = await writePack(objects);

      expect(result.indexEntries.length).toBe(1);
      expect(result.indexEntries[0].id).toBe(objects[0].id);
    });

    it("writes TAG objects", async () => {
      const tagContent =
        "object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
        "type commit\n" +
        "tag v1.0\n" +
        "tagger Test <test@test.com> 1234567890 +0000\n\n" +
        "Version 1.0\n";

      const objects: PackWriterObject[] = [
        {
          id: "cccccccccccccccccccccccccccccccccccccccc",
          type: PackObjectType.TAG,
          content: new TextEncoder().encode(tagContent),
        },
      ];

      const result = await writePack(objects);

      expect(result.indexEntries.length).toBe(1);
      expect(result.indexEntries[0].id).toBe(objects[0].id);
    });
  });

  describe("large content", () => {
    it("handles large content", async () => {
      // Create ~100KB of content
      const largeContent = new Uint8Array(100 * 1024);
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }

      const objects: PackWriterObject[] = [
        {
          id: "1234567890abcdef1234567890abcdef12345678",
          type: PackObjectType.BLOB,
          content: largeContent,
        },
      ];

      const result = await writePack(objects);

      expect(result.indexEntries.length).toBe(1);
      expect(result.packData.length).toBeGreaterThan(32); // header + some compressed data
    });
  });
});
