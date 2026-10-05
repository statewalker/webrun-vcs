/**
 * Internal Storage Integration Tests
 *
 * Tests from apps/examples/06-internal-storage (5 steps):
 * Step 01: Loose Objects - object storage paths, content verification
 * Step 02: Pack Files - pack creation, reading
 * Step 03: Garbage Collection - repacking, loose cleanup
 * Step 04: Direct Storage - content-addressable without workflow
 * Step 05: Delta Internals - delta ranges, apply delta
 *
 * Note: Some low-level storage operations (file-system based loose objects,
 * pack file creation) are not directly testable through the storage interface.
 * These tests focus on the observable behavior through the storage abstraction.
 */

import { FileMode } from "@statewalker/vcs-core";
import { afterEach, describe, expect, it } from "vitest";

import { backends, defined, testAuthor, toArray } from "./test-helper.js";

describe.each(backends)("Internal Storage ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Loose Objects (object storage and retrieval)
  describe("Step 1: Object Storage", () => {
    it("should store and retrieve blobs correctly", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const content = encoder.encode("Hello World! This is test content.");

      const blobId = await repository.blobs.store([content]);

      // Retrieve and verify
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

      expect(new TextDecoder().decode(retrieved)).toBe("Hello World! This is test content.");
    });

    it("should produce consistent SHA-1 hashes", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const content = encoder.encode("Same content");

      // Store same content multiple times
      const id1 = await repository.blobs.store([content]);
      const id2 = await repository.blobs.store([content]);
      const id3 = await repository.blobs.store([content]);

      // All should produce same SHA-1
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
      expect(id1).toMatch(/^[0-9a-f]{40}$/);
    });

    it("should store trees with correct structure", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const readmeId = await repository.blobs.store([encoder.encode("# README")]);
      const configId = await repository.blobs.store([encoder.encode("version = 1")]);

      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
        { mode: FileMode.REGULAR_FILE, name: "config.txt", id: configId },
      ]);

      // Verify tree contents
      const entries = await toArray(repository.trees.load(treeId));
      expect(entries.length).toBe(2);

      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["README.md", "config.txt"]);
    });

    it("should store commits with all metadata", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();
      const blobId = await repository.blobs.store([encoder.encode("content")]);
      const treeId = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blobId },
      ]);

      const author = testAuthor("Alice", "alice@example.com");
      const commitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author,
        committer: author,
        message: "Initial commit\n\nWith detailed description.",
      });

      const commit = await repository.commits.load(commitId);
      expect(commit).toBeDefined();
      if (!commit) throw new Error("Commit not found");
      expect(commit.tree).toBe(treeId);
      expect(commit.author.name).toBe("Alice");
      expect(commit.message).toContain("Initial commit");
    });
  });

  // Step 2 & 3: Pack Files and GC (storage efficiency)
  describe("Step 2 & 3: Storage Efficiency", () => {
    it("should efficiently store many objects", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      // Store many blobs
      const blobIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const content = encoder.encode(`File content ${i}\nWith some text`);
        const id = await repository.blobs.store([content]);
        blobIds.push(id);
      }

      // All should be retrievable
      for (const id of blobIds) {
        const chunks: Uint8Array[] = [];
        const stream = await repository.blobs.load(id);
        if (!stream) throw new Error("Blob not found");
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThan(0);
      }
    });

    it("should handle similar content efficiently via deduplication", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      // Create many trees pointing to same blob
      const sharedBlobId = await repository.blobs.store([encoder.encode("Shared content")]);

      const treeIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const treeId = await repository.trees.store([
          { mode: FileMode.REGULAR_FILE, name: `file${i}.txt`, id: sharedBlobId },
        ]);
        treeIds.push(treeId);
      }

      // Each tree should be unique (different names)
      const uniqueTrees = new Set(treeIds);
      expect(uniqueTrees.size).toBe(10);

      // But all point to same blob
      for (const treeId of treeIds) {
        const entries = await toArray(repository.trees.load(treeId));
        expect(entries[0].id).toBe(sharedBlobId);
      }
    });
  });

  // Step 4: Direct Storage (content-addressable operations)
  describe("Step 4: Direct Storage", () => {
    it("should allow direct object manipulation without workflow", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      // Directly store objects without using Git commands
      const blob1 = await repository.blobs.store([encoder.encode("Direct content 1")]);
      const blob2 = await repository.blobs.store([encoder.encode("Direct content 2")]);

      // Create tree directly
      const tree = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "a.txt", id: blob1 },
        { mode: FileMode.REGULAR_FILE, name: "b.txt", id: blob2 },
      ]);

      // Create commit directly
      const commit = await repository.commits.store({
        tree,
        parents: [],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Direct commit",
      });

      // Set ref directly
      await repository.refs.set("refs/heads/direct", commit);

      // Verify
      const ref = await repository.refs.resolve("refs/heads/direct");
      expect(ref?.objectId).toBe(commit);

      const loadedCommit = await repository.commits.load(commit);
      expect(loadedCommit).toBeDefined();
      if (!loadedCommit) throw new Error("Commit not found");
      expect(loadedCommit.tree).toBe(tree);
    });

    it("should support building complex object graphs", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      // Build a nested tree structure
      const file1 = await repository.blobs.store([encoder.encode("File 1")]);
      const file2 = await repository.blobs.store([encoder.encode("File 2")]);
      const file3 = await repository.blobs.store([encoder.encode("File 3")]);

      // Create subdirectory tree
      const subTree = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "nested1.txt", id: file2 },
        { mode: FileMode.REGULAR_FILE, name: "nested2.txt", id: file3 },
      ]);

      // Create root tree with subdirectory
      const rootTree = await repository.trees.store([
        { mode: FileMode.REGULAR_FILE, name: "root.txt", id: file1 },
        { mode: FileMode.TREE, name: "subdir", id: subTree },
      ]);

      // Verify structure
      const rootEntries = await toArray(repository.trees.load(rootTree));
      expect(rootEntries.length).toBe(2);

      const subdirEntry = rootEntries.find((e) => e.name === "subdir");
      expect(subdirEntry).toBeDefined();
      expect(subdirEntry?.mode).toBe(FileMode.TREE);

      const subEntries = await toArray(
        repository.trees.load(defined(subdirEntry, "subdirectory entry").id),
      );
      expect(subEntries.length).toBe(2);
    });
  });

  // Step 5: Delta Concepts (similar content handling)
  describe("Step 5: Delta Concepts", () => {
    it("should efficiently handle incrementally changing content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      const encoder = new TextEncoder();

      // Store base content
      const base = encoder.encode(
        "# Document\n\nThis is the original content.\nIt has multiple lines.\n",
      );
      const baseId = await repository.blobs.store([base]);

      // Store slightly modified content
      const modified = encoder.encode(
        "# Document\n\nThis is the modified content.\nIt has multiple lines.\nAnd a new line.\n",
      );
      const modifiedId = await repository.blobs.store([modified]);

      // Both should be stored (different content = different IDs)
      expect(baseId).not.toBe(modifiedId);

      // Both should be retrievable
      const chunks1: Uint8Array[] = [];
      const stream1 = await repository.blobs.load(baseId);
      if (!stream1) throw new Error("Blob not found");
      for await (const chunk of stream1) {
        chunks1.push(chunk);
      }
      expect(chunks1.length).toBeGreaterThan(0);

      const chunks2: Uint8Array[] = [];
      const stream2 = await repository.blobs.load(modifiedId);
      if (!stream2) throw new Error("Blob not found");
      for await (const chunk of stream2) {
        chunks2.push(chunk);
      }
      expect(chunks2.length).toBeGreaterThan(0);
    });

    it("should handle large content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      // Create larger content (simulate a code file)
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`// Line ${i}: This is line content for testing`);
      }
      const content = new TextEncoder().encode(lines.join("\n"));

      const blobId = await repository.blobs.store([content]);

      // Retrieve and verify size
      const chunks: Uint8Array[] = [];
      const stream = await repository.blobs.load(blobId);
      if (!stream) throw new Error("Blob not found");
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      expect(totalLength).toBe(content.length);
    });

    it("should handle binary-like content", async () => {
      const ctx = await factory();
      cleanup = ctx.cleanup;
      const { repository } = ctx;

      // Create content with various byte values
      const content = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        content[i] = i;
      }

      const blobId = await repository.blobs.store([content]);

      // Retrieve and verify
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

      expect(retrieved.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(retrieved[i]).toBe(i);
      }
    });
  });
});
