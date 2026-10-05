/**
 * Tests for streaming pack indexer (indexPackFromStream)
 *
 * Verifies streaming indexer produces identical results to block-based indexPack.
 */

import { setCompressionUtils } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, describe, expect, it } from "vitest";
import {
  indexPack,
  indexPackFromStream,
  PackObjectType,
  PackWriterStream,
} from "../../src/pack/index.js";

beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/** Compute git object ID */
async function computeObjectId(type: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const full = new Uint8Array(header.length + content.length);
  full.set(header);
  full.set(content, header.length);
  return bytesToHex(await sha1(full));
}

/** Build a pack with the given objects using PackWriterStream */
async function buildPack(
  objects: { id: string; type: PackObjectType; content: Uint8Array }[],
): Promise<Uint8Array> {
  const writer = new PackWriterStream();
  for (const obj of objects) {
    await writer.addObject(obj.id, obj.type, obj.content);
  }
  const result = await writer.finalize();
  return result.packData;
}

/** Convert Uint8Array to async iterable */
async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** Convert Uint8Array to async iterable of small chunks */
async function* toSmallChunks(data: Uint8Array, chunkSize = 7): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.length; i += chunkSize) {
    yield data.subarray(i, Math.min(i + chunkSize, data.length));
  }
}

const encoder = new TextEncoder();

describe("indexPackFromStream", () => {
  it("indexes a single-object pack", async () => {
    const content = encoder.encode("hello indexer\n");
    const id = await computeObjectId("blob", content);
    const packData = await buildPack([{ id, type: PackObjectType.BLOB, content }]);

    const result = await indexPackFromStream(toStream(packData));

    expect(result.objectCount).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(id);
    expect(result.entries[0].offset).toBe(12); // right after header
  });

  it("indexes a multi-object pack", async () => {
    const blob1 = encoder.encode("blob one");
    const blob2 = encoder.encode("blob two");
    const commitData = encoder.encode(
      "tree 0000000000000000000000000000000000000000\nauthor T <t@t> 0 +0000\ncommitter T <t@t> 0 +0000\n\ntest\n",
    );

    const id1 = await computeObjectId("blob", blob1);
    const id2 = await computeObjectId("blob", blob2);
    const id3 = await computeObjectId("commit", commitData);

    const packData = await buildPack([
      { id: id1, type: PackObjectType.BLOB, content: blob1 },
      { id: id2, type: PackObjectType.BLOB, content: blob2 },
      { id: id3, type: PackObjectType.COMMIT, content: commitData },
    ]);

    const result = await indexPackFromStream(toStream(packData));

    expect(result.objectCount).toBe(3);
    expect(result.entries).toHaveLength(3);

    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toContain(id3);
  });

  it("produces identical entries to block-based indexPack", async () => {
    const blob1 = encoder.encode("streaming vs block comparison 1");
    const blob2 = encoder.encode("streaming vs block comparison 2");

    const id1 = await computeObjectId("blob", blob1);
    const id2 = await computeObjectId("blob", blob2);

    const packData = await buildPack([
      { id: id1, type: PackObjectType.BLOB, content: blob1 },
      { id: id2, type: PackObjectType.BLOB, content: blob2 },
    ]);

    const blockResult = await indexPack(packData);
    const streamResult = await indexPackFromStream(toStream(packData));

    expect(streamResult.objectCount).toBe(blockResult.objectCount);
    expect(streamResult.version).toBe(blockResult.version);
    expect(streamResult.entries).toHaveLength(blockResult.entries.length);

    // Entries are sorted by ID, so they should match positionally
    for (let i = 0; i < blockResult.entries.length; i++) {
      expect(streamResult.entries[i].id).toBe(blockResult.entries[i].id);
      expect(streamResult.entries[i].offset).toBe(blockResult.entries[i].offset);
      expect(streamResult.entries[i].crc32).toBe(blockResult.entries[i].crc32);
    }

    // Pack checksum should match
    expect(bytesToHex(streamResult.packChecksum)).toBe(bytesToHex(blockResult.packChecksum));
  });

  it("handles small chunks (stress BufferedByteReader)", async () => {
    const content = encoder.encode("small chunks test data");
    const id = await computeObjectId("blob", content);
    const packData = await buildPack([{ id, type: PackObjectType.BLOB, content }]);

    // Feed pack data in tiny 7-byte chunks
    const result = await indexPackFromStream(toSmallChunks(packData, 7));

    expect(result.objectCount).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(id);
  });

  it("handles OFS_DELTA objects", async () => {
    const baseContent = encoder.encode("base content for ofs delta indexing");
    const baseId = await computeObjectId("blob", baseContent);

    // Build pack with OFS_DELTA
    const writer = new PackWriterStream();
    await writer.addObject(baseId, PackObjectType.BLOB, baseContent);

    // Create a simple delta (copy entire base)
    const deltaBytes = createCopyDelta(baseContent.length, baseContent.length);
    const deltaId = await computeObjectId("blob", baseContent);
    await writer.addOfsDelta(deltaId, baseId, deltaBytes);

    const packResult = await writer.finalize();
    const packData = packResult.packData;

    // Index with both methods
    const blockResult = await indexPack(packData);
    const streamResult = await indexPackFromStream(toStream(packData));

    expect(streamResult.entries).toHaveLength(blockResult.entries.length);
    for (let i = 0; i < blockResult.entries.length; i++) {
      expect(streamResult.entries[i].id).toBe(blockResult.entries[i].id);
      expect(streamResult.entries[i].offset).toBe(blockResult.entries[i].offset);
      expect(streamResult.entries[i].crc32).toBe(blockResult.entries[i].crc32);
    }
  });

  it("handles REF_DELTA objects", async () => {
    const baseContent = encoder.encode("base content for ref delta indexing");
    const baseId = await computeObjectId("blob", baseContent);

    const writer = new PackWriterStream();
    await writer.addObject(baseId, PackObjectType.BLOB, baseContent);

    const deltaBytes = createCopyDelta(baseContent.length, baseContent.length);
    const deltaId = await computeObjectId("blob", baseContent);
    await writer.addRefDelta(deltaId, baseId, deltaBytes);

    const packResult = await writer.finalize();
    const packData = packResult.packData;

    const blockResult = await indexPack(packData);
    const streamResult = await indexPackFromStream(toStream(packData));

    expect(streamResult.entries).toHaveLength(blockResult.entries.length);
    for (let i = 0; i < blockResult.entries.length; i++) {
      expect(streamResult.entries[i].id).toBe(blockResult.entries[i].id);
      expect(streamResult.entries[i].offset).toBe(blockResult.entries[i].offset);
      expect(streamResult.entries[i].crc32).toBe(blockResult.entries[i].crc32);
    }
  });
});

/** Create a minimal delta that copies the entire base */
function createCopyDelta(baseSize: number, resultSize: number): Uint8Array {
  const output: number[] = [];

  // Base size varint
  let s = baseSize;
  while (s >= 0x80) {
    output.push((s & 0x7f) | 0x80);
    s >>>= 7;
  }
  output.push(s);

  // Result size varint
  s = resultSize;
  while (s >= 0x80) {
    output.push((s & 0x7f) | 0x80);
    s >>>= 7;
  }
  output.push(s);

  // Copy instruction: copy resultSize bytes from offset 0
  let cmd = 0x80;
  const lenBytes: number[] = [];
  if (resultSize !== 0x10000) {
    let b = resultSize & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x10;
    }
    b = (resultSize >>> 8) & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x20;
    }
    b = (resultSize >>> 16) & 0xff;
    if (b !== 0) {
      lenBytes.push(b);
      cmd |= 0x40;
    }
  }
  output.push(cmd);
  for (const b of lenBytes) output.push(b);

  return new Uint8Array(output);
}
