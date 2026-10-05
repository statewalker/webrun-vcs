import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend, repack } from "../src/index.js";

describe("repack", () => {
  it("returns null when no loose objects exist", async () => {
    const files = createInMemoryFilesApi();
    const { looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });

    const result = await repack({ looseStorage, packDirectory, files });
    expect(result).toBeNull();
  });

  it("packs loose objects into a pack file", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    // Store some objects as loose
    const enc = new TextEncoder();
    const blob1 = await history.blobs.store([enc.encode("hello")]);
    const blob2 = await history.blobs.store([enc.encode("world")]);
    const treeId = await history.trees.store([
      { name: "a.txt", mode: 0o100644, id: blob1 },
      { name: "b.txt", mode: 0o100644, id: blob2 },
    ]);

    // Verify loose objects exist
    expect(await looseStorage.has(blob1)).toBe(true);
    expect(await looseStorage.has(blob2)).toBe(true);
    expect(await looseStorage.has(treeId)).toBe(true);

    // Run repack
    const result = await repack({ looseStorage, packDirectory, files });

    expect(result).not.toBeNull();
    expect(result?.objectCount).toBe(3);
    expect(result?.looseObjectsRemoved).toBe(3);
    expect(result?.packName).toMatch(/^pack-[0-9a-f]{40}$/);

    // Loose objects should be removed
    expect(await looseStorage.has(blob1)).toBe(false);
    expect(await looseStorage.has(blob2)).toBe(false);
    expect(await looseStorage.has(treeId)).toBe(false);

    // Pack directory should have the new pack
    await packDirectory.invalidate(); // Force rescan
    const packs = await packDirectory.scan();
    expect(packs.length).toBe(1);
    expect(packs[0]).toBe(result?.packName);
  });

  it("objects are readable from pack after repack", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    const enc = new TextEncoder();
    const blobId = await history.blobs.store([enc.encode("pack me")]);
    const treeId = await history.trees.store([{ name: "file.txt", mode: 0o100644, id: blobId }]);

    // Repack
    await repack({ looseStorage, packDirectory, files });

    // Re-open the backend to pick up pack files
    const { history: h2 } = await createGitFilesBackend({ files });
    await h2.initialize();

    // Objects should be readable through the history via pack fallback
    expect(await h2.blobs.has(blobId)).toBe(true);
    expect(await h2.trees.has(treeId)).toBe(true);

    // Verify blob content round-trips
    const chunks: Uint8Array[] = [];
    const stream = await h2.blobs.load(blobId);
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }
    const decoded = new TextDecoder().decode(concatBytes(chunks));
    expect(decoded).toBe("pack me");

    await h2.close();
  });

  it("dry run reports count without modifying anything", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    const enc = new TextEncoder();
    const blobId = await history.blobs.store([enc.encode("dry run test")]);

    const result = await repack({
      looseStorage,
      packDirectory,
      files,
      dryRun: true,
    });

    expect(result).not.toBeNull();
    expect(result?.objectCount).toBe(1);
    expect(result?.looseObjectsRemoved).toBe(0);
    expect(result?.packName).toBe("");

    // Object should still be loose
    expect(await looseStorage.has(blobId)).toBe(true);

    // No pack files should have been created
    await packDirectory.invalidate();
    const packs = await packDirectory.scan();
    expect(packs.length).toBe(0);
  });

  it("handles commits with full object graphs", async () => {
    const files = createInMemoryFilesApi();
    const { history, looseStorage, packDirectory } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    const enc = new TextEncoder();
    const blobId = await history.blobs.store([enc.encode("content")]);
    const treeId = await history.trees.store([{ name: "file.txt", mode: 0o100644, id: blobId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: [],
      author: {
        name: "Test",
        email: "test@test.com",
        timestamp: 1000000,
        tzOffset: "+0000",
      },
      committer: {
        name: "Test",
        email: "test@test.com",
        timestamp: 1000000,
        tzOffset: "+0000",
      },
      message: "initial commit\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    // Repack all 3 objects (blob + tree + commit)
    const result = await repack({ looseStorage, packDirectory, files });
    expect(result).not.toBeNull();
    expect(result?.objectCount).toBe(3);

    // Re-open and verify commit is readable
    const { history: h2 } = await createGitFilesBackend({ files });
    await h2.initialize();

    const loaded = await h2.commits.load(commitId);
    expect(loaded).toBeTruthy();
    expect(loaded?.tree).toBe(treeId);
    expect(loaded?.message).toBe("initial commit\n");

    await h2.close();
  });
});

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
