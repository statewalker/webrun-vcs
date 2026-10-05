/**
 * T3.8: Cross-Backend Integration Tests
 *
 * Tests data interoperability between different History backends:
 * - Memory → Memory migration via pack export/import
 * - Data integrity verification after migration
 * - Content-addressed deduplication across backends
 * - Complex repository migration (branches, tags, history)
 * - Loose object round-trip between backends
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";
import { ObjectType } from "../../src/history/objects/object-types.js";

describe("Cross-Backend Integration", () => {
  let sourceHistory: HistoryWithOperations;
  let targetHistory: HistoryWithOperations;

  beforeEach(async () => {
    sourceHistory = createMemoryHistoryWithOperations();
    targetHistory = createMemoryHistoryWithOperations();
    await sourceHistory.initialize();
    await targetHistory.initialize();
  });

  afterEach(async () => {
    await sourceHistory.close();
    await targetHistory.close();
  });

  describe("repository migration via pack", () => {
    it("migrates single-branch repository", async () => {
      // Build a repository with 5 commits on main
      const tipId = await createCommitChain(sourceHistory, 5);
      await sourceHistory.refs.set("refs/heads/main", tipId);
      await sourceHistory.refs.setSymbolic("HEAD", "refs/heads/main");

      // Migrate via pack
      await migrateRepository(sourceHistory, targetHistory, ["refs/heads/main"]);

      // Verify all commits migrated
      let count = 0;
      let current: string | undefined = tipId;
      while (current) {
        const commit = await targetHistory.commits.load(current);
        expect(commit).toBeDefined();
        count++;
        current = commit?.parents[0];
      }
      expect(count).toBe(5);

      // Verify refs migrated
      const targetRef = await targetHistory.refs.resolve("refs/heads/main");
      expect(targetRef?.objectId).toBe(tipId);
    });

    it("migrates multi-branch repository", async () => {
      // Build repo: base → main branch (2 more commits) + feature branch (3 more commits)
      const baseId = await createSimpleCommit(sourceHistory, "Base", []);
      const mainTip = await createCommitChain(sourceHistory, 2, baseId);
      const featureTip = await createCommitChain(sourceHistory, 3, baseId);

      await sourceHistory.refs.set("refs/heads/main", mainTip);
      await sourceHistory.refs.set("refs/heads/feature", featureTip);

      // Migrate both branches
      await migrateRepository(sourceHistory, targetHistory, [
        "refs/heads/main",
        "refs/heads/feature",
      ]);

      // Verify both branches exist
      expect(await targetHistory.refs.resolve("refs/heads/main")).toBeDefined();
      expect(await targetHistory.refs.resolve("refs/heads/feature")).toBeDefined();
      expect((await targetHistory.refs.resolve("refs/heads/main"))?.objectId).toBe(mainTip);
      expect((await targetHistory.refs.resolve("refs/heads/feature"))?.objectId).toBe(featureTip);

      // Verify shared base exists and is shared
      const sourceBase = await sourceHistory.commits.load(baseId);
      const targetBase = await targetHistory.commits.load(baseId);
      expect(targetBase).toBeDefined();
      expect(targetBase?.message).toBe(sourceBase?.message);
    });

    it("migrates repository with merge history", async () => {
      const base = await createSimpleCommit(sourceHistory, "Base", []);
      const left = await createSimpleCommit(sourceHistory, "Left", [base]);
      const right = await createSimpleCommit(sourceHistory, "Right", [base]);
      const merge = await createSimpleCommit(sourceHistory, "Merge", [left, right]);

      await sourceHistory.refs.set("refs/heads/main", merge);

      await migrateRepository(sourceHistory, targetHistory, ["refs/heads/main"]);

      // Verify merge commit preserved
      const targetMerge = await targetHistory.commits.load(merge);
      expect(targetMerge).toBeDefined();
      expect(targetMerge?.parents).toHaveLength(2);
      expect(targetMerge?.parents).toContain(left);
      expect(targetMerge?.parents).toContain(right);
    });

    it("migrates repository with annotated tags", async () => {
      const commitId = await createSimpleCommit(sourceHistory, "Tagged", []);
      const tagId = await sourceHistory.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: createTestPerson(),
        message: "Release v1.0.0",
      });

      await sourceHistory.refs.set("refs/heads/main", commitId);
      await sourceHistory.refs.set("refs/tags/v1.0.0", tagId);

      // Migrate including tag object
      await migrateRepository(sourceHistory, targetHistory, ["refs/heads/main"], [tagId]);

      // Copy tag ref
      await targetHistory.refs.set("refs/tags/v1.0.0", tagId);

      // Verify tag migrated
      const targetTag = await targetHistory.tags.load(tagId);
      expect(targetTag).toBeDefined();
      expect(targetTag?.tag).toBe("v1.0.0");
      expect(targetTag?.object).toBe(commitId);
      expect(targetTag?.message).toBe("Release v1.0.0");
    });
  });

  describe("data integrity verification", () => {
    it("preserves blob content exactly", async () => {
      const testContents = [
        "Simple text",
        "Line 1\nLine 2\nLine 3",
        "\x00\x01\x02\x03\x04\x05", // Binary
        "\u{1F600} Emoji content \u{2764}",
        "X".repeat(100000), // Large content
      ];

      for (const content of testContents) {
        const encoded = new TextEncoder().encode(content);
        const blobId = await sourceHistory.blobs.store([encoded]);
        const treeId = await sourceHistory.trees.store([
          { mode: 0o100644, name: "test.bin", id: blobId },
        ]);
        const commitId = await sourceHistory.commits.store({
          tree: treeId,
          parents: [],
          author: createTestPerson(),
          committer: createTestPerson(),
          message: "Content test",
        });

        // Migrate
        const freshTarget = createMemoryHistoryWithOperations();
        await freshTarget.initialize();

        const objects = sourceHistory.collectReachableObjects(new Set([commitId]), new Set());
        const packBytes = await collectPackBytes(sourceHistory.serialization.createPack(objects));
        await freshTarget.serialization.importPack(toAsyncIterable(packBytes));

        // Verify content preserved
        const loadedBlob = await freshTarget.blobs.load(blobId);
        expect(loadedBlob).toBeDefined();
        const loadedBytes = await collectAsyncIterableBytes(loadedBlob!);
        expect(loadedBytes).toEqual(encoded);

        await freshTarget.close();
      }
    });

    it("preserves tree structure exactly", async () => {
      // Create complex tree
      const blobA = await sourceHistory.blobs.store([new TextEncoder().encode("A")]);
      const blobB = await sourceHistory.blobs.store([new TextEncoder().encode("B")]);
      const blobC = await sourceHistory.blobs.store([new TextEncoder().encode("C")]);

      const subTree = await sourceHistory.trees.store([
        { mode: 0o100644, name: "b.txt", id: blobB },
        { mode: 0o100755, name: "script.sh", id: blobC },
      ]);
      const rootTree = await sourceHistory.trees.store([
        { mode: 0o100644, name: "a.txt", id: blobA },
        { mode: 0o40000, name: "sub", id: subTree },
      ]);
      const commitId = await sourceHistory.commits.store({
        tree: rootTree,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Complex tree",
      });

      // Migrate
      const objects = sourceHistory.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceHistory.serialization.createPack(objects));
      await targetHistory.serialization.importPack(toAsyncIterable(packBytes));

      // Verify root tree
      const targetRoot = await targetHistory.trees.load(rootTree);
      expect(targetRoot).toBeDefined();
      const rootEntries = await collectAsyncIterable(targetRoot!);
      expect(rootEntries).toHaveLength(2);

      const aEntry = rootEntries.find((e) => e.name === "a.txt");
      expect(aEntry?.mode).toBe(0o100644);
      expect(aEntry?.id).toBe(blobA);

      const subEntry = rootEntries.find((e) => e.name === "sub");
      expect(subEntry?.mode).toBe(0o40000);

      // Verify sub tree
      const targetSub = await targetHistory.trees.load(subEntry?.id);
      expect(targetSub).toBeDefined();
      const subEntries = await collectAsyncIterable(targetSub!);
      expect(subEntries).toHaveLength(2);

      const scriptEntry = subEntries.find((e) => e.name === "script.sh");
      expect(scriptEntry?.mode).toBe(0o100755);
    });

    it("preserves commit metadata exactly", async () => {
      const author: PersonIdent = {
        name: "Alice Author",
        email: "alice@example.com",
        timestamp: 1700000000,
        tzOffset: "+0530",
      };
      const committer: PersonIdent = {
        name: "Bob Committer",
        email: "bob@example.com",
        timestamp: 1700001000,
        tzOffset: "-0800",
      };

      const blobId = await sourceHistory.blobs.store([new TextEncoder().encode("test")]);
      const treeId = await sourceHistory.trees.store([
        { mode: 0o100644, name: "f.txt", id: blobId },
      ]);
      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author,
        committer,
        message: "Multi-line\n\nWith paragraph",
      });

      // Migrate
      const objects = sourceHistory.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceHistory.serialization.createPack(objects));
      await targetHistory.serialization.importPack(toAsyncIterable(packBytes));

      const loaded = await targetHistory.commits.load(commitId);
      expect(loaded).toBeDefined();
      expect(loaded?.author.name).toBe("Alice Author");
      expect(loaded?.author.email).toBe("alice@example.com");
      expect(loaded?.author.timestamp).toBe(1700000000);
      expect(loaded?.committer.name).toBe("Bob Committer");
      expect(loaded?.committer.timestamp).toBe(1700001000);
      expect(loaded?.message).toBe("Multi-line\n\nWith paragraph");
    });
  });

  describe("content-addressed deduplication", () => {
    it("identical objects get same IDs across backends", async () => {
      const content = new TextEncoder().encode("Shared content");

      // Store in source
      const sourceId = await sourceHistory.blobs.store([content]);

      // Store in target independently
      const targetId = await targetHistory.blobs.store([content]);

      // Content-addressed: same content = same ID
      expect(sourceId).toBe(targetId);
    });

    it("migration does not duplicate existing objects", async () => {
      const content = new TextEncoder().encode("Pre-existing content");

      // Create same blob in both
      const blobId = await sourceHistory.blobs.store([content]);
      await targetHistory.blobs.store([content]);

      // Create commit in source only
      const treeId = await sourceHistory.trees.store([
        { mode: 0o100644, name: "file.txt", id: blobId },
      ]);
      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Dedup test",
      });

      // Migrate
      const objects = sourceHistory.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(sourceHistory.serialization.createPack(objects));
      const result = await targetHistory.serialization.importPack(toAsyncIterable(packBytes));

      // Import should still work
      expect(result.objectsImported).toBeGreaterThan(0);

      // Verify blob is accessible (same ID)
      const loaded = await targetHistory.blobs.load(blobId);
      expect(loaded).toBeDefined();
    });
  });

  describe("loose object interoperability", () => {
    it("round-trips objects through loose format between backends", async () => {
      const content = "Loose interop test";
      const encoded = new TextEncoder().encode(content);
      const blobId = await sourceHistory.blobs.store([encoded]);

      // Serialize to loose format from source
      const looseBytes = await collectAsyncIterableBytes(
        sourceHistory.serialization.serializeLooseObject(blobId),
      );

      // Parse into target
      const meta = await targetHistory.serialization.parseLooseObject(toAsyncIterable(looseBytes));
      expect(meta.id).toBe(blobId);
      expect(meta.type).toBe("blob");

      // Verify in target
      const loaded = await targetHistory.blobs.load(blobId);
      expect(loaded).toBeDefined();
      const loadedBytes = await collectAsyncIterableBytes(loaded!);
      expect(new TextDecoder().decode(loadedBytes)).toBe(content);
    });

    it("round-trips all object types through loose format", async () => {
      // Create a commit with tree and blob
      const blobId = await sourceHistory.blobs.store([new TextEncoder().encode("loose all")]);
      const treeId = await sourceHistory.trees.store([
        { mode: 0o100644, name: "test.txt", id: blobId },
      ]);
      const commitId = await sourceHistory.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Loose all types",
      });

      // Transfer each object type via loose format
      for (const id of [blobId, treeId, commitId]) {
        const loose = await collectAsyncIterableBytes(
          sourceHistory.serialization.serializeLooseObject(id),
        );
        await targetHistory.serialization.parseLooseObject(toAsyncIterable(loose));
      }

      // Verify all objects in target
      const loadedBlob = await targetHistory.blobs.load(blobId);
      expect(loadedBlob).toBeDefined();

      const loadedTree = await targetHistory.trees.load(treeId);
      expect(loadedTree).toBeDefined();

      const loadedCommit = await targetHistory.commits.load(commitId);
      expect(loadedCommit).toBeDefined();
      expect(loadedCommit?.message).toBe("Loose all types");
    });
  });

  describe("incremental migration", () => {
    it("migrates repository incrementally", async () => {
      // Phase 1: initial migration
      const phase1Tip = await createCommitChain(sourceHistory, 3);
      await sourceHistory.refs.set("refs/heads/main", phase1Tip);

      await migrateRepository(sourceHistory, targetHistory, ["refs/heads/main"]);
      const targetPhase1 = await targetHistory.refs.resolve("refs/heads/main");
      expect(targetPhase1?.objectId).toBe(phase1Tip);

      // Phase 2: incremental migration
      const phase2Tip = await createCommitChain(sourceHistory, 3, phase1Tip);
      await sourceHistory.refs.set("refs/heads/main", phase2Tip);

      // Only migrate new objects
      const newObjects = sourceHistory.collectReachableObjects(
        new Set([phase2Tip]),
        new Set([phase1Tip]),
      );
      const pack = await collectPackBytes(sourceHistory.serialization.createPack(newObjects));
      await targetHistory.serialization.importPack(toAsyncIterable(pack));
      await targetHistory.refs.set("refs/heads/main", phase2Tip);

      // Verify full chain in target
      let count = 0;
      let current: string | undefined = phase2Tip;
      while (current) {
        expect(await targetHistory.commits.load(current)).toBeDefined();
        count++;
        current = (await targetHistory.commits.load(current))?.parents[0];
      }
      expect(count).toBe(6);
    });
  });
});

// --- Helper functions ---

function createTestPerson(): PersonIdent {
  return {
    name: "Test Author",
    email: "test@example.com",
    timestamp: 1700000000,
    tzOffset: "+0000",
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

async function migrateRepository(
  source: HistoryWithOperations,
  target: HistoryWithOperations,
  refNames: string[],
  extraObjects: string[] = [],
): Promise<void> {
  // Collect all ref tips
  const wants = new Set<string>();
  for (const refName of refNames) {
    const ref = await source.refs.resolve(refName);
    if (ref?.objectId) {
      wants.add(ref.objectId);
    }
  }
  for (const id of extraObjects) {
    wants.add(id);
  }

  // Export all reachable objects as pack
  const objects = source.collectReachableObjects(wants, new Set());
  const allObjects = async function* () {
    // Yield extra objects first (tags, etc.) that aren't reachable from commits
    for (const id of extraObjects) {
      yield id;
    }
    yield* objects;
  };

  const packBytes = await collectPackBytes(source.serialization.createPack(allObjects()));
  await target.serialization.importPack(toAsyncIterable(packBytes));

  // Copy refs
  for (const refName of refNames) {
    const ref = await source.refs.resolve(refName);
    if (ref?.objectId) {
      await target.refs.set(refName, ref.objectId);
    }
  }
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
