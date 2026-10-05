import { describe, expect, it } from "vitest";
import {
  createGitObjectStore,
  createHistoryFromComponents,
  GcOrchestrator,
  MemoryGcStrategy,
  MemoryRawStorage,
} from "../../src/index.js";

function createTestSetup() {
  const storage = new MemoryRawStorage();
  const objects = createGitObjectStore(storage);
  const history = createHistoryFromComponents({ objects, refs: { type: "memory" } });
  const strategy = new MemoryGcStrategy(storage);
  const orchestrator = new GcOrchestrator(history, strategy);
  return { history, strategy, orchestrator, storage };
}

describe("GcOrchestrator", () => {
  it("prunes unreachable objects", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");

    const enc = new TextEncoder();

    // Create an orphan blob (not referenced by any commit)
    const orphanId = await history.blobs.store([enc.encode("orphan")]);

    // Create a referenced chain: blob → tree → commit → ref
    const keptId = await history.blobs.store([enc.encode("kept")]);
    const treeId = await history.trees.store([{ name: "file.txt", mode: 0o100644, id: keptId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      message: "init\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    // Verify orphan exists
    expect(await history.blobs.has(orphanId)).toBe(true);

    const result = await orchestrator.run();

    expect(result.prunedObjects).toBe(1);
    expect(result.reachableObjects).toBe(3); // blob + tree + commit

    // Orphan should be gone
    expect(await history.blobs.has(orphanId)).toBe(false);
    // Referenced blob should remain
    expect(await history.blobs.has(keptId)).toBe(true);
  });

  it("returns zero prunes when all objects are reachable", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");

    const enc = new TextEncoder();
    const blobId = await history.blobs.store([enc.encode("content")]);
    const treeId = await history.trees.store([{ name: "f.txt", mode: 0o100644, id: blobId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      message: "all reachable\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const result = await orchestrator.run();
    expect(result.prunedObjects).toBe(0);
    expect(result.reachableObjects).toBe(3);
  });

  it("dry run reports but does not prune", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();

    const enc = new TextEncoder();
    const orphanId = await history.blobs.store([enc.encode("orphan")]);

    const result = await orchestrator.run({ dryRun: true });

    expect(result.prunedObjects).toBe(1);
    // Orphan should still exist
    expect(await history.blobs.has(orphanId)).toBe(true);
  });

  it("runs compaction when requested", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();

    const result = await orchestrator.run({ compact: true });

    // MemoryGcStrategy compact is a no-op
    expect(result.compactResult).toEqual({
      packsCreated: 0,
      objectsPacked: 0,
      packsMerged: 0,
    });
  });

  it("returns storage stats", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");

    const enc = new TextEncoder();
    const blobId = await history.blobs.store([enc.encode("hello")]);
    const treeId = await history.trees.store([{ name: "a.txt", mode: 0o100644, id: blobId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      message: "stats\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const result = await orchestrator.run();

    expect(result.stats).toBeDefined();
    expect(result.stats?.looseObjectCount).toBe(3);
    expect(result.stats?.packedObjectCount).toBe(0);
    expect(result.stats?.packCount).toBe(0);
    expect(result.stats?.totalSize).toBeGreaterThan(0);
  });

  it("handles empty repository", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();

    const result = await orchestrator.run();

    expect(result.prunedObjects).toBe(0);
    expect(result.reachableObjects).toBe(0);
  });

  it("aggressive mode calls deltify", async () => {
    const { history, orchestrator } = createTestSetup();
    await history.initialize();

    const result = await orchestrator.run({ aggressive: true });

    // MemoryGcStrategy deltify is a no-op
    expect(result.deltasCreated).toBe(0);
  });
});
