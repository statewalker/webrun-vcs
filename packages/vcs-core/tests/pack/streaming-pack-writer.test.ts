/**
 * Tests for StreamingPackWriter
 *
 * Verifies that packs built with StreamingPackWriter are byte-parseable
 * by both parsePackEntries and parsePackEntriesFromStream.
 */

import { setCompressionUtils } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PackObjectType,
  PackWriterStream,
  parsePackEntries,
  parsePackEntriesFromStream,
  StreamingPackWriter,
} from "../../src/pack/index.js";

beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

/** Collect all chunks from an async generator into a single Uint8Array */
async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/** Compute git object ID (SHA-1 of "type size\0content") */
async function computeObjectId(type: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const full = new Uint8Array(header.length + content.length);
  full.set(header);
  full.set(content, header.length);
  return bytesToHex(await sha1(full));
}

const encoder = new TextEncoder();

describe("StreamingPackWriter", () => {
  it("produces a valid single-object pack", async () => {
    const content = encoder.encode("hello world\n");
    const id = await computeObjectId("blob", content);

    const writer = new StreamingPackWriter(1);
    const chunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(id, PackObjectType.BLOB, content)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    // Multiple chunks should have been yielded (header, pack-header, compressed, checksum)
    expect(chunks.length).toBeGreaterThan(1);

    // Parse with block-based parser
    const packData = await collect(toAsyncIterable(chunks));
    const result = await parsePackEntries(packData);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(id);
    expect(result.entries[0].objectType).toBe("blob");
  });

  it("produces a valid multi-object pack", async () => {
    const blob1 = encoder.encode("blob one");
    const blob2 = encoder.encode("blob two");
    const commitContent = encoder.encode(
      "tree 0000000000000000000000000000000000000000\nauthor Test <t@t> 0 +0000\ncommitter Test <t@t> 0 +0000\n\ntest commit\n",
    );

    const id1 = await computeObjectId("blob", blob1);
    const id2 = await computeObjectId("blob", blob2);
    const id3 = await computeObjectId("commit", commitContent);

    const writer = new StreamingPackWriter(3);
    const chunks: Uint8Array[] = [];

    for await (const chunk of writer.addObject(id1, PackObjectType.BLOB, blob1)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.addObject(id2, PackObjectType.BLOB, blob2)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.addObject(id3, PackObjectType.COMMIT, commitContent)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    const packData = await collect(toAsyncIterable(chunks));
    const result = await parsePackEntries(packData);
    expect(result.entries).toHaveLength(3);

    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toContain(id3);
  });

  it("produces packs parseable by streaming parser", async () => {
    const content = encoder.encode("streaming round-trip test");
    const id = await computeObjectId("blob", content);

    const writer = new StreamingPackWriter(1);
    const chunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(id, PackObjectType.BLOB, content)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    // Parse with streaming parser
    const entries: { id: string; objectType: string }[] = [];
    for await (const entry of parsePackEntriesFromStream(toAsyncIterable(chunks))) {
      entries.push({ id: entry.id, objectType: entry.objectType });
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].objectType).toBe("blob");
  });

  it("produces byte-identical packs to PackWriterStream", async () => {
    const content = encoder.encode("byte-identical test content");
    const id = await computeObjectId("blob", content);

    // Build with StreamingPackWriter
    const streamingWriter = new StreamingPackWriter(1);
    const streamingChunks: Uint8Array[] = [];
    for await (const chunk of streamingWriter.addObject(id, PackObjectType.BLOB, content)) {
      streamingChunks.push(chunk);
    }
    for await (const chunk of streamingWriter.finalize()) {
      streamingChunks.push(chunk);
    }
    const streamingPack = await collect(toAsyncIterable(streamingChunks));

    // Build with PackWriterStream
    const blockWriter = new PackWriterStream();
    await blockWriter.addObject(id, PackObjectType.BLOB, content);
    const blockResult = await blockWriter.finalize();
    const blockPack = blockResult.packData;

    // Should be byte-identical
    expect(bytesToHex(streamingPack)).toBe(bytesToHex(blockPack));
  });

  it("verifies SHA-1 checksum is correct", async () => {
    const content = encoder.encode("checksum test");
    const id = await computeObjectId("blob", content);

    const writer = new StreamingPackWriter(1);
    const chunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(id, PackObjectType.BLOB, content)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    const packData = await collect(toAsyncIterable(chunks));

    // Last 20 bytes should be SHA-1 of everything before it
    const dataWithoutChecksum = packData.subarray(0, packData.length - 20);
    const storedChecksum = packData.subarray(packData.length - 20);
    const expectedChecksum = await sha1(dataWithoutChecksum);

    expect(bytesToHex(storedChecksum)).toBe(bytesToHex(expectedChecksum));
  });

  it("yields chunks immediately per addObject call", async () => {
    const content1 = encoder.encode("first object");
    const content2 = encoder.encode("second object");
    const id1 = await computeObjectId("blob", content1);
    const id2 = await computeObjectId("blob", content2);

    const writer = new StreamingPackWriter(2);

    // First addObject should yield pack header + object data
    const firstChunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(id1, PackObjectType.BLOB, content1)) {
      firstChunks.push(chunk);
    }
    // Should have yielded: 12-byte pack header, varint header, compressed data
    expect(firstChunks.length).toBeGreaterThanOrEqual(3);

    // Second addObject should NOT re-yield the pack header
    const secondChunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(id2, PackObjectType.BLOB, content2)) {
      secondChunks.push(chunk);
    }
    // Should have yielded: varint header + compressed data (no pack header)
    expect(secondChunks.length).toBe(2);
  });

  it("throws on object count mismatch at finalize", async () => {
    const content = encoder.encode("only one");
    const id = await computeObjectId("blob", content);

    const writer = new StreamingPackWriter(2);
    for await (const _ of writer.addObject(id, PackObjectType.BLOB, content)) {
      // consume
    }

    await expect(async () => {
      for await (const _ of writer.finalize()) {
        // consume
      }
    }).rejects.toThrow("Expected 2 objects but wrote 1");
  });

  it("throws on addObject after finalize", async () => {
    const content = encoder.encode("test");
    const id = await computeObjectId("blob", content);

    const writer = new StreamingPackWriter(1);
    for await (const _ of writer.addObject(id, PackObjectType.BLOB, content)) {
      // consume
    }
    for await (const _ of writer.finalize()) {
      // consume
    }

    await expect(async () => {
      for await (const _ of writer.addObject(id, PackObjectType.BLOB, content)) {
        // consume
      }
    }).rejects.toThrow("Pack has been finalized");
  });

  it("handles REF_DELTA objects", async () => {
    const baseContent = encoder.encode("base content for ref delta");
    const baseId = await computeObjectId("blob", baseContent);

    // Create a simple delta (just a copy of the full base)
    // Delta format: base-size varint, result-size varint, copy instruction
    const deltaBytes = createSimpleDelta(baseContent.length, baseContent.length);
    const deltaId = await computeObjectId("blob", baseContent); // same content after applying

    const writer = new StreamingPackWriter(2);
    const chunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(baseId, PackObjectType.BLOB, baseContent)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.addRefDelta(deltaId, baseId, deltaBytes)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    const packData = await collect(toAsyncIterable(chunks));
    const result = await parsePackEntries(packData);
    expect(result.entries).toHaveLength(2);
  });

  it("provides correct index entries with CRC32 and offsets", async () => {
    const blob1 = encoder.encode("index entry test 1");
    const blob2 = encoder.encode("index entry test 2");
    const id1 = await computeObjectId("blob", blob1);
    const id2 = await computeObjectId("blob", blob2);

    const writer = new StreamingPackWriter(2);
    for await (const _ of writer.addObject(id1, PackObjectType.BLOB, blob1)) {
      // consume
    }
    for await (const _ of writer.addObject(id2, PackObjectType.BLOB, blob2)) {
      // consume
    }
    for await (const _ of writer.finalize()) {
      // consume
    }

    const entries = writer.getIndexEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(id1);
    expect(entries[1].id).toBe(id2);

    // First object starts right after 12-byte pack header
    expect(entries[0].offset).toBe(12);
    // Second object starts after first object
    expect(entries[1].offset).toBeGreaterThan(entries[0].offset);

    // CRC32 values should be non-zero (actual values depend on content)
    expect(entries[0].crc32).not.toBe(0);
    expect(entries[1].crc32).not.toBe(0);
    // Different content → different CRC32
    expect(entries[0].crc32).not.toBe(entries[1].crc32);
  });

  it("produces index entries matching PackWriterStream", async () => {
    const content = encoder.encode("crc32 comparison test");
    const id = await computeObjectId("blob", content);

    // StreamingPackWriter
    const streamingWriter = new StreamingPackWriter(1);
    for await (const _ of streamingWriter.addObject(id, PackObjectType.BLOB, content)) {
      // consume
    }
    for await (const _ of streamingWriter.finalize()) {
      // consume
    }
    const streamingEntries = streamingWriter.getIndexEntries();

    // PackWriterStream
    const blockWriter = new PackWriterStream();
    await blockWriter.addObject(id, PackObjectType.BLOB, content);
    const blockResult = await blockWriter.finalize();

    expect(streamingEntries).toHaveLength(1);
    expect(blockResult.indexEntries).toHaveLength(1);
    expect(streamingEntries[0].id).toBe(blockResult.indexEntries[0].id);
    expect(streamingEntries[0].offset).toBe(blockResult.indexEntries[0].offset);
    expect(streamingEntries[0].crc32).toBe(blockResult.indexEntries[0].crc32);
  });

  it("handles OFS_DELTA objects", async () => {
    const baseContent = encoder.encode("base content for ofs delta");
    const baseId = await computeObjectId("blob", baseContent);

    const deltaBytes = createSimpleDelta(baseContent.length, baseContent.length);
    const deltaId = await computeObjectId("blob", baseContent);

    const writer = new StreamingPackWriter(2);
    const chunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(baseId, PackObjectType.BLOB, baseContent)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.addOfsDelta(deltaId, baseId, deltaBytes)) {
      chunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      chunks.push(chunk);
    }

    const packData = await collect(toAsyncIterable(chunks));
    const result = await parsePackEntries(packData);
    expect(result.entries).toHaveLength(2);
  });
});

/** Helper: create a minimal delta that copies the entire base */
function createSimpleDelta(baseSize: number, resultSize: number): Uint8Array {
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

  // Copy instruction: copy baseSize bytes from offset 0
  let cmd = 0x80;
  const offsetBytes: number[] = [];
  const lenBytes: number[] = [];

  // offset = 0, no offset bytes needed

  // len bytes
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
  for (const b of offsetBytes) output.push(b);
  for (const b of lenBytes) output.push(b);

  return new Uint8Array(output);
}

/** Convert Uint8Array chunks to an async iterable */
async function* toAsyncIterable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
