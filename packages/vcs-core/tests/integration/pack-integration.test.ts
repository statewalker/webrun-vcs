/**
 * T3.2: Pack Import/Export Integration Tests
 *
 * Tests pack file creation and parsing including:
 * - Single commit export/import round-trip
 * - Commit chain export/import
 * - Incremental export with haves (only new objects)
 * - Pack format correctness (header, checksum)
 * - Error handling (corrupted pack)
 * - PackReader and PackBuilder APIs
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";
import { ObjectType } from "../../src/history/objects/object-types.js";
import type { SerializationApi } from "../../src/serialization/serialization-api.js";

describe("Pack Import/Export Integration", () => {
  let source: HistoryWithOperations;
  let target: HistoryWithOperations;
  let sourceSerialization: SerializationApi;
  let targetSerialization: SerializationApi;

  beforeEach(async () => {
    source = createMemoryHistoryWithOperations();
    target = createMemoryHistoryWithOperations();
    await source.initialize();
    await target.initialize();
    sourceSerialization = source.serialization;
    targetSerialization = target.serialization;
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  describe("createPack() and importPack() round-trip", () => {
    it("exports and imports a single commit", async () => {
      const commitId = await createSimpleCommit(source, "Initial commit", []);

      // Collect objects and create pack
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Import into target
      const result = await targetSerialization.importPack(toAsyncIterable(packBytes));

      expect(result.objectsImported).toBeGreaterThanOrEqual(3); // blob + tree + commit
      expect(result.commitsImported).toBe(1);
      expect(result.treesImported).toBe(1);

      // Verify the commit exists in target and content matches
      const loadedCommit = await target.commits.load(commitId);
      expect(loadedCommit).toBeDefined();
      expect(loadedCommit?.message).toBe("Initial commit");

      // Verify tree
      const loadedTree = await target.trees.load(loadedCommit?.tree);
      expect(loadedTree).toBeDefined();
      const entries = await collectAsyncIterable(loadedTree!);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("file.txt");

      // Verify blob content
      const blobContent = await target.blobs.load(entries[0].id);
      expect(blobContent).toBeDefined();
      const bytes = await collectAsyncIterableBytes(blobContent!);
      expect(new TextDecoder().decode(bytes)).toBe("Initial commit");
    });

    it("exports and imports a commit chain", async () => {
      const tipId = await createCommitChain(source, 5);

      // Export all reachable objects
      const objects = source.collectReachableObjects(new Set([tipId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Import into target
      const result = await targetSerialization.importPack(toAsyncIterable(packBytes));
      expect(result.commitsImported).toBe(5);

      // Walk the chain in target to verify all commits exist
      let count = 0;
      let current: string | undefined = tipId;
      while (current) {
        const commit = await target.commits.load(current);
        expect(commit).toBeDefined();
        count++;
        current = commit?.parents[0];
      }
      expect(count).toBe(5);
    });

    it("exports incremental pack with haves", async () => {
      // Create initial chain and sync to target
      const baseId = await createCommitChain(source, 3);
      const basePack = await collectPackBytes(
        sourceSerialization.createPack(
          source.collectReachableObjects(new Set([baseId]), new Set()),
        ),
      );
      await targetSerialization.importPack(toAsyncIterable(basePack));

      // Create more commits on top
      const tipId = await createCommitChain(source, 3, baseId);

      // Export only new objects (using haves to exclude already-synced objects)
      const incrementalObjects = source.collectReachableObjects(
        new Set([tipId]),
        new Set([baseId]),
      );
      const incrementalPack = await collectPackBytes(
        sourceSerialization.createPack(incrementalObjects),
      );

      // Incremental pack should be smaller since it excludes base objects
      expect(incrementalPack.length).toBeLessThan(basePack.length * 2);

      // Import incremental
      const result = await targetSerialization.importPack(toAsyncIterable(incrementalPack));
      expect(result.commitsImported).toBe(3);

      // Verify new tip exists and the full chain is walkable
      const loaded = await target.commits.load(tipId);
      expect(loaded).toBeDefined();

      // Walk the full chain (base + new)
      let count = 0;
      let current: string | undefined = tipId;
      while (current) {
        const commit = await target.commits.load(current);
        expect(commit).toBeDefined();
        count++;
        current = commit?.parents[0];
      }
      expect(count).toBe(6); // 3 base + 3 new
    });

    it("preserves tree structures with multiple entries", async () => {
      // Create files
      const fileA = await source.blobs.store([new TextEncoder().encode("File A content")]);
      const fileB = await source.blobs.store([new TextEncoder().encode("File B content")]);
      const fileC = await source.blobs.store([new TextEncoder().encode("File C content")]);

      // Create nested tree structure
      const subTree = await source.trees.store([{ mode: 0o100644, name: "helper.js", id: fileC }]);
      const rootTree = await source.trees.store([
        { mode: 0o100644, name: "index.js", id: fileA },
        { mode: 0o100644, name: "readme.md", id: fileB },
        { mode: 0o40000, name: "utils", id: subTree },
      ]);

      const commitId = await source.commits.store({
        tree: rootTree,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Multi-file commit",
      });

      // Export and import
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));
      await targetSerialization.importPack(toAsyncIterable(packBytes));

      // Verify tree structure in target
      const loadedCommit = await target.commits.load(commitId);
      expect(loadedCommit).toBeDefined();

      const rootEntries = await collectAsyncIterable(
        (await target.trees.load(loadedCommit?.tree))!,
      );
      expect(rootEntries).toHaveLength(3);

      const utilsEntry = rootEntries.find((e) => e.name === "utils");
      expect(utilsEntry).toBeDefined();
      expect(utilsEntry?.mode).toBe(0o40000);

      const subEntries = await collectAsyncIterable((await target.trees.load(utilsEntry?.id))!);
      expect(subEntries).toHaveLength(1);
      expect(subEntries[0].name).toBe("helper.js");

      // Verify file content
      const helperBlob = await target.blobs.load(subEntries[0].id);
      expect(helperBlob).toBeDefined();
      const helperContent = await collectAsyncIterableBytes(helperBlob!);
      expect(new TextDecoder().decode(helperContent)).toBe("File C content");
    });

    it("handles merge commits with multiple parents", async () => {
      const base = await createSimpleCommit(source, "Base", []);
      const branch1 = await createSimpleCommit(source, "Branch 1", [base]);
      const branch2 = await createSimpleCommit(source, "Branch 2", [base]);
      const merge = await createSimpleCommit(source, "Merge", [branch1, branch2]);

      // Export and import
      const objects = source.collectReachableObjects(new Set([merge]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));
      await targetSerialization.importPack(toAsyncIterable(packBytes));

      // Verify merge commit has both parents
      const loadedMerge = await target.commits.load(merge);
      expect(loadedMerge).toBeDefined();
      expect(loadedMerge?.parents).toHaveLength(2);
      expect(loadedMerge?.parents).toContain(branch1);
      expect(loadedMerge?.parents).toContain(branch2);
    });

    it("handles annotated tags", async () => {
      const commitId = await createSimpleCommit(source, "Tagged commit", []);
      const tagId = await source.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: createTestPerson(),
        message: "Release v1.0.0",
      });

      // Export tag + commit
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const allObjects = async function* () {
        yield tagId;
        yield* objects;
      };
      const packBytes = await collectPackBytes(sourceSerialization.createPack(allObjects()));
      const result = await targetSerialization.importPack(toAsyncIterable(packBytes));

      expect(result.tagsImported).toBe(1);

      // Verify tag in target
      const loadedTag = await target.tags.load(tagId);
      expect(loadedTag).toBeDefined();
      expect(loadedTag?.tag).toBe("v1.0.0");
      expect(loadedTag?.object).toBe(commitId);
      expect(loadedTag?.message).toBe("Release v1.0.0");
    });
  });

  describe("pack format correctness", () => {
    it("produces valid pack header", async () => {
      const commitId = await createSimpleCommit(source, "Test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Check pack header: "PACK" (4 bytes) + version (4 bytes) + count (4 bytes)
      expect(packBytes.length).toBeGreaterThanOrEqual(12);

      const signature = new TextDecoder().decode(packBytes.slice(0, 4));
      expect(signature).toBe("PACK");

      const view = new DataView(packBytes.buffer, packBytes.byteOffset);
      const version = view.getUint32(4, false);
      expect(version).toBe(2);

      const objectCount = view.getUint32(8, false);
      expect(objectCount).toBeGreaterThanOrEqual(3); // blob + tree + commit
    });

    it("includes valid SHA-1 checksum trailer", async () => {
      const commitId = await createSimpleCommit(source, "Test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Last 20 bytes are SHA-1 checksum
      const checksum = packBytes.slice(-20);
      expect(checksum.length).toBe(20);

      // Verify checksum matches content
      const content = packBytes.slice(0, -20);
      const computedChecksum = await sha1(content);
      expect(checksum).toEqual(computedChecksum);
    });

    it("object count in header matches actual objects", async () => {
      const tip = await createCommitChain(source, 3);
      const objects = source.collectReachableObjects(new Set([tip]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      const view = new DataView(packBytes.buffer, packBytes.byteOffset);
      const headerObjectCount = view.getUint32(8, false);

      // Parse the pack to count actual entries
      const reader = sourceSerialization.createPackReader(toAsyncIterable(packBytes));
      const header = await reader.getHeader();
      expect(header.objectCount).toBe(headerObjectCount);

      let actualCount = 0;
      for await (const _entry of reader.entries()) {
        actualCount++;
      }
      expect(actualCount).toBe(headerObjectCount);
    });
  });

  describe("PackReader API", () => {
    it("reads pack header", async () => {
      const commitId = await createSimpleCommit(source, "Test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      const reader = sourceSerialization.createPackReader(toAsyncIterable(packBytes));
      const header = await reader.getHeader();

      expect(header.version).toBe(2);
      expect(header.objectCount).toBeGreaterThanOrEqual(3);
    });

    it("iterates entries with correct types", async () => {
      const commitId = await createSimpleCommit(source, "Test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      const reader = sourceSerialization.createPackReader(toAsyncIterable(packBytes));
      const types = new Set<string>();

      for await (const entry of reader.entries()) {
        types.add(entry.type);
        expect(entry.id).toBeTruthy();
        expect(entry.size).toBeGreaterThan(0);
      }

      expect(types).toContain("blob");
      expect(types).toContain("tree");
      expect(types).toContain("commit");
    });

    it("provides resolved content for each entry", async () => {
      const blobContent = "Hello, Pack!";
      const blobId = await source.blobs.store([new TextEncoder().encode(blobContent)]);
      const treeId = await source.trees.store([{ mode: 0o100644, name: "hello.txt", id: blobId }]);
      const commitId = await source.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Pack test",
      });

      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      const reader = sourceSerialization.createPackReader(toAsyncIterable(packBytes));

      for await (const entry of reader.entries()) {
        // Every entry should have resolvedContent
        const content = await collectAsyncIterableBytes(entry.resolvedContent);
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });

  describe("PackBuilder API", () => {
    it("builds pack with addObject", async () => {
      const blobId = await source.blobs.store([new TextEncoder().encode("Builder test")]);
      const treeId = await source.trees.store([{ mode: 0o100644, name: "test.txt", id: blobId }]);
      const commitId = await source.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Builder test",
      });

      const builder = sourceSerialization.createPackBuilder();
      await builder.addObject(blobId);
      await builder.addObject(treeId);
      await builder.addObject(commitId);

      const packBytes = await collectPackBytes(builder.finalize());

      // Verify pack is valid
      const reader = sourceSerialization.createPackReader(toAsyncIterable(packBytes));
      const header = await reader.getHeader();
      expect(header.objectCount).toBe(3);

      // Verify it can be imported
      const result = await targetSerialization.importPack(toAsyncIterable(packBytes));
      expect(result.objectsImported).toBe(3);
    });

    it("tracks stats", async () => {
      const blobId = await source.blobs.store([new TextEncoder().encode("Stats test")]);

      const builder = sourceSerialization.createPackBuilder();
      await builder.addObject(blobId);

      const stats = builder.getStats();
      expect(stats.totalObjects).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it("rejects objects after finalization", async () => {
      const blobId = await source.blobs.store([new TextEncoder().encode("Finalized test")]);

      const builder = sourceSerialization.createPackBuilder();
      await builder.addObject(blobId);

      // Consume the finalize iterator
      await collectPackBytes(builder.finalize());

      // Should throw when adding after finalize
      await expect(builder.addObject(blobId)).rejects.toThrow();
    });
  });

  describe("loose object serialization", () => {
    it("round-trips a blob through loose format", async () => {
      const originalContent = "Loose object test content";
      const blobId = await source.blobs.store([new TextEncoder().encode(originalContent)]);

      // Serialize to loose format
      const looseBytes = await collectAsyncIterableBytes(
        sourceSerialization.serializeLooseObject(blobId),
      );
      expect(looseBytes.length).toBeGreaterThan(0);

      // Parse back into target
      const meta = await targetSerialization.parseLooseObject(toAsyncIterable(looseBytes));
      expect(meta.id).toBe(blobId);
      expect(meta.type).toBe("blob");
      expect(meta.size).toBe(originalContent.length);

      // Verify content in target
      const loadedBlob = await target.blobs.load(blobId);
      expect(loadedBlob).toBeDefined();
      const loadedContent = await collectAsyncIterableBytes(loadedBlob!);
      expect(new TextDecoder().decode(loadedContent)).toBe(originalContent);
    });

    it("round-trips a commit through loose format", async () => {
      const commitId = await createSimpleCommit(source, "Loose commit", []);

      // Serialize to loose format
      const looseBytes = await collectAsyncIterableBytes(
        sourceSerialization.serializeLooseObject(commitId),
      );

      // Parse back into target (need blob and tree first)
      const commit = await source.commits.load(commitId);
      const tree = await source.trees.load(commit?.tree);
      const treeEntries = await collectAsyncIterable(tree!);
      const blobLoose = await collectAsyncIterableBytes(
        sourceSerialization.serializeLooseObject(treeEntries[0].id),
      );
      const treeLoose = await collectAsyncIterableBytes(
        sourceSerialization.serializeLooseObject(commit?.tree),
      );
      await targetSerialization.parseLooseObject(toAsyncIterable(blobLoose));
      await targetSerialization.parseLooseObject(toAsyncIterable(treeLoose));

      const meta = await targetSerialization.parseLooseObject(toAsyncIterable(looseBytes));
      expect(meta.id).toBe(commitId);
      expect(meta.type).toBe("commit");
    });
  });

  describe("error handling", () => {
    it("rejects corrupted pack data", async () => {
      const commitId = await createSimpleCommit(source, "Corrupt test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Corrupt data in the middle of the pack
      const corrupted = new Uint8Array(packBytes);
      const midpoint = Math.floor(corrupted.length / 2);
      corrupted[midpoint] ^= 0xff;
      corrupted[midpoint + 1] ^= 0xff;
      corrupted[midpoint + 2] ^= 0xff;

      await expect(targetSerialization.importPack(toAsyncIterable(corrupted))).rejects.toThrow();
    });

    it("rejects pack with invalid signature", async () => {
      const invalidPack = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1]);

      await expect(targetSerialization.importPack(toAsyncIterable(invalidPack))).rejects.toThrow();
    });

    it("rejects truncated pack data", async () => {
      const commitId = await createSimpleCommit(source, "Truncate test", []);
      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

      // Truncate to just the header
      const truncated = packBytes.slice(0, 20);

      await expect(targetSerialization.importPack(toAsyncIterable(truncated))).rejects.toThrow();
    });
  });

  describe("content integrity", () => {
    it("preserves exact blob content through pack round-trip", async () => {
      const testStrings = [
        "",
        "Hello",
        "Binary content: \x00\x01\x02\x03",
        "Unicode: \u{1F600} \u{1F680} \u{2764}",
        "A".repeat(10000),
      ];

      for (const content of testStrings) {
        const encoded = new TextEncoder().encode(content);
        const blobId = await source.blobs.store([encoded]);
        const treeId = await source.trees.store([{ mode: 0o100644, name: "test.bin", id: blobId }]);
        const commitId = await source.commits.store({
          tree: treeId,
          parents: [],
          author: createTestPerson(),
          committer: createTestPerson(),
          message: `Content test: ${content.slice(0, 20)}`,
        });

        const objects = source.collectReachableObjects(new Set([commitId]), new Set());
        const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));

        // Create fresh target for each test
        const freshTarget = createMemoryHistoryWithOperations();
        await freshTarget.initialize();
        await freshTarget.serialization.importPack(toAsyncIterable(packBytes));

        const loadedBlob = await freshTarget.blobs.load(blobId);
        expect(loadedBlob).toBeDefined();
        const loadedBytes = await collectAsyncIterableBytes(loadedBlob!);
        expect(loadedBytes).toEqual(encoded);

        await freshTarget.close();
      }
    });

    it("preserves commit metadata through pack round-trip", async () => {
      const author = {
        name: "Alice Author",
        email: "alice@example.com",
        timestamp: 1700000000,
        tzOffset: "+0530",
      };
      const committer = {
        name: "Bob Committer",
        email: "bob@example.com",
        timestamp: 1700001000,
        tzOffset: "-0800",
      };

      const blobId = await source.blobs.store([new TextEncoder().encode("metadata test")]);
      const treeId = await source.trees.store([{ mode: 0o100644, name: "test.txt", id: blobId }]);
      const commitId = await source.commits.store({
        tree: treeId,
        parents: [],
        author,
        committer,
        message: "Test commit\n\nWith multi-line message\nAnd special chars: <>&\"'",
      });

      const objects = source.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceSerialization.createPack(objects));
      await targetSerialization.importPack(toAsyncIterable(packBytes));

      const loaded = await target.commits.load(commitId);
      expect(loaded).toBeDefined();
      expect(loaded?.author.name).toBe("Alice Author");
      expect(loaded?.author.email).toBe("alice@example.com");
      expect(loaded?.author.timestamp).toBe(1700000000);
      expect(loaded?.committer.name).toBe("Bob Committer");
      expect(loaded?.committer.email).toBe("bob@example.com");
      expect(loaded?.message).toBe(
        "Test commit\n\nWith multi-line message\nAnd special chars: <>&\"'",
      );
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

async function createCommitChain(
  history: HistoryWithOperations,
  count: number,
  parent?: string,
): Promise<string> {
  let current = parent;
  for (let i = 0; i < count; i++) {
    current = await createSimpleCommit(history, `Commit ${i}`, current ? [current] : []);
  }
  return current!;
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

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function collectAsyncIterableBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
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

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-1", data);
  return new Uint8Array(hash);
}
