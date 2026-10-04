import type { Commits, Refs, TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { describe, expect, it, vi } from "vitest";
import type { MergeStageValue, StagingEntry } from "../../src/staging/index.js";
import type { Staging } from "../../src/staging/staging.js";
import {
  createStatusCalculator,
  FileStatus,
  getStageState,
  StageState,
} from "../../src/status/index.js";
import type { WorktreeEntry } from "../../src/worktree/index.js";
import type { Worktree } from "../../src/worktree/worktree.js";

/**
 * Helper to create mock tree store (Trees interface)
 */
function createMockTreeStore(entries: Map<string, TreeEntry[]>): Trees {
  return {
    load: vi.fn().mockImplementation(async (treeId: string) => {
      const treeEntries = entries.get(treeId);
      if (!treeEntries) return undefined;
      return (async function* () {
        for (const entry of treeEntries) {
          yield entry;
        }
      })();
    }),
    store: vi.fn(),
    getEntry: vi.fn().mockImplementation(async (treeId: string, name: string) => {
      const treeEntries = entries.get(treeId) ?? [];
      return treeEntries.find((e) => e.name === name);
    }),
    has: vi.fn().mockImplementation(async (treeId: string) => entries.has(treeId)),
    keys: vi.fn().mockImplementation(async function* () {
      for (const key of entries.keys()) {
        yield key;
      }
    }),
    remove: vi.fn(),
    getEmptyTreeId: vi.fn().mockReturnValue("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
  } as unknown as Trees;
}

/**
 * Helper to create mock Staging (new interface)
 */
function createMockStaging(stagingEntries: StagingEntry[], conflictPaths: string[] = []): Staging {
  return {
    getEntryCount: vi.fn().mockResolvedValue(stagingEntries.length),
    hasEntry: vi.fn().mockImplementation(async (path: string) => {
      return stagingEntries.some((e) => e.path === path);
    }),
    getEntry: vi.fn().mockImplementation(async (path: string, stage?: MergeStageValue) => {
      const targetStage = stage ?? 0;
      return stagingEntries.find((e) => e.path === path && e.stage === targetStage);
    }),
    getEntries: vi.fn().mockImplementation(async (path: string) => {
      return stagingEntries.filter((e) => e.path === path);
    }),
    setEntry: vi.fn().mockResolvedValue(undefined),
    removeEntry: vi.fn().mockResolvedValue(true),
    entries: vi.fn().mockImplementation(async function* () {
      for (const entry of stagingEntries) {
        yield entry;
      }
    }),
    hasConflicts: vi.fn().mockResolvedValue(conflictPaths.length > 0),
    getConflictedPaths: vi.fn().mockResolvedValue(conflictPaths),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
    writeTree: vi.fn().mockResolvedValue("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
    readTree: vi.fn().mockResolvedValue(undefined),
    createBuilder: vi.fn().mockReturnValue({
      add: vi.fn(),
      keep: vi.fn(),
      addTree: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    createEditor: vi.fn().mockReturnValue({
      add: vi.fn(),
      remove: vi.fn(),
      upsert: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    isOutdated: vi.fn().mockResolvedValue(false),
    getUpdateTime: vi.fn().mockReturnValue(Date.now() - 10000), // 10 seconds ago
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as Staging;
}

/**
 * Helper to create mock Worktree (new interface)
 */
function createMockWorktree(entries: WorktreeEntry[], hashes: Map<string, string>): Worktree {
  return {
    walk: vi.fn().mockImplementation(async function* () {
      for (const entry of entries) {
        yield entry;
      }
    }),
    getEntry: vi.fn().mockImplementation(async (path: string) => {
      return entries.find((e) => e.path === path);
    }),
    computeHash: vi.fn().mockImplementation(async (path: string) => {
      return hashes.get(path) ?? "unknown-hash";
    }),
    readContent: vi.fn().mockImplementation(function* () {
      yield new Uint8Array([]);
    }),
    exists: vi.fn().mockImplementation(async (path: string) => {
      return entries.some((e) => e.path === path);
    }),
    isIgnored: vi.fn().mockImplementation(async (path: string) => {
      const entry = entries.find((e) => e.path === path);
      return entry?.isIgnored ?? false;
    }),
    writeContent: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    checkoutTree: vi
      .fn()
      .mockResolvedValue({ updated: [], removed: [], conflicts: [], failed: [] }),
    checkoutPaths: vi
      .fn()
      .mockResolvedValue({ updated: [], removed: [], conflicts: [], failed: [] }),
    getRoot: vi.fn().mockReturnValue("/mock/worktree"),
    refreshIgnore: vi.fn().mockResolvedValue(undefined),
  } as unknown as Worktree;
}

/**
 * Helper to create mock commit store
 */
function createMockCommitStore(trees: Map<string, string>): Commits {
  return {
    store: vi.fn(),
    load: vi.fn(),
    has: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
    getParents: vi.fn(),
    getTree: vi.fn().mockImplementation(async (commitId: string) => {
      return trees.get(commitId);
    }),
    walkAncestry: vi.fn(),
    findMergeBase: vi.fn(),
    isAncestor: vi.fn(),
  } as unknown as Commits;
}

/**
 * Helper to create mock ref store
 */
function createMockRefStore(headCommit?: string, branch?: string): Refs {
  return {
    get: vi.fn().mockImplementation(async (name: string) => {
      if (name === "HEAD" && branch) {
        return { target: `refs/heads/${branch}` };
      }
      return undefined;
    }),
    resolve: vi.fn().mockImplementation(async () => {
      if (headCommit) {
        return { objectId: headCommit };
      }
      return undefined;
    }),
    set: vi.fn(),
    setSymbolic: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    has: vi.fn(),
  } as unknown as Refs;
}

/**
 * Helper to create a staging entry
 */
function createStagingEntry(
  path: string,
  objectId: string,
  stage: MergeStageValue = 0,
  options: Partial<StagingEntry> = {},
): StagingEntry {
  return {
    path,
    objectId,
    mode: FileMode.REGULAR_FILE,
    stage,
    size: 100,
    mtime: Date.now() - 10000, // 10 seconds ago
    ...options,
  };
}

/**
 * Helper to create a working tree entry
 */
function createWorktreeEntry(path: string, options: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    mode: FileMode.REGULAR_FILE,
    size: 100,
    mtime: Date.now() - 10000,
    isDirectory: false,
    isIgnored: false,
    ...options,
  };
}

describe("StatusCalculator", () => {
  describe("calculateStatus", () => {
    it("should return empty status for empty repository", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.files.length).toBe(0);
      expect(status.isClean).toBe(true);
      expect(status.hasStaged).toBe(false);
      expect(status.hasUnstaged).toBe(false);
      expect(status.hasUntracked).toBe(false);
      expect(status.hasConflicts).toBe(false);
    });

    it("should detect added file", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", []);

      const stagingEntries = [createStagingEntry("new-file.txt", "abc123")];

      const worktreeEntries = [createWorktreeEntry("new-file.txt")];

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging(stagingEntries);
      const worktree = createMockWorktree(worktreeEntries, new Map([["new-file.txt", "abc123"]]));
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.hasStaged).toBe(true);
      expect(
        status.files.some((f) => f.path === "new-file.txt" && f.indexStatus === FileStatus.ADDED),
      ).toBe(true);
    });

    it("should detect deleted file", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "deleted.txt", id: "hash123", mode: FileMode.REGULAR_FILE },
      ]);

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([], new Map());
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.hasStaged).toBe(true);
      expect(
        status.files.some((f) => f.path === "deleted.txt" && f.indexStatus === FileStatus.DELETED),
      ).toBe(true);
    });

    it("should detect modified file in index", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "old-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [createStagingEntry("file.txt", "new-hash")];

      const worktreeEntries = [createWorktreeEntry("file.txt")];

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging(stagingEntries);
      const worktree = createMockWorktree(worktreeEntries, new Map([["file.txt", "new-hash"]]));
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.hasStaged).toBe(true);
      expect(
        status.files.some((f) => f.path === "file.txt" && f.indexStatus === FileStatus.MODIFIED),
      ).toBe(true);
    });

    it("should detect untracked file", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([createWorktreeEntry("untracked.txt")], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.hasUntracked).toBe(true);
      expect(
        status.files.some(
          (f) => f.path === "untracked.txt" && f.workTreeStatus === FileStatus.UNTRACKED,
        ),
      ).toBe(true);
    });

    it("should detect conflicts", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([], ["conflict.txt"]);
      const worktree = createMockWorktree([createWorktreeEntry("conflict.txt")], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.hasConflicts).toBe(true);
      expect(
        status.files.some(
          (f) => f.path === "conflict.txt" && f.indexStatus === FileStatus.CONFLICTED,
        ),
      ).toBe(true);
    });

    it("should return current branch", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore(undefined, "feature-branch");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus();

      expect(status.branch).toBe("feature-branch");
    });

    it("should filter by path prefix", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "src", id: "src-tree", mode: FileMode.TREE },
        { name: "docs", id: "docs-tree", mode: FileMode.TREE },
      ]);
      treeEntries.set("src-tree", [
        { name: "file.ts", id: "src-file", mode: FileMode.REGULAR_FILE },
      ]);
      treeEntries.set("docs-tree", [
        { name: "readme.md", id: "docs-file", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("src/file.ts", "src-new"),
        createStagingEntry("docs/readme.md", "docs-new"),
      ];

      const worktreeEntries = [
        createWorktreeEntry("src/file.ts"),
        createWorktreeEntry("docs/readme.md"),
      ];

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging(stagingEntries);
      const worktree = createMockWorktree(
        worktreeEntries,
        new Map([
          ["src/file.ts", "src-new"],
          ["docs/readme.md", "docs-new"],
        ]),
      );
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus({ pathPrefix: "src/" });

      expect(status.files.some((f) => f.path === "src/file.ts")).toBe(true);
      expect(status.files.some((f) => f.path === "docs/readme.md")).toBe(false);
    });

    it("should exclude ignored files when option disabled", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("ignored.log", { isIgnored: true })],
        new Map(),
      );
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus({ includeIgnored: false });

      expect(status.files.some((f) => f.path === "ignored.log")).toBe(false);
    });

    it("should include ignored files when option enabled", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("ignored.log", { isIgnored: true })],
        new Map(),
      );
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.calculateStatus({ includeIgnored: true });

      expect(
        status.files.some(
          (f) => f.path === "ignored.log" && f.workTreeStatus === FileStatus.IGNORED,
        ),
      ).toBe(true);
    });
  });

  describe("getFileStatus", () => {
    it("should return undefined for unmodified file", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "hash123", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [createStagingEntry("file.txt", "hash123")];

      const worktreeEntries = [
        createWorktreeEntry("file.txt", { size: 100, mtime: Date.now() - 20000 }),
      ];

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging(stagingEntries);
      const worktree = createMockWorktree(worktreeEntries, new Map([["file.txt", "hash123"]]));
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.getFileStatus("file.txt");

      expect(status).toBeUndefined();
    });

    it("should return status for modified file", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "old-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [createStagingEntry("file.txt", "new-hash")];

      const worktreeEntries = [createWorktreeEntry("file.txt")];

      const trees = createMockTreeStore(treeEntries);
      const staging = createMockStaging(stagingEntries);
      const worktree = createMockWorktree(worktreeEntries, new Map([["file.txt", "new-hash"]]));
      const commits = createMockCommitStore(new Map([["head-commit", "head-tree"]]));
      const refs = createMockRefStore("head-commit", "main");

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const status = await calculator.getFileStatus("file.txt");

      expect(status).toBeDefined();
      expect(status?.indexStatus).toBe(FileStatus.MODIFIED);
    });
  });

  describe("isModified", () => {
    it("should return false for file not in index or worktree", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const isModified = await calculator.isModified("nonexistent.txt");

      expect(isModified).toBe(false);
    });

    it("should return true for file in worktree but not in index", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([createWorktreeEntry("new-file.txt")], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const isModified = await calculator.isModified("new-file.txt");

      expect(isModified).toBe(true);
    });

    it("should return true for file in index but deleted from worktree", async () => {
      const trees = createMockTreeStore(new Map());
      const staging = createMockStaging([createStagingEntry("deleted.txt", "hash123")]);
      const worktree = createMockWorktree([], new Map());
      const commits = createMockCommitStore(new Map());
      const refs = createMockRefStore();

      const calculator = createStatusCalculator({
        worktree,
        staging,
        trees,
        commits,
        refs,
      });

      const isModified = await calculator.isModified("deleted.txt");

      expect(isModified).toBe(true);
    });
  });
});

describe("StageState", () => {
  describe("getStageState", () => {
    it("should return BOTH_DELETED for base only", () => {
      expect(getStageState(true, false, false)).toBe(StageState.BOTH_DELETED);
    });

    it("should return ADDED_BY_US for ours only", () => {
      expect(getStageState(false, true, false)).toBe(StageState.ADDED_BY_US);
    });

    it("should return DELETED_BY_THEM for base + ours", () => {
      expect(getStageState(true, true, false)).toBe(StageState.DELETED_BY_THEM);
    });

    it("should return ADDED_BY_THEM for theirs only", () => {
      expect(getStageState(false, false, true)).toBe(StageState.ADDED_BY_THEM);
    });

    it("should return DELETED_BY_US for base + theirs", () => {
      expect(getStageState(true, false, true)).toBe(StageState.DELETED_BY_US);
    });

    it("should return BOTH_ADDED for ours + theirs", () => {
      expect(getStageState(false, true, true)).toBe(StageState.BOTH_ADDED);
    });

    it("should return BOTH_MODIFIED for all three", () => {
      expect(getStageState(true, true, true)).toBe(StageState.BOTH_MODIFIED);
    });

    it("should throw for no stages", () => {
      expect(() => getStageState(false, false, false)).toThrow();
    });
  });
});
