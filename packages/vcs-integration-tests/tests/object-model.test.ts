/**
 * Object Model Integration Tests
 *
 * Tests from apps/examples/03-object-model (5 steps):
 * Step 01: Blob Storage - content-addressable storage, SHA-1 verification
 * Step 02: Tree Structure - nested trees, file modes
 * Step 03: Commit Anatomy - tree linkage, parent chain, author/committer
 * Step 04: Tags - lightweight vs annotated, metadata
 * Step 05: Deduplication - same content = same hash, storage efficiency
 */

import { FileMode, ObjectType } from "@statewalker/vcs-core";
import { afterEach, describe, expect, it } from "vitest";

import { backends, testAuthor, toArray } from "./test-helper.js";

describe.each(backends)("Object Model ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Blob Storage
  describe("Step 1: Blob Storage", () => {
    it("should store content and return SHA-1 hash", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const content = encoder.encode("Hello, World! This is my first blob.");
      const blobId = await repository.blobs.store([content]);

      // SHA-1 produces 40 hex characters
      expect(blobId).toMatch(/^[0-9a-f]{40}$/);
    });

    it("should return consistent IDs for same content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const content = encoder.encode("Same content");

      const id1 = await repository.blobs.store([content]);
      const id2 = await repository.blobs.store([content]);

      expect(id1).toBe(id2);
    });

    it("should retrieve stored content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const originalContent = "Hello, World!";
      const blobId = await repository.blobs.store([encoder.encode(originalContent)]);

      const chunks: Uint8Array[] = [];
      const stream = await repository.blobs.load(blobId);
      if (!stream) throw new Error("Blob not found");
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const retrieved = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        retrieved.set(chunk, offset);
        offset += chunk.length;
      }

      expect(new TextDecoder().decode(retrieved)).toBe(originalContent);
    });
  });

  // Step 2: Tree Structure
  describe("Step 2: Tree Structure", () => {
    it("should create tree with file entries", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const readmeId = await repository.blobs.store([encoder.encode("# README")]);
      const indexId = await repository.blobs.store([encoder.encode("console.log('hello');")]);

      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
        { mode: FileMode.REGULAR_FILE, name: "index.js", id: indexId },
      ]);

      expect(treeId).toMatch(/^[0-9a-f]{40}$/);

      const entries = await toArray(repository.trees.load(treeId));
      expect(entries).toHaveLength(2);

      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["README.md", "index.js"]);
    });

    it("should support nested trees (directories)", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const indexId = await repository.blobs.store([encoder.encode("// index")]);
      const utilsId = await repository.blobs.store([encoder.encode("// utils")]);

      // Create src/ subtree
      const srcTreeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "index.js", id: indexId },
        { mode: FileMode.REGULAR_FILE, name: "utils.js", id: utilsId },
      ]);

      // Create root tree with src/ directory
      const rootTreeId = await repository.trees.store([
        { mode: FileMode.TREE, name: "src", id: srcTreeId },
      ]);

      const rootEntries = await toArray(repository.trees.load(rootTreeId));
      expect(rootEntries).toHaveLength(1);
      expect(rootEntries[0].mode).toBe(FileMode.TREE);
      expect(rootEntries[0].name).toBe("src");

      // Verify subtree
      const srcEntries = await toArray(repository.trees.load(srcTreeId));
      expect(srcEntries).toHaveLength(2);
    });

    it("should support different file modes", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const fileId = await repository.blobs.store([encoder.encode("content")]);
      const execId = await repository.blobs.store([encoder.encode("#!/bin/bash")]);
      const linkId = await repository.blobs.store([encoder.encode("target")]);

      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "file.txt", id: fileId },
        { mode: FileMode.EXECUTABLE_FILE, name: "script.sh", id: execId },
        { mode: FileMode.SYMLINK, name: "link", id: linkId },
      ]);

      const entries = await toArray(repository.trees.load(treeId));

      const fileEntry = entries.find((e) => e.name === "file.txt");
      const execEntry = entries.find((e) => e.name === "script.sh");
      const linkEntry = entries.find((e) => e.name === "link");

      expect(fileEntry?.mode).toBe(FileMode.REGULAR_FILE);
      expect(execEntry?.mode).toBe(FileMode.EXECUTABLE_FILE);
      expect(linkEntry?.mode).toBe(FileMode.SYMLINK);
    });

    it("should look up specific tree entries", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const readmeId = await repository.blobs.store([encoder.encode("# README")]);

      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
      ]);

      const entry = await repository.trees.getEntry(treeId, "README.md");
      expect(entry).toBeDefined();
      expect(entry?.id).toBe(readmeId);
      expect(entry?.mode).toBe(FileMode.REGULAR_FILE);

      const missing = await repository.trees.getEntry(treeId, "MISSING.md");
      expect(missing).toBeUndefined();
    });
  });

  // Step 3: Commit Anatomy
  describe("Step 3: Commit Anatomy", () => {
    it("should create commit with tree and metadata", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const blobId = await repository.blobs.store([encoder.encode("# Project")]);
      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
      ]);

      const now = Math.floor(Date.now() / 1000);
      const author = {
        name: "Alice Developer",
        email: "alice@example.com",
        timestamp: now,
        tzOffset: "-0500",
      };

      const commitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author,
        committer: author,
        message: "Initial commit",
      });

      expect(commitId).toMatch(/^[0-9a-f]{40}$/);

      const commit = await repository.commits.load(commitId);
      expect(commit).toBeDefined();
      if (!commit) throw new Error("Commit not found");
      expect(commit.tree).toBe(treeId);
      expect(commit.parents).toHaveLength(0);
      expect(commit.author.name).toBe("Alice Developer");
      expect(commit.message).toBe("Initial commit");
    });

    it("should create commit with parent chain", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const blobId = await repository.blobs.store([encoder.encode("content")]);
      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blobId },
      ]);

      const commit1Id = await repository.commits.store({
        tree: treeId,
        parents: [],
        author: testAuthor(),
        committer: testAuthor(),
        message: "First",
      });

      const commit2Id = await repository.commits.store({
        tree: treeId,
        parents: [commit1Id],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Second",
      });

      const commit2 = await repository.commits.load(commit2Id);
      expect(commit2).toBeDefined();
      if (!commit2) throw new Error("Commit not found");
      expect(commit2.parents).toEqual([commit1Id]);
    });

    it("should support different author and committer", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const treeId = await repository.trees.store([]);
      const now = Math.floor(Date.now() / 1000);

      const author = {
        name: "Alice",
        email: "alice@example.com",
        timestamp: now,
        tzOffset: "+0000",
      };

      const committer = {
        name: "Bob",
        email: "bob@example.com",
        timestamp: now + 100,
        tzOffset: "-0500",
      };

      const commitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author,
        committer,
        message: "Test",
      });

      const commit = await repository.commits.load(commitId);
      expect(commit).toBeDefined();
      if (!commit) throw new Error("Commit not found");
      expect(commit.author.name).toBe("Alice");
      expect(commit.committer.name).toBe("Bob");
    });
  });

  // Step 4: Tags
  describe("Step 4: Tags", () => {
    it("should create lightweight tags (refs)", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const treeId = await repository.trees.store([]);
      const commitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Release",
      });

      // Lightweight tag is just a ref
      await repository.refs.set("refs/tags/v1.0.0", commitId);

      const tagRef = await repository.refs.resolve("refs/tags/v1.0.0");
      expect(tagRef?.objectId).toBe(commitId);
    });

    it("should create annotated tags with metadata", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const treeId = await repository.trees.store([]);
      const commitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Release",
      });

      const now = Math.floor(Date.now() / 1000);
      const tagId = await repository.tags.store({
        object: commitId,
        objectType: ObjectType.COMMIT,
        tag: "v2.0.0",
        tagger: {
          name: "Release Manager",
          email: "release@example.com",
          timestamp: now,
          tzOffset: "+0000",
        },
        message: "Version 2.0.0 release",
      });

      expect(tagId).toMatch(/^[0-9a-f]{40}$/);

      const tag = await repository.tags.load(tagId);
      expect(tag).toBeDefined();
      if (!tag) throw new Error("Tag not found");
      expect(tag.object).toBe(commitId);
      expect(tag.objectType).toBe(ObjectType.COMMIT);
      expect(tag.tag).toBe("v2.0.0");
      expect(tag.tagger?.name).toBe("Release Manager");
      expect(tag.message).toBe("Version 2.0.0 release");
    });
  });

  // Step 5: Deduplication
  describe("Step 5: Deduplication", () => {
    it("should deduplicate identical content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const content = encoder.encode("Same content repeated multiple times");

      const id1 = await repository.blobs.store([content]);
      const id2 = await repository.blobs.store([content]);
      const id3 = await repository.blobs.store([content]);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it("should produce different IDs for different content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      const id1 = await repository.blobs.store([encoder.encode("Content A")]);
      const id2 = await repository.blobs.store([encoder.encode("Content B")]);
      const id3 = await repository.blobs.store([encoder.encode("Content C")]);

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it("should efficiently store multiple files with shared content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const sharedContent = encoder.encode("This content is shared");
      const uniqueContent1 = encoder.encode("Unique content 1");
      const uniqueContent2 = encoder.encode("Unique content 2");

      const sharedId = await repository.blobs.store([sharedContent]);
      const file1Id = await repository.blobs.store([sharedContent]); // Same as shared
      const file2Id = await repository.blobs.store([uniqueContent1]);
      const file3Id = await repository.blobs.store([sharedContent]); // Same as shared
      const file4Id = await repository.blobs.store([uniqueContent2]);

      // All shared content produces same ID
      expect(file1Id).toBe(sharedId);
      expect(file3Id).toBe(sharedId);

      // Unique content produces unique IDs
      expect(file2Id).not.toBe(sharedId);
      expect(file4Id).not.toBe(sharedId);
      expect(file2Id).not.toBe(file4Id);
    });

    it("should deduplicate trees with identical structure", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const blobId = await repository.blobs.store([encoder.encode("content")]);

      // Create same tree structure twice
      const tree1Id = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blobId },
      ]);

      const tree2Id = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blobId },
      ]);

      expect(tree1Id).toBe(tree2Id);
    });
  });
});
