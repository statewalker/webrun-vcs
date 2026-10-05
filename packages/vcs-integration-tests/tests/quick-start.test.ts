/**
 * Quick Start Integration Tests
 *
 * Tests from apps/examples/01-quick-start:
 * 1. Repository initialization - createGitRepository with in-memory files
 * 2. Blob storage - store content, same ID for same content
 * 3. Tree creation - storeTree with file entry
 * 4. Commit creation - storeCommit with tree, author, message
 * 5. Ref update - refs.set() updates branch
 * 6. History walking - walkAncestry returns commits in order
 */

import { FileMode } from "@statewalker/vcs-core";
import { afterEach, describe, expect, it } from "vitest";

import { backends, testAuthor, toArray } from "./test-helper.js";

describe.each(backends)("Quick Start ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("should initialize repository and store HEAD", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    // Initialize refs
    const emptyTreeId = await repository.trees.store([]);
    const initialCommit = {
      tree: emptyTreeId,
      parents: [],
      author: testAuthor(),
      committer: testAuthor(),
      message: "Initial commit",
    };
    const commitId = await repository.commits.store(initialCommit);

    // Set up refs
    await repository.refs.set("refs/heads/main", commitId);
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");

    // Verify HEAD resolution
    const headRef = await repository.refs.resolve("HEAD");
    expect(headRef?.objectId).toBe(commitId);
  });

  it("should store blob content and return consistent IDs", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    const encoder = new TextEncoder();
    const content = encoder.encode("# My Project\n\nWelcome!");

    // Store the same content twice
    const blobId1 = await repository.blobs.store([content]);
    const blobId2 = await repository.blobs.store([content]);

    // Same content should produce same ID (content-addressable)
    expect(blobId1).toBe(blobId2);
    expect(blobId1).toMatch(/^[0-9a-f]{40}$/);

    // Load and verify content
    const chunks: Uint8Array[] = [];
    const stream = await repository.blobs.load(blobId1);
    if (!stream) throw new Error("Blob not found");
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const loaded = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      loaded.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(loaded)).toBe("# My Project\n\nWelcome!");
  });

  it("should create tree with file entries", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    const encoder = new TextEncoder();
    const blobId = await repository.blobs.store([encoder.encode("README content")]);

    const treeId = await repository.trees.store([
      { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
    ]);

    expect(treeId).toMatch(/^[0-9a-f]{40}$/);

    // Load and verify tree entries
    const entries = await toArray(repository.trees.load(treeId));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("README.md");
    expect(entries[0].id).toBe(blobId);
    expect(entries[0].mode).toBe(FileMode.REGULAR_FILE);
  });

  it("should create commit with tree, author, and message", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    const encoder = new TextEncoder();
    const blobId = await repository.blobs.store([encoder.encode("content")]);
    const treeId = await repository.trees.store([
      { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blobId },
    ]);

    const now = Math.floor(Date.now() / 1000);
    const commit = {
      tree: treeId,
      parents: [],
      author: {
        name: "Developer",
        email: "dev@example.com",
        timestamp: now,
        tzOffset: "+0000",
      },
      committer: {
        name: "Developer",
        email: "dev@example.com",
        timestamp: now,
        tzOffset: "+0000",
      },
      message: "Initial commit",
    };

    const commitId = await repository.commits.store(commit);
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);

    // Load and verify commit
    const loaded = await repository.commits.load(commitId);
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("Commit not found");
    expect(loaded.tree).toBe(treeId);
    expect(loaded.parents).toEqual([]);
    expect(loaded.author.name).toBe("Developer");
    expect(loaded.message).toBe("Initial commit");
  });

  it("should update branch reference", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    const emptyTreeId = await repository.trees.store([]);
    const commit1 = await repository.commits.store({
      tree: emptyTreeId,
      parents: [],
      author: testAuthor(),
      committer: testAuthor(),
      message: "First commit",
    });

    await repository.refs.set("refs/heads/main", commit1);

    // Verify ref points to commit
    const ref = await repository.refs.get("refs/heads/main");
    expect(ref).toBeDefined();
    expect(ref && "objectId" in ref && ref.objectId).toBe(commit1);

    // Create second commit and update ref
    const commit2 = await repository.commits.store({
      tree: emptyTreeId,
      parents: [commit1],
      author: testAuthor(),
      committer: testAuthor(),
      message: "Second commit",
    });

    await repository.refs.set("refs/heads/main", commit2);

    const updatedRef = await repository.refs.get("refs/heads/main");
    expect(updatedRef && "objectId" in updatedRef && updatedRef.objectId).toBe(commit2);
  });

  it("should walk commit ancestry in order", async () => {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { repository } = ctx;

    const emptyTreeId = await repository.trees.store([]);

    // Create chain of 3 commits
    const commit1 = await repository.commits.store({
      tree: emptyTreeId,
      parents: [],
      author: testAuthor(),
      committer: testAuthor(),
      message: "First",
    });

    const commit2 = await repository.commits.store({
      tree: emptyTreeId,
      parents: [commit1],
      author: testAuthor(),
      committer: testAuthor(),
      message: "Second",
    });

    const commit3 = await repository.commits.store({
      tree: emptyTreeId,
      parents: [commit2],
      author: testAuthor(),
      committer: testAuthor(),
      message: "Third",
    });

    // Walk ancestry from commit3
    const ancestryIds = await toArray(repository.commits.walkAncestry(commit3));

    // Should return commits in reverse chronological order
    expect(ancestryIds).toEqual([commit3, commit2, commit1]);
  });
});
