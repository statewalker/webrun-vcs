/**
 * Tests for storage adapter.
 *
 * Tests the adapter that converts storage implementations to RepositoryAccess interface.
 */

import type { ObjectTypeCode } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { createStorageAdapter, type MinimalStorage } from "../src/storage-adapter.js";

// Object type codes
const OBJ_COMMIT = 1 as ObjectTypeCode;
const OBJ_TREE = 2 as ObjectTypeCode;
const OBJ_BLOB = 3 as ObjectTypeCode;
const OBJ_TAG = 4 as ObjectTypeCode;

// Sample object IDs
const COMMIT_ID = "a".repeat(40);
const TREE_ID = "b".repeat(40);
const BLOB_ID = "c".repeat(40);

/**
 * Create a Git object with proper header.
 */
function createGitObject(type: string, content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const fullData = new Uint8Array(header.length + content.length);
  fullData.set(header, 0);
  fullData.set(content, header.length);
  return fullData;
}

/**
 * Create a mock storage implementation.
 */
function createMockStorage(options?: {
  refs?: Map<string, { objectId?: string; target?: string }>;
  objects?: Map<string, Uint8Array>;
  head?: { objectId?: string; target?: string } | null;
  commits?: Map<
    string,
    { tree: string; parents: string[]; author: unknown; committer: unknown; message: string }
  >;
  trees?: Map<string, Array<{ name: string; mode: number; id: string }>>;
}): MinimalStorage {
  const refs =
    options?.refs ??
    new Map([
      ["refs/heads/master", { objectId: COMMIT_ID }],
      ["HEAD", { target: "refs/heads/master" }],
    ]);
  const objects =
    options?.objects ??
    new Map([
      [COMMIT_ID, createGitObject("commit", new TextEncoder().encode(`tree ${TREE_ID}`))],
      [TREE_ID, createGitObject("tree", new Uint8Array(0))],
      [BLOB_ID, createGitObject("blob", new TextEncoder().encode("Hello, World!"))],
    ]);
  const head = options?.head ?? { target: "refs/heads/master" };
  const commits =
    options?.commits ??
    new Map([
      [
        COMMIT_ID,
        {
          tree: TREE_ID,
          parents: [],
          author: { name: "Test", email: "test@test.com", date: new Date() },
          committer: { name: "Test", email: "test@test.com", date: new Date() },
          message: "Test commit",
        },
      ],
    ]);
  const trees = options?.trees ?? new Map([[TREE_ID, []]]);

  return {
    refs: {
      async *list() {
        for (const [name, value] of refs) {
          if (name !== "HEAD" && value.objectId) {
            yield { name, objectId: value.objectId };
          }
        }
      },
      async get(name: string) {
        return refs.get(name) || null;
      },
      async set(name: string, objectId: string) {
        refs.set(name, { objectId });
      },
      async delete(name: string) {
        return refs.delete(name);
      },
    },
    rawStorage: {
      async has(id: string) {
        return objects.has(id);
      },
      async getSize(id: string) {
        const obj = objects.get(id);
        return obj ? obj.length : -1;
      },
      async *load(id: string) {
        const obj = objects.get(id);
        if (obj) {
          yield obj;
        }
      },
      async store(data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data) {
          chunks.push(chunk);
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        // Generate simple hash-like ID
        const id = Array.from(result.slice(0, 20))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .padEnd(40, "0");
        objects.set(id, result);
        return id;
      },
    },
    async getHead() {
      if (!head) return null;
      if (head.target) {
        const target = refs.get(head.target);
        return target?.objectId || null;
      }
      return head.objectId || null;
    },
    commits: {
      async loadCommit(id: string) {
        const commit = commits.get(id);
        if (!commit) {
          throw new Error(`Commit not found: ${id}`);
        }
        return commit;
      },
    },
    trees: {
      async *loadTree(id: string) {
        const tree = trees.get(id);
        if (tree) {
          yield* tree;
        }
      },
    },
  };
}

describe("createStorageAdapter", () => {
  describe("listRefs", () => {
    it("should list all refs except HEAD", async () => {
      const storage = createMockStorage({
        refs: new Map([
          ["refs/heads/master", { objectId: COMMIT_ID }],
          ["refs/heads/develop", { objectId: "d".repeat(40) }],
          ["refs/tags/v1.0", { objectId: COMMIT_ID }],
          ["HEAD", { target: "refs/heads/master" }],
        ]),
      });
      const adapter = createStorageAdapter(storage);

      const refs: Array<{ name: string; objectId: string }> = [];
      for await (const ref of adapter.listRefs()) {
        refs.push(ref);
      }

      expect(refs).toHaveLength(3);
      expect(refs.map((r) => r.name)).toContain("refs/heads/master");
      expect(refs.map((r) => r.name)).toContain("refs/heads/develop");
      expect(refs.map((r) => r.name)).toContain("refs/tags/v1.0");
      expect(refs.map((r) => r.name)).not.toContain("HEAD");
    });

    it("should skip refs without objectId", async () => {
      const storage = createMockStorage({
        refs: new Map([
          ["refs/heads/master", { objectId: COMMIT_ID }],
          ["refs/heads/broken", {}], // No objectId
        ]),
      });
      const adapter = createStorageAdapter(storage);

      const refs: Array<{ name: string; objectId: string }> = [];
      for await (const ref of adapter.listRefs()) {
        refs.push(ref);
      }

      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe("refs/heads/master");
    });
  });

  describe("getHead", () => {
    it("should return symbolic ref target", async () => {
      const storage = createMockStorage({
        refs: new Map([
          ["HEAD", { target: "refs/heads/master" }],
          ["refs/heads/master", { objectId: COMMIT_ID }],
        ]),
      });
      const adapter = createStorageAdapter(storage);

      const head = await adapter.getHead();

      expect(head).not.toBeNull();
      expect(head?.target).toBe("refs/heads/master");
    });

    it("should return detached HEAD objectId", async () => {
      const storage = createMockStorage({
        refs: new Map([["HEAD", { objectId: COMMIT_ID }]]),
        head: { objectId: COMMIT_ID },
      });
      const adapter = createStorageAdapter(storage);

      const head = await adapter.getHead();

      expect(head).not.toBeNull();
      expect(head?.objectId).toBe(COMMIT_ID);
    });

    it("should return null for non-existent HEAD", async () => {
      const storage = createMockStorage({
        refs: new Map([]),
        head: null,
      });
      const adapter = createStorageAdapter(storage);

      const head = await adapter.getHead();

      expect(head).toBeNull();
    });
  });

  describe("hasObject", () => {
    it("should return true for existing object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const has = await adapter.hasObject(COMMIT_ID);

      expect(has).toBe(true);
    });

    it("should return false for non-existing object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const has = await adapter.hasObject("nonexistent".repeat(4));

      expect(has).toBe(false);
    });
  });

  describe("getObjectInfo", () => {
    it("should return info for commit object", async () => {
      const commitContent = new TextEncoder().encode(`tree ${TREE_ID}`);
      const storage = createMockStorage({
        objects: new Map([[COMMIT_ID, createGitObject("commit", commitContent)]]),
      });
      const adapter = createStorageAdapter(storage);

      const info = await adapter.getObjectInfo(COMMIT_ID);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(OBJ_COMMIT);
    });

    it("should return info for tree object", async () => {
      const storage = createMockStorage({
        objects: new Map([[TREE_ID, createGitObject("tree", new Uint8Array(0))]]),
      });
      const adapter = createStorageAdapter(storage);

      const info = await adapter.getObjectInfo(TREE_ID);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(OBJ_TREE);
    });

    it("should return info for blob object", async () => {
      const blobContent = new TextEncoder().encode("Hello, World!");
      const storage = createMockStorage({
        objects: new Map([[BLOB_ID, createGitObject("blob", blobContent)]]),
      });
      const adapter = createStorageAdapter(storage);

      const info = await adapter.getObjectInfo(BLOB_ID);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(OBJ_BLOB);
    });

    it("should return info for tag object", async () => {
      const tagId = "t".repeat(40);
      const tagContent = new TextEncoder().encode(`object ${COMMIT_ID}`);
      const storage = createMockStorage({
        objects: new Map([[tagId, createGitObject("tag", tagContent)]]),
      });
      const adapter = createStorageAdapter(storage);

      const info = await adapter.getObjectInfo(tagId);

      expect(info).not.toBeNull();
      expect(info?.type).toBe(OBJ_TAG);
    });

    it("should return null for non-existing object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const info = await adapter.getObjectInfo("nonexistent".repeat(4));

      expect(info).toBeNull();
    });
  });

  describe("loadObject", () => {
    it("should yield object data", async () => {
      const blobContent = new TextEncoder().encode("Hello, World!");
      const storage = createMockStorage({
        objects: new Map([[BLOB_ID, createGitObject("blob", blobContent)]]),
      });
      const adapter = createStorageAdapter(storage);

      const chunks: Uint8Array[] = [];
      for await (const chunk of adapter.loadObject(BLOB_ID)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const fullData = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        fullData.set(chunk, offset);
        offset += chunk.length;
      }

      // Should contain blob header and content
      const text = new TextDecoder().decode(fullData);
      expect(text).toContain("blob");
      expect(text).toContain("Hello, World!");
    });
  });

  describe("storeObject", () => {
    it("should store blob object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const content = new TextEncoder().encode("Test content");
      const id = await adapter.storeObject(OBJ_BLOB, content);

      expect(id).toBeDefined();
      expect(id.length).toBe(40);

      // Verify object was stored
      const has = await adapter.hasObject(id);
      expect(has).toBe(true);
    });

    it("should store commit object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const content = new TextEncoder().encode(`tree ${TREE_ID}\n\nTest commit`);
      const id = await adapter.storeObject(OBJ_COMMIT, content);

      expect(id).toBeDefined();
      expect(id.length).toBe(40);
    });

    it("should store tree object", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const content = new Uint8Array(0); // Empty tree
      const id = await adapter.storeObject(OBJ_TREE, content);

      expect(id).toBeDefined();
      expect(id.length).toBe(40);
    });
  });

  describe("updateRef", () => {
    it("should create new ref", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["HEAD", { target: "refs/heads/master" }],
      ]);
      const storage = createMockStorage({ refs });
      const adapter = createStorageAdapter(storage);

      const result = await adapter.updateRef("refs/heads/new-branch", null, COMMIT_ID);

      expect(result).toBe(true);
      expect(refs.has("refs/heads/new-branch")).toBe(true);
      expect(refs.get("refs/heads/new-branch")?.objectId).toBe(COMMIT_ID);
    });

    it("should update existing ref", async () => {
      const newCommit = "n".repeat(40);
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/master", { objectId: COMMIT_ID }],
      ]);
      const storage = createMockStorage({ refs });
      const adapter = createStorageAdapter(storage);

      const result = await adapter.updateRef("refs/heads/master", COMMIT_ID, newCommit);

      expect(result).toBe(true);
      expect(refs.get("refs/heads/master")?.objectId).toBe(newCommit);
    });

    it("should delete ref when newId is null", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/master", { objectId: COMMIT_ID }],
        ["refs/heads/to-delete", { objectId: COMMIT_ID }],
      ]);
      const storage = createMockStorage({ refs });
      const adapter = createStorageAdapter(storage);

      const result = await adapter.updateRef("refs/heads/to-delete", COMMIT_ID, null);

      expect(result).toBe(true);
      expect(refs.has("refs/heads/to-delete")).toBe(false);
    });

    it("should fail update when oldId does not match current value", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/master", { objectId: COMMIT_ID }],
      ]);
      const storage = createMockStorage({ refs });
      const adapter = createStorageAdapter(storage);

      // Try to update with wrong oldId
      const wrongOldId = "x".repeat(40);
      const newCommit = "n".repeat(40);
      const result = await adapter.updateRef("refs/heads/master", wrongOldId, newCommit);

      expect(result).toBe(false);
      // Ref should not have changed
      expect(refs.get("refs/heads/master")?.objectId).toBe(COMMIT_ID);
    });

    it("should fail delete when oldId does not match current value", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/to-delete", { objectId: COMMIT_ID }],
      ]);
      const storage = createMockStorage({ refs });
      const adapter = createStorageAdapter(storage);

      // Try to delete with wrong oldId
      const wrongOldId = "x".repeat(40);
      const result = await adapter.updateRef("refs/heads/to-delete", wrongOldId, null);

      expect(result).toBe(false);
      // Ref should still exist
      expect(refs.has("refs/heads/to-delete")).toBe(true);
    });

    it("should use compareAndSwap when available", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/master", { objectId: COMMIT_ID }],
      ]);
      let casCallCount = 0;

      const storage = createMockStorage({ refs });
      // Add compareAndSwap to the storage
      storage.refs.compareAndSwap = async (
        refName: string,
        expectedOld: string | undefined,
        newValue: string,
      ) => {
        casCallCount++;
        const current = refs.get(refName);
        const currentId = current?.objectId;

        if (currentId !== expectedOld) {
          return { success: false, previousValue: currentId };
        }

        refs.set(refName, { objectId: newValue });
        return { success: true, previousValue: currentId };
      };

      const adapter = createStorageAdapter(storage);
      const newCommit = "n".repeat(40);

      const result = await adapter.updateRef("refs/heads/master", COMMIT_ID, newCommit);

      expect(result).toBe(true);
      expect(casCallCount).toBe(1); // compareAndSwap was used
      expect(refs.get("refs/heads/master")?.objectId).toBe(newCommit);
    });

    it("should return false when compareAndSwap fails", async () => {
      const refs = new Map<string, { objectId?: string; target?: string }>([
        ["refs/heads/master", { objectId: COMMIT_ID }],
      ]);

      const storage = createMockStorage({ refs });
      // Add compareAndSwap that always fails
      storage.refs.compareAndSwap = async () => {
        return { success: false };
      };

      const adapter = createStorageAdapter(storage);
      const newCommit = "n".repeat(40);

      const result = await adapter.updateRef("refs/heads/master", COMMIT_ID, newCommit);

      expect(result).toBe(false);
    });
  });

  describe("walkObjects", () => {
    it("should walk commit and its tree", async () => {
      const commitContent = new TextEncoder().encode(`tree ${TREE_ID}\n\nTest`);
      const storage = createMockStorage({
        objects: new Map([
          [COMMIT_ID, createGitObject("commit", commitContent)],
          [TREE_ID, createGitObject("tree", new Uint8Array(0))],
        ]),
        commits: new Map([
          [
            COMMIT_ID,
            {
              tree: TREE_ID,
              parents: [],
              author: {},
              committer: {},
              message: "Test",
            },
          ],
        ]),
      });
      const adapter = createStorageAdapter(storage);

      const objects: Array<{ id: string; type: ObjectTypeCode }> = [];
      for await (const obj of adapter.walkObjects([COMMIT_ID], [])) {
        objects.push({ id: obj.id, type: obj.type });
      }

      expect(objects.length).toBeGreaterThanOrEqual(1);
      expect(objects.find((o) => o.id === COMMIT_ID)).toBeDefined();
    });

    it("should skip objects in haves", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const objects: Array<{ id: string }> = [];
      for await (const obj of adapter.walkObjects([COMMIT_ID], [COMMIT_ID])) {
        objects.push({ id: obj.id });
      }

      // Commit should be skipped since it's in haves
      expect(objects.find((o) => o.id === COMMIT_ID)).toBeUndefined();
    });

    it("should not repeat objects", async () => {
      const storage = createMockStorage();
      const adapter = createStorageAdapter(storage);

      const objects: Array<{ id: string }> = [];
      // Request same object twice
      for await (const obj of adapter.walkObjects([COMMIT_ID, COMMIT_ID], [])) {
        objects.push({ id: obj.id });
      }

      // Should only appear once
      const commitCount = objects.filter((o) => o.id === COMMIT_ID).length;
      expect(commitCount).toBeLessThanOrEqual(1);
    });
  });
});

describe("Object type parsing", () => {
  it("should parse commit type correctly", async () => {
    const commitContent = new TextEncoder().encode("tree abc\n\nmessage");
    const storage = createMockStorage({
      objects: new Map([[COMMIT_ID, createGitObject("commit", commitContent)]]),
    });
    const adapter = createStorageAdapter(storage);

    const info = await adapter.getObjectInfo(COMMIT_ID);

    expect(info?.type).toBe(OBJ_COMMIT);
  });

  it("should parse tree type correctly", async () => {
    const storage = createMockStorage({
      objects: new Map([[TREE_ID, createGitObject("tree", new Uint8Array(0))]]),
    });
    const adapter = createStorageAdapter(storage);

    const info = await adapter.getObjectInfo(TREE_ID);

    expect(info?.type).toBe(OBJ_TREE);
  });

  it("should parse blob type correctly", async () => {
    const blobContent = new TextEncoder().encode("file content");
    const storage = createMockStorage({
      objects: new Map([[BLOB_ID, createGitObject("blob", blobContent)]]),
    });
    const adapter = createStorageAdapter(storage);

    const info = await adapter.getObjectInfo(BLOB_ID);

    expect(info?.type).toBe(OBJ_BLOB);
  });

  it("should parse tag type correctly", async () => {
    const tagId = "t".repeat(40);
    const tagContent = new TextEncoder().encode(`object ${COMMIT_ID}\ntype commit\n`);
    const storage = createMockStorage({
      objects: new Map([[tagId, createGitObject("tag", tagContent)]]),
    });
    const adapter = createStorageAdapter(storage);

    const info = await adapter.getObjectInfo(tagId);

    expect(info?.type).toBe(OBJ_TAG);
  });
});
