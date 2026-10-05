/**
 * Pack Export Delta Computation Tests
 *
 * Tests that DefaultPackBuilder correctly computes deltas during pack export
 * using a sliding window of recently added objects.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";
import { DefaultSerializationApi } from "../../src/serialization/serialization-api.impl.js";
import type { SerializationApi } from "../../src/serialization/serialization-api.js";
import { GitDeltaCompressor } from "../../src/storage/delta/compressor/git-delta-compressor.js";

describe("Pack Export Delta Computation", () => {
  let source: HistoryWithOperations;
  let target: HistoryWithOperations;
  /** Serialization API with delta compressor enabled */
  let deltaSerializer: SerializationApi;
  /** Serialization API without delta compressor (for comparison) */
  let plainSerializer: SerializationApi;

  beforeEach(async () => {
    source = createMemoryHistoryWithOperations();
    target = createMemoryHistoryWithOperations();
    await source.initialize();
    await target.initialize();

    // Create serialization with delta compressor
    deltaSerializer = new DefaultSerializationApi({
      history: source,
      deltaCompressor: new GitDeltaCompressor(),
    });

    // Plain serialization (no delta)
    plainSerializer = source.serialization;
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  describe("blob delta export", () => {
    it("produces deltas for similar blobs", async () => {
      // Create two blobs with similar content (large enough for delta)
      const baseContent = `${"A".repeat(200)} version 1 ${"B".repeat(200)}`;
      const targetContent = `${"A".repeat(200)} version 2 ${"B".repeat(200)}`;

      const baseId = await source.blobs.store([new TextEncoder().encode(baseContent)]);
      const targetId = await source.blobs.store([new TextEncoder().encode(targetContent)]);

      // Build pack with delta computation
      const builder = deltaSerializer.createPackBuilder();
      await builder.addObjectWithDelta(baseId);
      await builder.addObjectWithDelta(targetId);

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(2);
      expect(stats.deltifiedObjects).toBe(1);
      expect(stats.deltaSavings).toBeGreaterThan(0);
    });

    it("does not deltify dissimilar blobs", async () => {
      const blob1 = await source.blobs.store([new TextEncoder().encode("Completely different")]);
      const blob2 = await source.blobs.store([
        new TextEncoder().encode("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
      ]);

      const builder = deltaSerializer.createPackBuilder();
      await builder.addObjectWithDelta(blob1);
      await builder.addObjectWithDelta(blob2);

      const stats = builder.getStats();
      expect(stats.deltifiedObjects).toBe(0);
    });

    it("does not deltify when useDelta is false", async () => {
      const content1 = `${"A".repeat(200)} v1 ${"B".repeat(200)}`;
      const content2 = `${"A".repeat(200)} v2 ${"B".repeat(200)}`;

      const id1 = await source.blobs.store([new TextEncoder().encode(content1)]);
      const id2 = await source.blobs.store([new TextEncoder().encode(content2)]);

      // Use createPack with useDelta: false
      const objects = async function* () {
        yield id1;
        yield id2;
      };

      const packBytes = await collectPackBytes(
        deltaSerializer.createPack(objects(), { useDelta: false }),
      );

      // Import and verify all objects are present
      const result = await target.serialization.importPack(toAsyncIterable(packBytes));
      expect(result.objectsImported).toBe(2);
    });
  });

  describe("tree delta export", () => {
    it("produces deltas for similar trees", async () => {
      // Create two trees that share most entries
      const blob1 = await source.blobs.store([new TextEncoder().encode("A".repeat(100))]);
      const blob2 = await source.blobs.store([new TextEncoder().encode("B".repeat(100))]);
      const blob3 = await source.blobs.store([new TextEncoder().encode("C".repeat(100))]);

      const tree1 = await source.trees.store([
        { mode: 0o100644, name: "file-a.txt", id: blob1 },
        { mode: 0o100644, name: "file-b.txt", id: blob2 },
        { mode: 0o100644, name: "file-c.txt", id: blob3 },
        { mode: 0o100644, name: "file-d.txt", id: blob1 },
        { mode: 0o100644, name: "file-e.txt", id: blob2 },
      ]);

      const tree2 = await source.trees.store([
        { mode: 0o100644, name: "file-a.txt", id: blob1 },
        { mode: 0o100644, name: "file-b.txt", id: blob3 },
        { mode: 0o100644, name: "file-c.txt", id: blob3 },
        { mode: 0o100644, name: "file-d.txt", id: blob1 },
        { mode: 0o100644, name: "file-e.txt", id: blob2 },
      ]);

      const builder = deltaSerializer.createPackBuilder();
      await builder.addObjectWithDelta(tree1);
      await builder.addObjectWithDelta(tree2);

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(2);
      // Trees are same type, similar size — should produce delta
      expect(stats.deltifiedObjects).toBe(1);
    });
  });

  describe("commit delta export", () => {
    it("produces deltas for similar commits", async () => {
      const blob1 = await source.blobs.store([new TextEncoder().encode("commit content 1")]);
      const tree1 = await source.trees.store([{ mode: 0o100644, name: "file.txt", id: blob1 }]);

      const commit1 = await source.commits.store({
        tree: tree1,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "First commit with some text",
      });

      const blob2 = await source.blobs.store([new TextEncoder().encode("commit content 2")]);
      const tree2 = await source.trees.store([{ mode: 0o100644, name: "file.txt", id: blob2 }]);

      const commit2 = await source.commits.store({
        tree: tree2,
        parents: [commit1],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Second commit with some text",
      });

      const builder = deltaSerializer.createPackBuilder();
      await builder.addObjectWithDelta(commit1);
      await builder.addObjectWithDelta(commit2);

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(2);
      // Parent-child commits have similar serialized form
      expect(stats.deltifiedObjects).toBe(1);
    });
  });

  describe("pack roundtrip with deltas", () => {
    it("roundtrips blob content through delta pack", async () => {
      const content1 = `Shared prefix ${"A".repeat(200)} suffix v1`;
      const content2 = `Shared prefix ${"A".repeat(200)} suffix v2`;

      const id1 = await source.blobs.store([new TextEncoder().encode(content1)]);
      const id2 = await source.blobs.store([new TextEncoder().encode(content2)]);

      const objects = async function* () {
        yield id1;
        yield id2;
      };

      // Export with deltas
      const packBytes = await collectPackBytes(deltaSerializer.createPack(objects()));

      // Import into fresh target
      const result = await target.serialization.importPack(toAsyncIterable(packBytes));
      expect(result.objectsImported).toBe(2);

      // Verify blob content is intact
      const loaded1 = await target.blobs.load(id1);
      expect(loaded1).toBeDefined();
      const bytes1 = await collectBytes(loaded1!);
      expect(new TextDecoder().decode(bytes1)).toBe(content1);

      const loaded2 = await target.blobs.load(id2);
      expect(loaded2).toBeDefined();
      const bytes2 = await collectBytes(loaded2!);
      expect(new TextDecoder().decode(bytes2)).toBe(content2);
    });

    it("roundtrips full commit history through delta pack", async () => {
      // Create a 3-commit chain with overlapping content
      const parent = await createSimpleCommit(source, `Initial ${"X".repeat(100)}`, []);
      const child = await createSimpleCommit(source, `Update ${"X".repeat(100)}`, [parent]);
      const grandchild = await createSimpleCommit(source, `Final ${"X".repeat(100)}`, [child]);

      // Collect all reachable objects
      const objects = source.collectReachableObjects(new Set([grandchild]), new Set());

      // Export with deltas
      const packBytes = await collectPackBytes(deltaSerializer.createPack(objects));

      // Import using a plain serializer (no delta APIs) to avoid format mismatch
      // between Git binary deltas in pack and structural deltas in memory backend
      const targetPlainSerializer = new DefaultSerializationApi({ history: target });
      const result = await targetPlainSerializer.importPack(toAsyncIterable(packBytes));
      expect(result.commitsImported).toBe(3);

      // Verify commit chain
      const loaded = await target.commits.load(grandchild);
      expect(loaded).toBeDefined();
      expect(loaded?.parents).toEqual([child]);

      const loadedChild = await target.commits.load(child);
      expect(loadedChild?.parents).toEqual([parent]);
    });

    it("delta pack is smaller than full pack for similar objects", async () => {
      // Use pseudo-random content that doesn't compress well with zlib alone
      // but deltas very well (shared prefix with small variations)
      const ids: string[] = [];

      for (let i = 0; i < 5; i++) {
        const bytes = new Uint8Array(2000);
        // Fill with deterministic pseudo-random data (same seed = same base)
        for (let j = 0; j < bytes.length; j++) {
          bytes[j] = ((j * 131 + 17) ^ (j >> 3)) & 0xff;
        }
        // Small variation per blob (only change a few bytes)
        bytes[0] = i;
        bytes[1000] = i + 10;
        bytes[1999] = i + 20;
        const id = await source.blobs.store([bytes]);
        ids.push(id);
      }

      // Export without deltas
      const fullPackBytes = await collectPackBytes(
        plainSerializer.createPack(toAsyncObjectIds(ids)),
      );

      // Export with deltas
      const deltaPackBytes = await collectPackBytes(
        deltaSerializer.createPack(toAsyncObjectIds([...ids])),
      );

      // Delta pack should be smaller (pseudo-random content doesn't zlib well
      // but deltas capture the 3-byte differences efficiently)
      expect(deltaPackBytes.length).toBeLessThan(fullPackBytes.length);
    });
  });

  describe("preferredBaseId", () => {
    it("uses preferred base when provided", async () => {
      const content1 = `Base content ${"Z".repeat(200)}`;
      const content2 = `Base content ${"Z".repeat(200)} extended`;

      const baseId = await source.blobs.store([new TextEncoder().encode(content1)]);
      const targetId = await source.blobs.store([new TextEncoder().encode(content2)]);

      const builder = deltaSerializer.createPackBuilder();
      await builder.addObject(baseId); // Add base as full object first
      // Now addObjectWithDelta won't find baseId in window (addObject doesn't update window)
      // So add again with addObjectWithDelta
      const builder2 = deltaSerializer.createPackBuilder();
      await builder2.addObjectWithDelta(baseId);
      await builder2.addObjectWithDelta(targetId, baseId);

      const stats = builder2.getStats();
      expect(stats.deltifiedObjects).toBe(1);
    });
  });

  describe("stats tracking", () => {
    it("tracks deltified objects and savings", async () => {
      const content = "R".repeat(300);
      const ids: string[] = [];

      for (let i = 0; i < 3; i++) {
        const id = await source.blobs.store([
          new TextEncoder().encode(`${content} variation ${i}`),
        ]);
        ids.push(id);
      }

      const builder = deltaSerializer.createPackBuilder();
      for (const id of ids) {
        await builder.addObjectWithDelta(id);
      }

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(3);
      // First blob is full, subsequent ones should be deltas
      expect(stats.deltifiedObjects).toBe(2);
      expect(stats.deltaSavings).toBeGreaterThan(0);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it("reports progress via onProgress callback", async () => {
      const progressCalls: number[] = [];

      const content1 = `${"M".repeat(200)} v1`;
      const content2 = `${"M".repeat(200)} v2`;

      const id1 = await source.blobs.store([new TextEncoder().encode(content1)]);
      const id2 = await source.blobs.store([new TextEncoder().encode(content2)]);

      const builder = deltaSerializer.createPackBuilder({
        onProgress: (stats) => progressCalls.push(stats.totalObjects),
      });
      await builder.addObjectWithDelta(id1);
      await builder.addObjectWithDelta(id2);

      expect(progressCalls).toEqual([1, 2]);
    });
  });

  describe("window eviction", () => {
    it("handles more objects than window size", async () => {
      // Create 15 similar blobs (window size is 10)
      const ids: string[] = [];
      for (let i = 0; i < 15; i++) {
        const content = `${"W".repeat(200)} item ${i.toString().padStart(3, "0")}`;
        const id = await source.blobs.store([new TextEncoder().encode(content)]);
        ids.push(id);
      }

      const builder = deltaSerializer.createPackBuilder();
      for (const id of ids) {
        await builder.addObjectWithDelta(id);
      }

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(15);
      // Most should be deltified (first one is always full)
      expect(stats.deltifiedObjects).toBeGreaterThanOrEqual(10);
    });
  });

  describe("mixed object types", () => {
    it("only deltifies within same type", async () => {
      // Create a blob, tree, and commit with similar byte patterns
      const blob = await source.blobs.store([new TextEncoder().encode("Q".repeat(200))]);
      const tree = await source.trees.store([{ mode: 0o100644, name: "q-file.txt", id: blob }]);
      const commit = await source.commits.store({
        tree,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Q".repeat(200),
      });

      const builder = deltaSerializer.createPackBuilder();
      await builder.addObjectWithDelta(blob);
      await builder.addObjectWithDelta(tree);
      await builder.addObjectWithDelta(commit);

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(3);
      // No cross-type deltas (each type appears only once in window)
      expect(stats.deltifiedObjects).toBe(0);
    });
  });
});

// --- Helper functions ---

function createTestPerson(overrides?: Partial<PersonIdent>): PersonIdent {
  return {
    name: "Test Author",
    email: "test@example.com",
    timestamp: overrides?.timestamp ?? 1700000000,
    tzOffset: overrides?.tzOffset ?? "+0000",
    ...overrides,
  };
}

async function createSimpleCommit(
  history: HistoryWithOperations,
  message: string,
  parents: string[],
): Promise<string> {
  const blobId = await history.blobs.store([new TextEncoder().encode(message)]);
  const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
  return history.commits.store({
    tree: treeId,
    parents,
    author: createTestPerson(),
    committer: createTestPerson(),
    message,
  });
}

async function collectPackBytes(pack: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

async function* toAsyncObjectIds(ids: string[]): AsyncIterable<string> {
  for (const id of ids) {
    yield id;
  }
}
