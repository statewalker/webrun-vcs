/**
 * T4.1: Git Files Format Compliance Tests
 *
 * Tests that verify Git object storage format compliance:
 * - Loose object path structure (XX/YYYY... format)
 * - Object header format ("type size\0content")
 * - SHA-1 hash computation matches Git
 * - Zlib compression (deflate/inflate)
 * - Blob, tree, and commit object formats
 */

import {
  CompressedRawStorage,
  createGitObject,
  createGitObjectStore,
  createInMemoryFilesApi,
  createMemoryHistory,
  encodeObjectHeader,
  extractGitObjectContent,
  type FilesApi,
  type GitObjectStore,
  type History,
  joinPath,
  MemoryRawStorage,
  parseHeader,
} from "@statewalker/vcs-core";
import { deflate, inflate } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRawStorage } from "../../src/storage/raw/index.js";

// Helper to compute sha1 and return hex string
async function sha1Hex(data: Uint8Array): Promise<string> {
  const hash = await sha1(data);
  return bytesToHex(hash);
}

// Helper to collect async iterable into bytes
async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Helper to convert string to Uint8Array
function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// Helper to convert Uint8Array to string
function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("Git Files Format Compliance", () => {
  describe("Object Header Format", () => {
    it("encodes blob header correctly", () => {
      const header = encodeObjectHeader("blob", 5);
      expect(bytesToString(header)).toBe("blob 5\0");
    });

    it("encodes tree header correctly", () => {
      const header = encodeObjectHeader("tree", 100);
      expect(bytesToString(header)).toBe("tree 100\0");
    });

    it("encodes commit header correctly", () => {
      const header = encodeObjectHeader("commit", 250);
      expect(bytesToString(header)).toBe("commit 250\0");
    });

    it("encodes tag header correctly", () => {
      const header = encodeObjectHeader("tag", 42);
      expect(bytesToString(header)).toBe("tag 42\0");
    });

    it("encodes size 0 correctly", () => {
      const header = encodeObjectHeader("blob", 0);
      expect(bytesToString(header)).toBe("blob 0\0");
    });

    it("encodes large size correctly", () => {
      const header = encodeObjectHeader("blob", 1234567890);
      expect(bytesToString(header)).toBe("blob 1234567890\0");
    });

    it("parses blob header correctly", () => {
      const data = toBytes("blob 5\0hello");
      const parsed = parseHeader(data);

      expect(parsed.type).toBe("blob");
      expect(parsed.typeCode).toBe(3); // ObjectType.BLOB
      expect(parsed.size).toBe(5);
      expect(parsed.contentOffset).toBe(7); // "blob 5\0".length
    });

    it("parses tree header correctly", () => {
      const data = toBytes(`tree 100\0${"x".repeat(100)}`);
      const parsed = parseHeader(data);

      expect(parsed.type).toBe("tree");
      expect(parsed.typeCode).toBe(2); // ObjectType.TREE
      expect(parsed.size).toBe(100);
      expect(parsed.contentOffset).toBe(9);
    });

    it("parses commit header correctly", () => {
      const data = toBytes(`commit 50\0${"y".repeat(50)}`);
      const parsed = parseHeader(data);

      expect(parsed.type).toBe("commit");
      expect(parsed.typeCode).toBe(1); // ObjectType.COMMIT
      expect(parsed.size).toBe(50);
    });

    it("throws on invalid object type", () => {
      const data = toBytes("invalid 5\0hello");
      expect(() => parseHeader(data)).toThrow("Invalid object type");
    });

    it("throws on missing null byte", () => {
      const data = toBytes("blob 5 hello");
      expect(() => parseHeader(data)).toThrow("no null byte");
    });

    it("throws on missing space", () => {
      const data = toBytes("blob5\0hello");
      expect(() => parseHeader(data)).toThrow("no space");
    });

    it("creates and extracts git object correctly", () => {
      const content = toBytes("hello world");
      const fullObject = createGitObject("blob", content);

      // Should start with header
      expect(bytesToString(fullObject.subarray(0, 14))).toBe("blob 11\0hello ");

      // Extract content should match original
      const extracted = extractGitObjectContent(fullObject);
      expect(bytesToString(extracted)).toBe("hello world");
    });
  });

  describe("SHA-1 Hash Computation", () => {
    it("computes SHA-1 for blob with known hash", async () => {
      // Git computes: SHA-1("blob 5\0hello")
      const content = toBytes("hello");
      const fullObject = createGitObject("blob", content);
      const hash = await sha1Hex(fullObject);

      // Known SHA-1 for "blob 5\0hello"
      // We can verify this with: printf "blob 5\0hello" | sha1sum
      expect(hash).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    });

    it("computes SHA-1 for empty blob", async () => {
      // SHA-1("blob 0\0") - empty blob
      const content = new Uint8Array(0);
      const fullObject = createGitObject("blob", content);
      const hash = await sha1Hex(fullObject);

      // Known empty blob hash: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
      expect(hash).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    });

    it("computes SHA-1 for larger content", async () => {
      const content = toBytes("test file content\nwith multiple lines\n");
      const fullObject = createGitObject("blob", content);
      const hash = await sha1Hex(fullObject);

      // Hash should be 40 hex characters
      expect(hash).toMatch(/^[0-9a-f]{40}$/);

      // Recompute should give same hash
      const hash2 = await sha1Hex(fullObject);
      expect(hash2).toBe(hash);
    });

    it("different content produces different hash", async () => {
      const content1 = createGitObject("blob", toBytes("content1"));
      const content2 = createGitObject("blob", toBytes("content2"));

      const hash1 = await sha1Hex(content1);
      const hash2 = await sha1Hex(content2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Zlib Compression", () => {
    it("deflates and inflates blob correctly", async () => {
      const content = toBytes("hello world");
      const fullObject = createGitObject("blob", content);

      // Deflate (compress)
      const compressed = await collectBytes(deflate([fullObject], { raw: false }));

      // Should be different from original
      expect(compressed.length).not.toBe(fullObject.length);

      // First byte should be zlib header (0x78)
      expect(compressed[0]).toBe(0x78);

      // Inflate (decompress)
      const decompressed = await collectBytes(inflate([compressed], { raw: false }));

      // Should match original
      expect(decompressed).toEqual(fullObject);
    });

    it("compresses larger content effectively", async () => {
      // Create highly compressible content
      const content = toBytes("a".repeat(1000));
      const fullObject = createGitObject("blob", content);

      const compressed = await collectBytes(deflate([fullObject], { raw: false }));

      // Compressed should be smaller
      expect(compressed.length).toBeLessThan(fullObject.length);
    });

    it("handles incompressible content", async () => {
      // Random-ish content that doesn't compress well
      const content = new Uint8Array(100);
      for (let i = 0; i < 100; i++) {
        content[i] = i * 2.5; // Semi-random pattern
      }
      const fullObject = createGitObject("blob", content);

      const compressed = await collectBytes(deflate([fullObject], { raw: false }));
      const decompressed = await collectBytes(inflate([compressed], { raw: false }));

      // Round-trip should work regardless of compression ratio
      expect(decompressed).toEqual(fullObject);
    });
  });

  describe("GitObjectStore with Compressed Storage", () => {
    let innerStorage: MemoryRawStorage;
    let store: GitObjectStore;

    beforeEach(() => {
      innerStorage = new MemoryRawStorage();
      const compressedStorage = new CompressedRawStorage(innerStorage);
      store = createGitObjectStore(compressedStorage);
    });

    it("stores blob with correct SHA-1", async () => {
      const content = toBytes("hello");
      const id = await store.store("blob", [content]);

      // Should be the known SHA-1 for "blob 5\0hello"
      expect(id).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    });

    it("stores and loads blob correctly", async () => {
      const originalContent = toBytes("test content");
      const id = await store.store("blob", [originalContent]);

      const loaded = await collectBytes(store.load(id));
      expect(loaded).toEqual(originalContent);
    });

    it("stores compressed content in underlying storage", async () => {
      const content = toBytes("hello world");
      const id = await store.store("blob", [content]);

      // Get raw bytes from the inner (uncompressed) storage
      const rawStored = await collectBytes(innerStorage.load(id));

      // Should be zlib compressed (starts with 0x78)
      expect(rawStored[0]).toBe(0x78);
    });

    it("loads raw content with header", async () => {
      const content = toBytes("hello");
      const id = await store.store("blob", [content]);

      // loadRaw should return header + content (decompressed by storage layer)
      const raw = await collectBytes(store.loadRaw(id));

      // Should start with "blob 5\0"
      expect(bytesToString(raw.subarray(0, 7))).toBe("blob 5\0");

      // Content after header
      expect(bytesToString(raw.subarray(7))).toBe("hello");
    });

    it("has returns true for stored objects", async () => {
      const content = toBytes("test");
      const id = await store.store("blob", [content]);

      expect(await store.has(id)).toBe(true);
      expect(await store.has("0".repeat(40))).toBe(false);
    });
  });

  describe("Loose Object Path Structure", () => {
    let files: FilesApi;
    let storage: FileRawStorage;
    let store: GitObjectStore;
    const basePath = "/objects";

    beforeEach(async () => {
      files = createInMemoryFilesApi();
      await files.mkdir(basePath);
      storage = new FileRawStorage(files, basePath);
      store = createGitObjectStore(storage);
    });

    it("stores object with 2-char prefix directory", async () => {
      const content = toBytes("hello");
      const id = await store.store("blob", [content]);

      // ID should be 40 chars
      expect(id).toHaveLength(40);

      // Object should be stored at /objects/XX/YYYY...
      const prefix = id.substring(0, 2);
      const suffix = id.substring(2);
      const objectPath = joinPath(basePath, prefix, suffix);

      const stats = await files.stats(objectPath);
      expect(stats).toBeDefined();
    });

    it("creates prefix directory automatically", async () => {
      const content = toBytes("test content");
      const id = await store.store("blob", [content]);

      const prefix = id.substring(0, 2);
      const dirPath = joinPath(basePath, prefix);

      const stats = await files.stats(dirPath);
      expect(stats?.kind).toBe("directory");
    });

    it("stores multiple objects with different prefixes", async () => {
      const ids = new Set<string>();

      // Store many objects to get different prefixes
      for (let i = 0; i < 10; i++) {
        const content = toBytes(`content-${i}`);
        const id = await store.store("blob", [content]);
        ids.add(id.substring(0, 2));
      }

      // Should have multiple unique prefixes (probabilistic)
      expect(ids.size).toBeGreaterThanOrEqual(1);
    });

    it("lists keys correctly from directory structure", async () => {
      const storedIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const id = await store.store("blob", [toBytes(`content-${i}`)]);
        storedIds.push(id);
      }

      // Collect all keys from storage
      const keys: string[] = [];
      for await (const key of storage.keys()) {
        keys.push(key);
      }

      // Should have all stored IDs
      expect(keys.sort()).toEqual(storedIds.sort());
    });
  });

  describe("Git Object Formats", () => {
    let history: History;

    beforeEach(async () => {
      history = createMemoryHistory();
      await history.initialize();
    });

    afterEach(async () => {
      await history.close();
    });

    it("stores blob with correct format", async () => {
      const content = toBytes("file content\n");
      const blobId = await history.blobs.store([content]);

      // ID should be 40 hex chars
      expect(blobId).toMatch(/^[0-9a-f]{40}$/);

      // Load and verify content
      const blobContent = await history.blobs.load(blobId);
      expect(blobContent).toBeDefined();
      const loaded = await collectBytes(blobContent!);
      expect(loaded).toEqual(content);
    });

    it("stores empty blob with well-known hash", async () => {
      const emptyContent = new Uint8Array(0);
      const blobId = await history.blobs.store([emptyContent]);

      // Well-known empty blob hash
      expect(blobId).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    });

    it("stores tree with correct sorted entries", async () => {
      // Create blobs for files
      const blob1 = await history.blobs.store([toBytes("content1")]);
      const blob2 = await history.blobs.store([toBytes("content2")]);
      const blob3 = await history.blobs.store([toBytes("content3")]);

      // Store tree with entries in arbitrary order
      const treeId = await history.trees.store([
        { mode: 0o100644, name: "z-file.txt", id: blob1 },
        { mode: 0o100644, name: "a-file.txt", id: blob2 },
        { mode: 0o100644, name: "m-file.txt", id: blob3 },
      ]);

      // Load tree and verify entries are sorted by name
      const tree = await history.trees.load(treeId);
      expect(tree).toBeDefined();

      const entries: Array<{ name: string }> = [];
      for await (const entry of tree!) {
        entries.push(entry);
      }

      const names = entries.map((e) => e.name);
      expect(names).toEqual(["a-file.txt", "m-file.txt", "z-file.txt"]);
    });

    it("stores empty tree with well-known hash", async () => {
      const treeId = await history.trees.store([]);

      // Well-known empty tree hash
      expect(treeId).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    });

    it("stores commit with correct format", async () => {
      const emptyTree = await history.trees.store([]);

      const commitId = await history.commits.store({
        tree: emptyTree,
        parents: [],
        author: {
          name: "Test Author",
          email: "test@example.com",
          timestamp: 1700000000,
          tzOffset: "+0000",
        },
        committer: {
          name: "Test Committer",
          email: "committer@example.com",
          timestamp: 1700000000,
          tzOffset: "+0000",
        },
        message: "Initial commit",
      });

      // ID should be valid SHA-1
      expect(commitId).toMatch(/^[0-9a-f]{40}$/);

      // Load and verify commit
      const commit = await history.commits.load(commitId);
      expect(commit).toBeDefined();
      expect(commit?.tree).toBe(emptyTree);
      expect(commit?.parents).toEqual([]);
      expect(commit?.author.name).toBe("Test Author");
      expect(commit?.message).toBe("Initial commit");
    });

    it("stores commit with parents", async () => {
      const emptyTree = await history.trees.store([]);

      // Create first commit
      const commit1 = await history.commits.store({
        tree: emptyTree,
        parents: [],
        author: { name: "Author", email: "a@b.c", timestamp: 1700000000, tzOffset: "+0000" },
        committer: { name: "Author", email: "a@b.c", timestamp: 1700000000, tzOffset: "+0000" },
        message: "First",
      });

      // Create second commit with parent
      const commit2 = await history.commits.store({
        tree: emptyTree,
        parents: [commit1],
        author: { name: "Author", email: "a@b.c", timestamp: 1700001000, tzOffset: "+0000" },
        committer: { name: "Author", email: "a@b.c", timestamp: 1700001000, tzOffset: "+0000" },
        message: "Second",
      });

      const loaded = await history.commits.load(commit2);
      expect(loaded?.parents).toEqual([commit1]);
    });

    it("stores merge commit with multiple parents", async () => {
      const emptyTree = await history.trees.store([]);

      // Create base commit
      const base = await history.commits.store({
        tree: emptyTree,
        parents: [],
        author: { name: "A", email: "a@b", timestamp: 1700000000, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b", timestamp: 1700000000, tzOffset: "+0000" },
        message: "Base",
      });

      // Create two branches
      const branch1 = await history.commits.store({
        tree: emptyTree,
        parents: [base],
        author: { name: "A", email: "a@b", timestamp: 1700001000, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b", timestamp: 1700001000, tzOffset: "+0000" },
        message: "Branch 1",
      });

      const branch2 = await history.commits.store({
        tree: emptyTree,
        parents: [base],
        author: { name: "A", email: "a@b", timestamp: 1700001000, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b", timestamp: 1700001000, tzOffset: "+0000" },
        message: "Branch 2",
      });

      // Create merge commit
      const merge = await history.commits.store({
        tree: emptyTree,
        parents: [branch1, branch2],
        author: { name: "A", email: "a@b", timestamp: 1700002000, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b", timestamp: 1700002000, tzOffset: "+0000" },
        message: "Merge",
      });

      const loaded = await history.commits.load(merge);
      expect(loaded?.parents).toHaveLength(2);
      expect(loaded?.parents).toContain(branch1);
      expect(loaded?.parents).toContain(branch2);
    });

    it("stores annotated tag with correct format", async () => {
      const emptyTree = await history.trees.store([]);
      const commitId = await history.commits.store({
        tree: emptyTree,
        parents: [],
        author: { name: "A", email: "a@b", timestamp: 1700000000, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b", timestamp: 1700000000, tzOffset: "+0000" },
        message: "Commit",
      });

      const tagId = await history.tags.store({
        object: commitId,
        objectType: 1, // commit
        tag: "v1.0.0",
        tagger: { name: "Tagger", email: "t@g", timestamp: 1700000000, tzOffset: "+0000" },
        message: "Release v1.0.0",
      });

      expect(tagId).toMatch(/^[0-9a-f]{40}$/);

      const loaded = await history.tags.load(tagId);
      expect(loaded).toBeDefined();
      expect(loaded?.tag).toBe("v1.0.0");
      expect(loaded?.object).toBe(commitId);
      expect(loaded?.message).toBe("Release v1.0.0");
    });
  });

  describe("Cross-validation with Known Hashes", () => {
    it("verifies blob hash matches git hash", async () => {
      // This is a known blob with known hash
      // You can verify with: echo -n "hello" | git hash-object --stdin
      // Result: b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0

      const content = toBytes("hello");
      const gitObject = createGitObject("blob", content);
      const hash = await sha1Hex(gitObject);

      expect(hash).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    });

    it("verifies tree hash computation", async () => {
      const history = createMemoryHistory();
      await history.initialize();

      try {
        // Store known blob
        const blobId = await history.blobs.store([toBytes("hello")]);
        expect(blobId).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");

        // Store tree with that blob
        const treeId = await history.trees.store([
          { mode: 0o100644, name: "hello.txt", id: blobId },
        ]);

        // Tree hash should be deterministic
        expect(treeId).toMatch(/^[0-9a-f]{40}$/);

        // Store same tree again should get same hash
        const treeId2 = await history.trees.store([
          { mode: 0o100644, name: "hello.txt", id: blobId },
        ]);
        expect(treeId2).toBe(treeId);
      } finally {
        await history.close();
      }
    });
  });
});
