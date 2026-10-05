import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend, createGitFilesHistoryFromFiles, gc } from "../src/index.js";

describe("createGitFilesBackend", () => {
  it("creates .git directory structure when create=true", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    expect(await files.exists(".git")).toBe(true);
    expect(await files.exists(".git/objects")).toBe(true);
    expect(await files.exists(".git/objects/pack")).toBe(true);
    expect(await files.exists(".git/refs")).toBe(true);
    expect(await files.exists(".git/refs/heads")).toBe(true);
    expect(await files.exists(".git/refs/tags")).toBe(true);
    expect(await files.exists(".git/HEAD")).toBe(true);
    expect(await files.exists(".git/config")).toBe(true);

    await history.close();
  });

  it("writes HEAD pointing to default branch", async () => {
    const files = createInMemoryFilesApi();
    await createGitFilesBackend({ files, create: true });

    const headContent = await readText(files, ".git/HEAD");
    expect(headContent).toBe("ref: refs/heads/main\n");
  });

  it("supports custom default branch", async () => {
    const files = createInMemoryFilesApi();
    await createGitFilesBackend({
      files,
      create: true,
      defaultBranch: "master",
    });

    const headContent = await readText(files, ".git/HEAD");
    expect(headContent).toBe("ref: refs/heads/master\n");
  });

  it("stores and retrieves blobs with Git-compatible format", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    const content = new TextEncoder().encode("hello world");
    const blobId = await history.blobs.store([content]);

    expect(blobId).toBeTruthy();
    expect(typeof blobId).toBe("string");

    const loaded: Uint8Array[] = [];
    const stream = await history.blobs.load(blobId);
    expect(stream).toBeTruthy();
    for await (const chunk of stream!) {
      loaded.push(chunk);
    }

    const decoded = new TextDecoder().decode(concatBytes(loaded));
    expect(decoded).toBe("hello world");

    await history.close();
  });

  it("stores and retrieves commits", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    // Store a blob
    const content = new TextEncoder().encode("file content");
    const blobId = await history.blobs.store([content]);

    // Store a tree
    const treeId = await history.trees.store([{ name: "file.txt", mode: 0o100644, id: blobId }]);

    // Store a commit
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

    expect(commitId).toBeTruthy();

    // Update ref
    await history.refs.set("refs/heads/main", commitId);
    const resolved = await history.refs.resolve("HEAD");
    expect(resolved?.objectId).toBe(commitId);

    // Load commit back
    const loaded = await history.commits.load(commitId);
    expect(loaded).toBeTruthy();
    expect(loaded?.tree).toBe(treeId);
    expect(loaded?.message).toBe("initial commit\n");

    await history.close();
  });

  it("opens existing repository without create flag", async () => {
    const files = createInMemoryFilesApi();

    // First create
    const { history: h1 } = await createGitFilesBackend({
      files,
      create: true,
    });
    await h1.initialize();

    const blobId = await h1.blobs.store([new TextEncoder().encode("data")]);
    await h1.close();

    // Re-open without create
    const { history: h2 } = await createGitFilesBackend({ files });
    await h2.initialize();

    const exists = await h2.blobs.has(blobId);
    expect(exists).toBe(true);

    await h2.close();
  });
});

describe("createGitFilesHistoryFromFiles", () => {
  it("returns HistoryWithOperations with delta and serialization", async () => {
    const files = createInMemoryFilesApi();
    const history = await createGitFilesHistoryFromFiles({
      files,
      create: true,
    });
    await history.initialize();

    // Should have delta API
    expect(history.delta).toBeTruthy();
    expect(history.delta.blobs).toBeTruthy();

    // Should have serialization API
    expect(history.serialization).toBeTruthy();

    // Should have capabilities
    expect(history.capabilities).toBeTruthy();
    expect(history.capabilities.nativeGitFormat).toBe(true);
    expect(history.capabilities.nativeBlobDeltas).toBe(true);

    // Basic operations should work
    const content = new TextEncoder().encode("hello from ops");
    const blobId = await history.blobs.store([content]);
    expect(blobId).toBeTruthy();

    await history.close();
  });
});

describe("gc", () => {
  it("removes unreachable objects", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    // Create a blob that's NOT referenced by any commit
    const orphanId = await history.blobs.store([new TextEncoder().encode("orphan")]);

    // Create a blob that IS referenced
    const keptContent = new TextEncoder().encode("kept");
    const keptId = await history.blobs.store([keptContent]);
    const treeId = await history.trees.store([{ name: "kept.txt", mode: 0o100644, id: keptId }]);
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
      message: "keep this\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    // Verify orphan exists
    expect(await history.blobs.has(orphanId)).toBe(true);

    // Run GC
    const result = await gc({
      history,
      files,
    });

    expect(result.removedObjects).toBe(1); // orphan blob
    expect(result.reachableObjects).toBeGreaterThanOrEqual(3); // blob + tree + commit

    // Orphan should be gone
    expect(await history.blobs.has(orphanId)).toBe(false);

    // Referenced blob should still exist
    expect(await history.blobs.has(keptId)).toBe(true);

    await history.close();
  });

  it("reports but does not remove in dry-run mode", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    // Create an orphan blob
    const orphanId = await history.blobs.store([new TextEncoder().encode("orphan")]);

    const result = await gc({
      history,
      files,
      dryRun: true,
    });

    expect(result.removedObjects).toBe(1);
    // But the blob should still exist
    expect(await history.blobs.has(orphanId)).toBe(true);

    await history.close();
  });

  it("returns zero removals when all objects are reachable", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({
      files,
      create: true,
    });
    await history.initialize();

    // Create a fully referenced chain
    const blobId = await history.blobs.store([new TextEncoder().encode("content")]);
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
      message: "all reachable\n",
    });
    await history.refs.set("refs/heads/main", commitId);

    const result = await gc({ history, files });
    expect(result.removedObjects).toBe(0);

    await history.close();
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

async function readText(
  files: { read: (path: string) => AsyncIterable<Uint8Array> },
  path: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}
