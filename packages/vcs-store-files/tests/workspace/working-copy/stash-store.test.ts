/**
 * Tests for GitStashStore (file-based stash implementation)
 */

import type { History } from "@statewalker/vcs-core";
import { GitStashStore, type StashFilesApi } from "@statewalker/vcs-store-files";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockCommitStore } from "../../mocks/mock-commit-store.js";
import { createMockStaging, createStagingEntry } from "../../mocks/mock-staging-store.js";
import { createMockTreeStore } from "../../mocks/mock-tree-store.js";
import { createMockWorktree, createWorktreeEntry } from "../../mocks/mock-worktree.js";

/**
 * Create mock files API for testing.
 */
function createMockFilesApi(): StashFilesApi & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();

  return {
    files,
    read: vi.fn().mockImplementation(async (path: string) => {
      return files.get(path);
    }),
    write: vi.fn().mockImplementation(async (path: string, content: Uint8Array) => {
      files.set(path, content);
    }),
    remove: vi.fn().mockImplementation(async (path: string) => {
      files.delete(path);
    }),
    mkdir: vi.fn().mockImplementation(async () => {
      // No-op for in-memory mock
    }),
    exists: vi.fn().mockImplementation(async (path: string) => {
      // Check if path exists as file or if any files are under this directory
      if (files.has(path)) return true;
      for (const key of files.keys()) {
        if (key.startsWith(`${path}/`)) return true;
      }
      return false;
    }),
  };
}

/**
 * Create mock blob store.
 */
function createMockBlobStore() {
  const blobs = new Map<string, Uint8Array>();
  let idCounter = 0;

  const storeImpl = async (content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    if (Symbol.asyncIterator in content) {
      for await (const chunk of content as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
    } else {
      for (const chunk of content as Iterable<Uint8Array>) {
        chunks.push(chunk);
      }
    }
    const data = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const id = `blob${(idCounter++).toString().padStart(36, "0")}`;
    blobs.set(id, data);
    return id;
  };

  const loadImpl = async (id: string) => {
    const data = blobs.get(id);
    if (!data) return undefined;
    return (async function* () {
      yield data;
    })();
  };

  return {
    // New interface (Blobs)
    store: vi.fn().mockImplementation(storeImpl),
    load: vi.fn().mockImplementation(loadImpl),
    has: vi.fn().mockImplementation(async (id: string) => blobs.has(id)),
    size: vi.fn().mockImplementation(async (id: string) => {
      const data = blobs.get(id);
      return data ? data.length : -1;
    }),
    keys: vi.fn().mockImplementation(async function* () {
      for (const key of blobs.keys()) {
        yield key;
      }
    }),
    getBlobs: () => blobs,
  };
}

/**
 * Create a mock repository for testing.
 */
function createMockRepository(): History {
  const treeStore = createMockTreeStore({
    "tree-1": [{ name: "file.txt", id: "blob-1", mode: 0o100644 }],
    "tree-2": [
      { name: "file.txt", id: "blob-1", mode: 0o100644 },
      { name: "new.txt", id: "blob-2", mode: 0o100644 },
    ],
  });

  const commitStore = new MockCommitStore();
  const blobStore = createMockBlobStore();

  return {
    commits: commitStore,
    trees: treeStore,
    blobs: blobStore,
    refs: {} as History["refs"],
    tags: {} as History["tags"],
    objects: {} as History["objects"],
  } as unknown as History;
}

describe("GitStashStore", () => {
  let stash: GitStashStore;
  let repository: History;
  let filesApi: ReturnType<typeof createMockFilesApi>;
  let headCommitId: string;
  let headTreeId: string;

  beforeEach(async () => {
    repository = createMockRepository();
    filesApi = createMockFilesApi();

    // Create initial HEAD commit
    headTreeId = "tree-1";
    headCommitId = await repository.commits.storeCommit({
      tree: headTreeId,
      parents: [],
      author: { name: "Test", email: "test@example.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@example.com", timestamp: 1000, tzOffset: "+0000" },
      message: "Initial commit",
    });

    const staging = createMockStaging([createStagingEntry("file.txt", "blob-1")]);

    // Mock writeTree to return a tree ID
    staging.writeTree = vi.fn().mockResolvedValue("tree-1");
    staging.readTree = vi.fn().mockResolvedValue(undefined);

    const worktree = createMockWorktree(
      [createWorktreeEntry("file.txt")],
      new Map([["file.txt", "blob-1"]]),
    );

    stash = new GitStashStore({
      history: repository,
      staging,
      worktree,
      files: filesApi,
      gitDir: ".git",
      getHead: async () => headCommitId,
      getBranch: async () => "main",
    });
  });

  describe("push", () => {
    it("should create stash commit with custom message", async () => {
      const stashId = await stash.push("WIP: testing stash");

      expect(stashId).toBeDefined();
      expect(stashId.length).toBe(40);

      // Verify refs/stash was written
      const stashRef = filesApi.files.get(".git/refs/stash");
      expect(stashRef).toBeDefined();
      if (!stashRef) {
        throw new Error("stashRef should be defined");
      }
      expect(new TextDecoder().decode(stashRef).trim()).toBe(stashId);
    });

    it("should create stash commit with default message", async () => {
      const _stashId = await stash.push();

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("WIP on main");
    });

    it("should create reflog entry", async () => {
      await stash.push("My stash");

      const reflog = filesApi.files.get(".git/logs/refs/stash");
      expect(reflog).toBeDefined();
      if (!reflog) {
        throw new Error("reflog should be defined");
      }

      const content = new TextDecoder().decode(reflog);
      expect(content).toContain("stash: My stash");
    });

    it("should throw when no HEAD commit exists", async () => {
      const noHeadStash = new GitStashStore({
        history: repository,
        staging: createMockStaging([]),
        worktree: createMockWorktree([]),
        files: filesApi,
        gitDir: ".git",
        getHead: async () => undefined,
        getBranch: async () => "main",
      });

      await expect(noHeadStash.push()).rejects.toThrow("Cannot stash: no commits in repository");
    });

    it("should update refs/stash for multiple stashes", async () => {
      const firstId = await stash.push("First");
      const secondId = await stash.push("Second");

      // refs/stash should point to most recent
      const stashRef = filesApi.files.get(".git/refs/stash");
      if (!stashRef) {
        throw new Error("stashRef should be defined");
      }
      expect(new TextDecoder().decode(stashRef).trim()).toBe(secondId);
      expect(secondId).not.toBe(firstId);
    });
  });

  describe("list", () => {
    it("should return empty for new repository", async () => {
      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(0);
    });

    it("should list stash entries in correct order", async () => {
      await stash.push("First stash");
      await stash.push("Second stash");
      await stash.push("Third stash");

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(3);
      expect(entries[0].index).toBe(0);
      expect(entries[0].message).toBe("Third stash");
      expect(entries[1].index).toBe(1);
      expect(entries[1].message).toBe("Second stash");
      expect(entries[2].index).toBe(2);
      expect(entries[2].message).toBe("First stash");
    });

    it("should parse reflog entries correctly", async () => {
      await stash.push("Test stash");

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries[0]).toMatchObject({
        index: 0,
        message: "Test stash",
      });
      expect(entries[0].commitId).toBeDefined();
      expect(entries[0].timestamp).toBeGreaterThan(0);
    });
  });

  describe("apply", () => {
    it("should apply stash at index 0", async () => {
      const staging = createMockStaging([]);
      staging.writeTree = vi.fn().mockResolvedValue("tree-1");
      staging.readTree = vi.fn().mockResolvedValue(undefined);

      const stashWithMockStaging = new GitStashStore({
        history: repository,
        staging,
        worktree: createMockWorktree([]),
        files: filesApi,
        gitDir: ".git",
        getHead: async () => headCommitId,
        getBranch: async () => "main",
      });

      await stashWithMockStaging.push("My stash");
      await stashWithMockStaging.apply(0);

      expect(staging.readTree).toHaveBeenCalled();
    });

    it("should throw for invalid stash index", async () => {
      await expect(stash.apply(0)).rejects.toThrow("stash@{0} does not exist");
    });

    it("should apply without removing the stash entry", async () => {
      await stash.push("My stash");
      await stash.apply(0);

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
    });
  });

  describe("pop", () => {
    it("should apply and drop stash at index 0", async () => {
      const staging = createMockStaging([]);
      staging.writeTree = vi.fn().mockResolvedValue("tree-1");
      staging.readTree = vi.fn().mockResolvedValue(undefined);

      const stashWithMockStaging = new GitStashStore({
        history: repository,
        staging,
        worktree: createMockWorktree([]),
        files: filesApi,
        gitDir: ".git",
        getHead: async () => headCommitId,
        getBranch: async () => "main",
      });

      await stashWithMockStaging.push("First");
      await stashWithMockStaging.push("Second");

      await stashWithMockStaging.pop();

      const entries = [];
      for await (const entry of stashWithMockStaging.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("First");
      expect(staging.readTree).toHaveBeenCalled();
    });
  });

  describe("drop", () => {
    it("should drop stash entry at index 0", async () => {
      await stash.push("First");
      await stash.push("Second");

      await stash.drop(0);

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("First");
      expect(entries[0].index).toBe(0);
    });

    it("should drop stash entry at specific index", async () => {
      await stash.push("First");
      await stash.push("Second");
      await stash.push("Third");

      await stash.drop(1); // Drop "Second"

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe("Third");
      expect(entries[1].message).toBe("First");
    });

    it("should throw for invalid stash index", async () => {
      await stash.push("First");

      await expect(stash.drop(5)).rejects.toThrow("stash@{5} does not exist");
    });

    it("should clean up when dropping last entry", async () => {
      await stash.push("Only stash");

      await stash.drop(0);

      // refs/stash and reflog should be removed
      expect(filesApi.files.has(".git/refs/stash")).toBe(false);
      expect(filesApi.files.has(".git/logs/refs/stash")).toBe(false);
    });

    it("should update refs/stash after drop", async () => {
      await stash.push("First");
      const secondId = await stash.push("Second");

      await stash.drop(0); // Drop second (index 0)

      // refs/stash should now point to first
      const stashRef = filesApi.files.get(".git/refs/stash");
      expect(stashRef).toBeDefined();
      if (!stashRef) {
        throw new Error("stashRef should be defined");
      }
      expect(new TextDecoder().decode(stashRef).trim()).not.toBe(secondId);
    });
  });

  describe("clear", () => {
    it("should remove all stash entries", async () => {
      await stash.push("First");
      await stash.push("Second");
      await stash.push("Third");

      await stash.clear();

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(0);
      expect(filesApi.files.has(".git/refs/stash")).toBe(false);
      expect(filesApi.files.has(".git/logs/refs/stash")).toBe(false);
    });

    it("should not throw on empty stash", async () => {
      await expect(stash.clear()).resolves.not.toThrow();
    });
  });

  describe("stash commit structure", () => {
    it("should create stash commit with two parents", async () => {
      const stashId = await stash.push("Test stash");

      const commit = await repository.commits.loadCommit(stashId);

      // Parent 1: HEAD
      // Parent 2: Index commit
      expect(commit.parents).toHaveLength(2);
      expect(commit.parents[0]).toBe(headCommitId);
      expect(commit.parents[1]).toBeDefined();
      expect(commit.parents[1]).not.toBe(headCommitId);
    });

    it("should include branch name in default message", async () => {
      const stashId = await stash.push();

      const commit = await repository.commits.loadCommit(stashId);
      expect(commit.message).toBe("WIP on main");
    });
  });

  describe("worktree modifications", () => {
    it("should capture worktree changes in stash tree", async () => {
      // Create worktree with modified file
      const modifiedWorktree = createMockWorktree(
        [createWorktreeEntry("file.txt", { size: 200 })],
        new Map([["file.txt", "modified-blob"]]),
      );

      const staging = createMockStaging([createStagingEntry("file.txt", "blob-1")]);
      staging.writeTree = vi.fn().mockResolvedValue("tree-1");

      const stashWithModified = new GitStashStore({
        history: repository,
        staging,
        worktree: modifiedWorktree,
        files: filesApi,
        gitDir: ".git",
        getHead: async () => headCommitId,
        getBranch: async () => "main",
      });

      await stashWithModified.push("Modified file");

      // Verify stash was created
      const entries = [];
      for await (const entry of stashWithModified.list()) {
        entries.push(entry);
      }
      expect(entries).toHaveLength(1);
    });
  });

  describe("untracked files support", () => {
    it("should create stash with 2 parents when includeUntracked is false", async () => {
      const stashId = await stash.push({ message: "Without untracked" });

      const commit = await repository.commits.loadCommit(stashId);
      expect(commit.parents).toHaveLength(2);
    });

    it("should create stash with 3 parents when includeUntracked is true and untracked files exist", async () => {
      // Create worktree with both tracked and untracked files
      const worktreeWithUntracked = createMockWorktree(
        [
          createWorktreeEntry("file.txt"), // tracked
          createWorktreeEntry("untracked.txt"), // untracked
        ],
        new Map([
          ["file.txt", "blob-1"],
          ["untracked.txt", "untracked-blob"],
        ]),
      );

      // Only file.txt is in staging (tracked)
      const stagingWithTracked = createMockStaging([createStagingEntry("file.txt", "blob-1")]);
      stagingWithTracked.writeTree = vi.fn().mockResolvedValue("tree-1");

      const stashWithUntracked = new GitStashStore({
        history: repository,
        staging: stagingWithTracked,
        worktree: worktreeWithUntracked,
        files: filesApi,
        gitDir: ".git",
        getHead: async () => headCommitId,
        getBranch: async () => "main",
      });

      const stashId = await stashWithUntracked.push({
        message: "With untracked",
        includeUntracked: true,
      });

      const commit = await repository.commits.loadCommit(stashId);

      // Should have 3 parents: HEAD, index, untracked
      expect(commit.parents).toHaveLength(3);

      // Parent 3 should be the untracked commit (orphan)
      const untrackedCommit = await repository.commits.loadCommit(commit.parents[2]);
      expect(untrackedCommit.parents).toHaveLength(0); // Orphan commit
      expect(untrackedCommit.message).toContain("untracked files");
    });

    it("should create stash with 2 parents when includeUntracked is true but no untracked files", async () => {
      // All worktree files are tracked
      const worktreeAllTracked = createMockWorktree(
        [createWorktreeEntry("file.txt")],
        new Map([["file.txt", "blob-1"]]),
      );

      const stagingAllTracked = createMockStaging([createStagingEntry("file.txt", "blob-1")]);
      stagingAllTracked.writeTree = vi.fn().mockResolvedValue("tree-1");

      const stashAllTracked = new GitStashStore({
        history: repository,
        staging: stagingAllTracked,
        worktree: worktreeAllTracked,
        files: filesApi,
        gitDir: ".git",
        getHead: async () => headCommitId,
        getBranch: async () => "main",
      });

      const stashId = await stashAllTracked.push({
        message: "No untracked",
        includeUntracked: true,
      });

      const commit = await repository.commits.loadCommit(stashId);

      // Should only have 2 parents since no untracked files exist
      expect(commit.parents).toHaveLength(2);
    });

    it("should support string message as shorthand for options", async () => {
      const stashId = await stash.push("Simple string message");

      const commit = await repository.commits.loadCommit(stashId);
      expect(commit.message).toBe("Simple string message");
    });
  });
});
