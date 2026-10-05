import { createInMemoryFilesApi, GcOrchestrator } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend, FileGcStrategy } from "../src/index.js";

describe("FileGcStrategy", () => {
  it("prunes unreachable loose objects", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");

    const enc = new TextEncoder();

    // Create orphan blob
    const orphanId = await history.blobs.store([enc.encode("orphan")]);

    // Create referenced chain
    const keptId = await history.blobs.store([enc.encode("kept")]);
    const treeId = await history.trees.store([{ name: "f.txt", mode: 0o100644, id: keptId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      message: "init\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const strategy = new FileGcStrategy({ looseStorage, packDirectory });
    const orchestrator = new GcOrchestrator(history, strategy);

    const result = await orchestrator.run();
    expect(result.prunedObjects).toBe(1);

    // Orphan gone, kept blob remains
    expect(await history.blobs.has(orphanId)).toBe(false);
    expect(await history.blobs.has(keptId)).toBe(true);
  });

  it("compacts loose objects into pack files", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
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
      message: "compact\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const strategy = new FileGcStrategy({ looseStorage, packDirectory });

    // Compact: should repack loose objects
    const compactResult = await strategy.compact();
    expect(compactResult.packsCreated).toBe(1);
    expect(compactResult.objectsPacked).toBe(3);

    // Loose objects should be gone
    expect(await looseStorage.has(blobId)).toBe(false);

    // Stats should reflect packs
    const stats = await strategy.getStats();
    expect(stats.looseObjectCount).toBe(0);
    expect(stats.packedObjectCount).toBe(3);
    expect(stats.packCount).toBe(1);
  });

  it("prune + compact via orchestrator", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();
    await history.refs.setSymbolic("HEAD", "refs/heads/main");

    const enc = new TextEncoder();

    // Orphan
    await history.blobs.store([enc.encode("trash")]);

    // Referenced
    const blobId = await history.blobs.store([enc.encode("keep")]);
    const treeId = await history.trees.store([{ name: "f.txt", mode: 0o100644, id: blobId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" },
      message: "both\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const strategy = new FileGcStrategy({ looseStorage, packDirectory });
    const orchestrator = new GcOrchestrator(history, strategy);

    const result = await orchestrator.run({ compact: true });

    expect(result.prunedObjects).toBe(1); // orphan
    expect(result.compactResult?.packsCreated).toBe(1);
    expect(result.compactResult?.objectsPacked).toBe(3);
    expect(result.stats?.looseObjectCount).toBe(0);
    expect(result.stats?.packedObjectCount).toBe(3);
  });

  it("getStats counts loose and packed objects", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    const enc = new TextEncoder();
    await history.blobs.store([enc.encode("a")]);
    await history.blobs.store([enc.encode("b")]);

    const strategy = new FileGcStrategy({ looseStorage, packDirectory });
    const stats = await strategy.getStats();

    expect(stats.looseObjectCount).toBe(2);
    expect(stats.packedObjectCount).toBe(0);
    expect(stats.packCount).toBe(0);
  });
});
