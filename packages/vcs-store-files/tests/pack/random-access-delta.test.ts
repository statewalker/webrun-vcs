/**
 * Tests for random access delta functionality
 *
 * Verifies that RandomAccessDeltaReader enables partial reads from
 * delta-reconstructed content without full chain reconstruction.
 */

import {
  analyzeDelta,
  createInMemoryFilesApi,
  type FilesApi,
  findInstructionsForRange,
  PackObjectType,
  PackWriterStream,
  readPackIndex,
  writePackIndexV2,
} from "@statewalker/vcs-core";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PackReader } from "../../src/pack/index.js";

// Set up Node.js compression before tests
beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/**
 * Encode a variable-length integer (Git varint format)
 */
function encodeVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  bytes.push(v & 0x7f);
  v >>= 7;
  while (v > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(v & 0x7f);
    v >>= 7;
  }
  return new Uint8Array(bytes);
}

/**
 * Create a delta that modifies the first byte and copies the rest
 */
function createFirstByteChangeDelta(baseSize: number, newFirstByte: number): Uint8Array {
  const baseSizeBytes = encodeVarInt(baseSize);
  const resultSizeBytes = encodeVarInt(baseSize);
  const copyLength = baseSize - 1;

  const copyBytes: number[] = [];
  let cmd = 0x80 | 0x01; // COPY + offset byte 0
  if (copyLength > 0) {
    cmd |= 0x10; // size byte 0
    if (copyLength > 255) cmd |= 0x20;
  }
  copyBytes.push(cmd);
  copyBytes.push(1); // offset = 1

  if (copyLength > 0) {
    copyBytes.push(copyLength & 0xff);
    if (copyLength > 255) copyBytes.push((copyLength >> 8) & 0xff);
  }

  const totalLength = baseSizeBytes.length + resultSizeBytes.length + 1 + 1 + copyBytes.length;
  const delta = new Uint8Array(totalLength);
  let offset = 0;

  delta.set(baseSizeBytes, offset);
  offset += baseSizeBytes.length;
  delta.set(resultSizeBytes, offset);
  offset += resultSizeBytes.length;
  delta[offset++] = 0x01; // INSERT 1 byte
  delta[offset++] = newFirstByte;
  delta.set(new Uint8Array(copyBytes), offset);

  return delta;
}

/**
 * Modify the first byte of data
 */
function modifyFirstByte(value: number, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  result.set(data);
  result[0] = value;
  return result;
}

/**
 * Generate a fake object ID
 */
function fakeId(n: number): string {
  return n.toString(16).padStart(40, "0");
}

describe("delta instruction analyzer", () => {
  it("analyzes simple INSERT + COPY delta", () => {
    const baseSize = 100;
    const delta = createFirstByteChangeDelta(baseSize, 0xaa);
    const analyzed = analyzeDelta(delta);

    expect(analyzed.baseSize).toBe(baseSize);
    expect(analyzed.resultSize).toBe(baseSize);
    expect(analyzed.instructions.length).toBe(2);

    // First instruction: INSERT
    const insert = analyzed.instructions[0];
    expect(insert.resultStart).toBe(0);
    expect(insert.length).toBe(1);
    expect(insert.instruction.type).toBe("insert");

    // Second instruction: COPY
    const copy = analyzed.instructions[1];
    expect(copy.resultStart).toBe(1);
    expect(copy.length).toBe(baseSize - 1);
    expect(copy.instruction.type).toBe("copy");
    if (copy.instruction.type === "copy") {
      expect(copy.instruction.baseOffset).toBe(1);
    }
  });

  it("finds instructions for range at start", () => {
    const baseSize = 100;
    const delta = createFirstByteChangeDelta(baseSize, 0xbb);
    const analyzed = analyzeDelta(delta);

    // Request first 10 bytes (overlaps INSERT and part of COPY)
    const instructions = findInstructionsForRange(analyzed, 0, 10);
    expect(instructions.length).toBe(2);
    expect(instructions[0].instruction.type).toBe("insert");
    expect(instructions[1].instruction.type).toBe("copy");
  });

  it("finds instructions for range in middle", () => {
    const baseSize = 100;
    const delta = createFirstByteChangeDelta(baseSize, 0xcc);
    const analyzed = analyzeDelta(delta);

    // Request bytes 50-60 (only COPY region)
    const instructions = findInstructionsForRange(analyzed, 50, 10);
    expect(instructions.length).toBe(1);
    expect(instructions[0].instruction.type).toBe("copy");
  });

  it("returns empty for out of bounds range", () => {
    const baseSize = 100;
    const delta = createFirstByteChangeDelta(baseSize, 0xdd);
    const analyzed = analyzeDelta(delta);

    const instructions = findInstructionsForRange(analyzed, 200, 10);
    expect(instructions.length).toBe(0);
  });
});

describe("random access delta reader", () => {
  let files: FilesApi;
  const basePath = "/repo/objects/pack";

  beforeEach(() => {
    files = createInMemoryFilesApi();
  });

  describe("non-delta objects", () => {
    it("reads partial content from non-delta object", async () => {
      const content = new Uint8Array(1000);
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 256;
      }
      const id = fakeId(1000);

      const writer = new PackWriterStream();
      await writer.addObject(id, PackObjectType.BLOB, content);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-test.pack`, [result.packData]);
      await files.write(`${basePath}/pack-test.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-test.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(id);
      expect(randomAccess).toBeDefined();
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      expect(await randomAccess.getSize()).toBe(content.length);

      // Read from middle
      const partial = await randomAccess.readAt(500, 100);
      expect(partial).toEqual(content.subarray(500, 600));

      // Read from start
      const start = await randomAccess.readAt(0, 50);
      expect(start).toEqual(content.subarray(0, 50));

      // Read from end
      const end = await randomAccess.readAt(950, 100);
      expect(end).toEqual(content.subarray(950, 1000));

      await reader.close();
    });
  });

  describe("single-level delta", () => {
    it("reads from start of delta result", async () => {
      const baseContent = new Uint8Array(512).fill(0xf3);
      const baseId = fakeId(2000);

      const deltaContent = modifyFirstByte(0x01, baseContent);
      const deltaId = fakeId(2001);
      const delta = createFirstByteChangeDelta(baseContent.length, 0x01);

      const writer = new PackWriterStream();
      await writer.addObject(baseId, PackObjectType.BLOB, baseContent);
      await writer.addRefDelta(deltaId, baseId, delta);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-delta.pack`, [result.packData]);
      await files.write(`${basePath}/pack-delta.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-delta.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(deltaId);
      expect(randomAccess).toBeDefined();
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      expect(await randomAccess.getSize()).toBe(deltaContent.length);

      // Read first 10 bytes (includes INSERT and COPY regions)
      const start = await randomAccess.readAt(0, 10);
      expect(start).toEqual(deltaContent.subarray(0, 10));

      // Verify first byte is the new value
      expect(start[0]).toBe(0x01);

      await reader.close();
    });

    it("reads from middle of delta result (COPY region only)", async () => {
      const baseContent = new Uint8Array(512).fill(0xf3);
      const baseId = fakeId(3000);

      const deltaContent = modifyFirstByte(0x02, baseContent);
      const deltaId = fakeId(3001);
      const delta = createFirstByteChangeDelta(baseContent.length, 0x02);

      const writer = new PackWriterStream();
      await writer.addObject(baseId, PackObjectType.BLOB, baseContent);
      await writer.addRefDelta(deltaId, baseId, delta);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-delta2.pack`, [result.packData]);
      await files.write(`${basePath}/pack-delta2.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-delta2.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(deltaId);
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      // Read from middle (should be all 0xf3 from base)
      const middle = await randomAccess.readAt(100, 50);
      expect(middle).toEqual(deltaContent.subarray(100, 150));
      expect(middle.every((b) => b === 0xf3)).toBe(true);

      await reader.close();
    });

    it("reads across INSERT/COPY boundary", async () => {
      const baseContent = new Uint8Array(512).fill(0xaa);
      const baseId = fakeId(4000);

      const deltaContent = modifyFirstByte(0xbb, baseContent);
      const deltaId = fakeId(4001);
      const delta = createFirstByteChangeDelta(baseContent.length, 0xbb);

      const writer = new PackWriterStream();
      await writer.addObject(baseId, PackObjectType.BLOB, baseContent);
      await writer.addRefDelta(deltaId, baseId, delta);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-boundary.pack`, [result.packData]);
      await files.write(`${basePath}/pack-boundary.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-boundary.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(deltaId);
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      // Read bytes 0-5 (crosses INSERT at byte 0, COPY starts at byte 1)
      const boundary = await randomAccess.readAt(0, 5);
      expect(boundary).toEqual(deltaContent.subarray(0, 5));
      expect(boundary[0]).toBe(0xbb); // INSERT
      expect(boundary[1]).toBe(0xaa); // From base

      await reader.close();
    });
  });

  describe("multi-level delta chain", () => {
    it("reads from 3-level OFS_DELTA chain", async () => {
      const baseContent = new Uint8Array(512).fill(0x10);
      const baseId = fakeId(5000);

      const data1 = modifyFirstByte(0x11, baseContent);
      const id1 = fakeId(5001);
      const delta1 = createFirstByteChangeDelta(baseContent.length, 0x11);

      const data2 = modifyFirstByte(0x12, data1);
      const id2 = fakeId(5002);
      const delta2 = createFirstByteChangeDelta(data1.length, 0x12);

      const data3 = modifyFirstByte(0x13, data2);
      const id3 = fakeId(5003);
      const delta3 = createFirstByteChangeDelta(data2.length, 0x13);

      const writer = new PackWriterStream();
      await writer.addObject(baseId, PackObjectType.BLOB, baseContent);
      await writer.addOfsDelta(id1, baseId, delta1);
      await writer.addOfsDelta(id2, id1, delta2);
      await writer.addOfsDelta(id3, id2, delta3);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-chain3.pack`, [result.packData]);
      await files.write(`${basePath}/pack-chain3.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-chain3.pack`, index);
      await reader.open();

      // Get random access to deepest delta
      const randomAccess = await reader.getRandomAccess(id3);
      expect(randomAccess).toBeDefined();
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      expect(await randomAccess.getSize()).toBe(data3.length);

      // Read first byte (should be 0x13 from final delta)
      const first = await randomAccess.readAt(0, 1);
      expect(first[0]).toBe(0x13);

      // Read middle (should be 0x10 from base)
      const middle = await randomAccess.readAt(256, 10);
      expect(middle.every((b) => b === 0x10)).toBe(true);

      // Full content should match expected
      const full = await randomAccess.readAt(0, data3.length);
      expect(full).toEqual(data3);

      await reader.close();
    });
  });

  describe("streaming", () => {
    it("streams delta content from offset", async () => {
      const baseContent = new Uint8Array(1024).fill(0xee);
      const baseId = fakeId(6000);

      const deltaContent = modifyFirstByte(0xff, baseContent);
      const deltaId = fakeId(6001);
      const delta = createFirstByteChangeDelta(baseContent.length, 0xff);

      const writer = new PackWriterStream();
      await writer.addObject(baseId, PackObjectType.BLOB, baseContent);
      await writer.addRefDelta(deltaId, baseId, delta);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-stream.pack`, [result.packData]);
      await files.write(`${basePath}/pack-stream.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-stream.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(deltaId);
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      // Stream from offset 500 for 200 bytes
      const chunks: Uint8Array[] = [];
      for await (const chunk of randomAccess.stream(500, 200)) {
        chunks.push(chunk);
      }

      const streamed = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        streamed.set(chunk, offset);
        offset += chunk.length;
      }

      expect(streamed).toEqual(deltaContent.subarray(500, 700));

      await reader.close();
    });
  });

  describe("edge cases", () => {
    it("handles read past end of object", async () => {
      const content = new Uint8Array(100).fill(0x55);
      const id = fakeId(7000);

      const writer = new PackWriterStream();
      await writer.addObject(id, PackObjectType.BLOB, content);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-edge.pack`, [result.packData]);
      await files.write(`${basePath}/pack-edge.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-edge.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(id);
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      // Read past end
      const pastEnd = await randomAccess.readAt(200, 50);
      expect(pastEnd.length).toBe(0);

      // Read partially past end
      const partial = await randomAccess.readAt(90, 50);
      expect(partial.length).toBe(10);
      expect(partial).toEqual(content.subarray(90, 100));

      await reader.close();
    });

    it("handles zero-length read", async () => {
      const content = new Uint8Array(100).fill(0x66);
      const id = fakeId(8000);

      const writer = new PackWriterStream();
      await writer.addObject(id, PackObjectType.BLOB, content);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-zero.pack`, [result.packData]);
      await files.write(`${basePath}/pack-zero.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-zero.pack`, index);
      await reader.open();

      const randomAccess = await reader.getRandomAccess(id);
      if (!randomAccess) {
        throw new Error("randomAccess is null");
      }

      const zeroLen = await randomAccess.readAt(50, 0);
      expect(zeroLen.length).toBe(0);

      await reader.close();
    });

    it("returns undefined for non-existent object", async () => {
      const content = new Uint8Array(100).fill(0x77);
      const id = fakeId(9000);

      const writer = new PackWriterStream();
      await writer.addObject(id, PackObjectType.BLOB, content);

      const result = await writer.finalize();
      const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);

      await files.mkdir(basePath);
      await files.write(`${basePath}/pack-noexist.pack`, [result.packData]);
      await files.write(`${basePath}/pack-noexist.idx`, [indexData]);

      const index = readPackIndex(indexData);
      const reader = new PackReader(files, `${basePath}/pack-noexist.pack`, index);
      await reader.open();

      const nonExistent = await reader.getRandomAccess(fakeId(9999));
      expect(nonExistent).toBeUndefined();

      await reader.close();
    });
  });
});
