/**
 * Tests for parsePackEntriesFromStream
 *
 * Validates streaming equivalence: parsePackEntries(data) ≡ collect(parsePackEntriesFromStream(toStream(data)))
 */

import { setCompressionUtils } from "@statewalker/vcs-utils";
import { MemoryPackObjectCache } from "@statewalker/vcs-utils/pack";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PackEntry,
  PackObjectType,
  type PackWriterObject,
  parsePackEntries,
  parsePackEntriesFromStream,
  writePack,
} from "../../src/pack/index.js";

beforeAll(() => {
  setCompressionUtils(createNodeCompression());
});

function toChunkedStream(data: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < data.length; i += chunkSize) {
      yield data.subarray(i, Math.min(i + chunkSize, data.length));
    }
  })();
}

function toSingleChunkStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield data;
  })();
}

async function collectEntries(gen: AsyncIterable<PackEntry>): Promise<PackEntry[]> {
  const entries: PackEntry[] = [];
  for await (const entry of gen) {
    entries.push(entry);
  }
  return entries;
}

describe("parsePackEntriesFromStream", () => {
  it("parses single blob pack", async () => {
    const content = new TextEncoder().encode("Hello, World!");
    const objects: PackWriterObject[] = [{ id: "dummy", type: PackObjectType.BLOB, content }];
    const { packData } = await writePack(objects);

    const blockResult = await parsePackEntries(packData);
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toSingleChunkStream(packData)),
    );

    expect(streamEntries.length).toBe(blockResult.entries.length);
    expect(streamEntries[0].id).toBe(blockResult.entries[0].id);
    expect(streamEntries[0].objectType).toBe("blob");
    expect(streamEntries[0].type).toBe("base");
    if (streamEntries[0].type === "base") {
      expect(streamEntries[0].content).toEqual(content);
    }
  });

  it("parses multiple base objects", async () => {
    const objects: PackWriterObject[] = [
      {
        id: "a",
        type: PackObjectType.BLOB,
        content: new TextEncoder().encode("blob content"),
      },
      {
        id: "b",
        type: PackObjectType.COMMIT,
        content: new TextEncoder().encode(
          "tree abc\nauthor Test <t@t> 0 +0000\ncommitter Test <t@t> 0 +0000\n\nmessage",
        ),
      },
      {
        id: "c",
        type: PackObjectType.TREE,
        content: new Uint8Array([
          49,
          48,
          48,
          54,
          52,
          52,
          32,
          102,
          46,
          116,
          120,
          116,
          0,
          ...new Array(20).fill(0xab),
        ]),
      },
    ];
    const { packData } = await writePack(objects);

    const blockResult = await parsePackEntries(packData);
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toSingleChunkStream(packData)),
    );

    expect(streamEntries.length).toBe(blockResult.entries.length);
    for (let i = 0; i < streamEntries.length; i++) {
      expect(streamEntries[i].id).toBe(blockResult.entries[i].id);
      expect(streamEntries[i].objectType).toBe(blockResult.entries[i].objectType);
      expect(streamEntries[i].content).toEqual(blockResult.entries[i].content);
    }
  });

  it("works with small chunked stream", async () => {
    const objects: PackWriterObject[] = [
      {
        id: "x",
        type: PackObjectType.BLOB,
        content: new TextEncoder().encode("chunked streaming test content here"),
      },
    ];
    const { packData } = await writePack(objects);

    const blockResult = await parsePackEntries(packData);
    // Feed in very small chunks (7 bytes each)
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toChunkedStream(packData, 7)),
    );

    expect(streamEntries.length).toBe(blockResult.entries.length);
    expect(streamEntries[0].id).toBe(blockResult.entries[0].id);
    expect(streamEntries[0].content).toEqual(blockResult.entries[0].content);
  });

  it("accepts external PackObjectCache", async () => {
    const objects: PackWriterObject[] = [
      {
        id: "z",
        type: PackObjectType.BLOB,
        content: new TextEncoder().encode("cache test"),
      },
    ];
    const { packData } = await writePack(objects);

    const cache = new MemoryPackObjectCache();
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toSingleChunkStream(packData), cache),
    );

    // Cache should contain the stored object
    expect(streamEntries.length).toBe(1);
    expect(cache.getType(streamEntries[0].id)).toBe("blob");

    // Clean up
    await cache.dispose();
  });

  it("disposes owned cache automatically", async () => {
    const objects: PackWriterObject[] = [
      {
        id: "auto",
        type: PackObjectType.BLOB,
        content: new TextEncoder().encode("auto dispose"),
      },
    ];
    const { packData } = await writePack(objects);

    // No external cache — should create and dispose its own
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toSingleChunkStream(packData)),
    );

    expect(streamEntries.length).toBe(1);
    expect(streamEntries[0].objectType).toBe("blob");
  });

  it("handles large pack with many objects", async () => {
    const encoder = new TextEncoder();
    const objects: PackWriterObject[] = [];
    for (let i = 0; i < 50; i++) {
      objects.push({
        id: `obj${i}`,
        type: PackObjectType.BLOB,
        content: encoder.encode(`Object ${i}: ${"x".repeat(100 + i * 10)}`),
      });
    }
    const { packData } = await writePack(objects);

    const blockResult = await parsePackEntries(packData);
    const streamEntries = await collectEntries(
      parsePackEntriesFromStream(toChunkedStream(packData, 64)),
    );

    expect(streamEntries.length).toBe(blockResult.entries.length);
    for (let i = 0; i < streamEntries.length; i++) {
      expect(streamEntries[i].id).toBe(blockResult.entries[i].id);
      expect(streamEntries[i].objectType).toBe(blockResult.entries[i].objectType);
    }
  });
});
