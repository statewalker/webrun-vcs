import type { TreeEntry, Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { describe, expect, it, vi } from "vitest";
import type { MergeStageValue, StagingEntry } from "../../src/staging/index.js";
import type { Staging } from "../../src/staging/staging.js";
import {
  createEmptyIndexDiff,
  createIndexDiffCalculator,
  type IndexDiffDependencies,
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
    getEntry: vi.fn(),
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
function createMockStaging(stagingEntries: StagingEntry[]): Staging {
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
    hasConflicts: vi.fn().mockResolvedValue(false),
    getConflictedPaths: vi.fn().mockResolvedValue([]),
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
    getUpdateTime: vi.fn().mockReturnValue(Date.now() - 10000),
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
    mtime: 1000,
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
    mtime: 1000,
    isDirectory: false,
    isIgnored: false,
    ...options,
  };
}

describe("createEmptyIndexDiff", () => {
  it("should create empty sets and maps", () => {
    const diff = createEmptyIndexDiff();

    expect(diff.added.size).toBe(0);
    expect(diff.changed.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    expect(diff.missing.size).toBe(0);
    expect(diff.modified.size).toBe(0);
    expect(diff.untracked.size).toBe(0);
    expect(diff.untrackedFolders.size).toBe(0);
    expect(diff.conflicting.size).toBe(0);
    expect(diff.conflictingStageStates.size).toBe(0);
    expect(diff.ignoredNotInIndex.size).toBe(0);
    expect(diff.assumeUnchanged.size).toBe(0);
  });
});

describe("IndexDiffCalculator", () => {
  describe("empty repository", () => {
    it("should return empty diff for empty repository", async () => {
      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging([]),
        worktree: createMockWorktree([], new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.added.size).toBe(0);
      expect(diff.changed.size).toBe(0);
      expect(diff.removed.size).toBe(0);
      expect(diff.untracked.size).toBe(0);
    });

    it("should detect untracked files when no HEAD", async () => {
      const worktreeEntries = [createWorktreeEntry("file.txt")];
      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging([]),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.untracked.has("file.txt")).toBe(true);
    });
  });

  describe("added files", () => {
    it("should detect file added to index", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", []);

      const stagingEntries = [createStagingEntry("new-file.txt", "abc123")];

      const worktreeEntries = [createWorktreeEntry("new-file.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["new-file.txt", "abc123"]])),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.added.has("new-file.txt")).toBe(true);
      expect(diff.untracked.has("new-file.txt")).toBe(false);
    });
  });

  describe("changed files", () => {
    it("should detect file changed in index", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "old-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [createStagingEntry("file.txt", "new-hash")];

      const worktreeEntries = [createWorktreeEntry("file.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["file.txt", "new-hash"]])),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.changed.has("file.txt")).toBe(true);
      expect(diff.added.has("file.txt")).toBe(false);
    });
  });

  describe("removed files", () => {
    it("should detect file removed from index", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "deleted.txt", id: "hash123", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries: StagingEntry[] = [];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree([], new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.removed.has("deleted.txt")).toBe(true);
    });
  });

  describe("modified files", () => {
    it("should detect file modified in working tree", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "index-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("file.txt", "index-hash", 0, { size: 100, mtime: 1000 }),
      ];

      const worktreeEntries = [createWorktreeEntry("file.txt", { size: 200, mtime: 2000 })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["file.txt", "worktree-hash"]])),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.modified.has("file.txt")).toBe(true);
    });

    it("should not mark file as modified if content matches", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "same-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("file.txt", "same-hash", 0, { size: 100, mtime: 1000 }),
      ];

      const worktreeEntries = [createWorktreeEntry("file.txt", { size: 100, mtime: 1000 })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["file.txt", "same-hash"]])),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.modified.has("file.txt")).toBe(false);
    });
  });

  describe("missing files", () => {
    it("should detect file missing from working tree", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "file.txt", id: "hash123", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [createStagingEntry("file.txt", "hash123")];

      const worktreeEntries: WorktreeEntry[] = [];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.missing.has("file.txt")).toBe(true);
    });
  });

  describe("untracked files", () => {
    it("should detect untracked files", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", []);

      const stagingEntries: StagingEntry[] = [];

      const worktreeEntries = [createWorktreeEntry("untracked.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.untracked.has("untracked.txt")).toBe(true);
    });

    it("should track untracked folders", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", []);

      const worktreeEntries = [createWorktreeEntry("new-folder/file.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging([]),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.untracked.has("new-folder/file.txt")).toBe(true);
      expect(diff.untrackedFolders.has("new-folder")).toBe(true);
    });

    it("should exclude untracked when option disabled", async () => {
      const worktreeEntries = [createWorktreeEntry("untracked.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging([]),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate({ includeUntracked: false });

      expect(diff.untracked.has("untracked.txt")).toBe(false);
    });
  });

  describe("ignored files", () => {
    it("should detect ignored files when option enabled", async () => {
      const worktreeEntries = [createWorktreeEntry("ignored.txt", { isIgnored: true })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging([]),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate({ includeIgnored: true });

      expect(diff.ignoredNotInIndex.has("ignored.txt")).toBe(true);
      expect(diff.untracked.has("ignored.txt")).toBe(false);
    });

    it("should exclude ignored files when option disabled", async () => {
      const worktreeEntries = [createWorktreeEntry("ignored.txt", { isIgnored: true })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging([]),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate({ includeIgnored: false });

      expect(diff.ignoredNotInIndex.has("ignored.txt")).toBe(false);
    });
  });

  describe("conflict detection", () => {
    it("should detect BOTH_MODIFIED conflict", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "conflict.txt", id: "base-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("conflict.txt", "base-hash", 1),
        createStagingEntry("conflict.txt", "ours-hash", 2),
        createStagingEntry("conflict.txt", "theirs-hash", 3),
      ];

      const worktreeEntries = [createWorktreeEntry("conflict.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.conflicting.has("conflict.txt")).toBe(true);
      expect(diff.conflictingStageStates.get("conflict.txt")).toBe(StageState.BOTH_MODIFIED);
    });

    it("should detect BOTH_ADDED conflict", async () => {
      const stagingEntries = [
        createStagingEntry("new-conflict.txt", "ours-hash", 2),
        createStagingEntry("new-conflict.txt", "theirs-hash", 3),
      ];

      const worktreeEntries = [createWorktreeEntry("new-conflict.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.conflicting.has("new-conflict.txt")).toBe(true);
      expect(diff.conflictingStageStates.get("new-conflict.txt")).toBe(StageState.BOTH_ADDED);
    });

    it("should detect DELETED_BY_US conflict", async () => {
      const stagingEntries = [
        createStagingEntry("deleted-by-us.txt", "base-hash", 1),
        createStagingEntry("deleted-by-us.txt", "theirs-hash", 3),
      ];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree([], new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.conflicting.has("deleted-by-us.txt")).toBe(true);
      expect(diff.conflictingStageStates.get("deleted-by-us.txt")).toBe(StageState.DELETED_BY_US);
    });

    it("should detect DELETED_BY_THEM conflict", async () => {
      const stagingEntries = [
        createStagingEntry("deleted-by-them.txt", "base-hash", 1),
        createStagingEntry("deleted-by-them.txt", "ours-hash", 2),
      ];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree([], new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.conflicting.has("deleted-by-them.txt")).toBe(true);
      expect(diff.conflictingStageStates.get("deleted-by-them.txt")).toBe(
        StageState.DELETED_BY_THEM,
      );
    });
  });

  describe("assume-unchanged", () => {
    it("should track assume-unchanged files", async () => {
      const stagingEntries = [
        createStagingEntry("assumed.txt", "hash123", 0, { assumeValid: true }),
      ];

      const worktreeEntries = [createWorktreeEntry("assumed.txt")];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map()),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate();

      expect(diff.assumeUnchanged.has("assumed.txt")).toBe(true);
    });

    it("should skip assume-unchanged files for modification check", async () => {
      const stagingEntries = [
        createStagingEntry("assumed.txt", "old-hash", 0, { assumeValid: true, size: 100 }),
      ];

      const worktreeEntries = [createWorktreeEntry("assumed.txt", { size: 200 })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["assumed.txt", "new-hash"]])),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate({ respectAssumeUnchanged: true });

      expect(diff.modified.has("assumed.txt")).toBe(false);
    });

    it("should check assume-unchanged files when option disabled", async () => {
      const stagingEntries = [
        createStagingEntry("assumed.txt", "old-hash", 0, { assumeValid: true, size: 100 }),
      ];

      const worktreeEntries = [createWorktreeEntry("assumed.txt", { size: 200 })];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(new Map()),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(worktreeEntries, new Map([["assumed.txt", "new-hash"]])),
      };

      const calculator = createIndexDiffCalculator(deps, undefined);
      const diff = await calculator.calculate({ respectAssumeUnchanged: false });

      expect(diff.modified.has("assumed.txt")).toBe(true);
    });
  });

  describe("nested directories", () => {
    it("should handle files in nested directories", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [{ name: "src", id: "src-tree", mode: FileMode.TREE }]);
      treeEntries.set("src-tree", [{ name: "lib", id: "lib-tree", mode: FileMode.TREE }]);
      treeEntries.set("lib-tree", [
        { name: "utils.ts", id: "utils-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("src/lib/utils.ts", "utils-hash"),
        createStagingEntry("src/lib/new-file.ts", "new-hash"),
      ];

      const worktreeEntries = [
        createWorktreeEntry("src/lib/utils.ts"),
        createWorktreeEntry("src/lib/new-file.ts"),
      ];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(
          worktreeEntries,
          new Map([
            ["src/lib/utils.ts", "utils-hash"],
            ["src/lib/new-file.ts", "new-hash"],
          ]),
        ),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate();

      expect(diff.added.has("src/lib/new-file.ts")).toBe(true);
      expect(diff.changed.has("src/lib/utils.ts")).toBe(false);
    });
  });

  describe("path prefix filtering", () => {
    it("should filter by path prefix", async () => {
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", [
        { name: "src", id: "src-tree", mode: FileMode.TREE },
        { name: "other", id: "other-tree", mode: FileMode.TREE },
      ]);
      treeEntries.set("src-tree", [
        { name: "file.ts", id: "src-file-hash", mode: FileMode.REGULAR_FILE },
      ]);
      treeEntries.set("other-tree", [
        { name: "file.ts", id: "other-file-hash", mode: FileMode.REGULAR_FILE },
      ]);

      const stagingEntries = [
        createStagingEntry("src/file.ts", "src-new-hash"),
        createStagingEntry("other/file.ts", "other-new-hash"),
      ];

      const worktreeEntries = [
        createWorktreeEntry("src/file.ts"),
        createWorktreeEntry("other/file.ts"),
      ];

      const deps: IndexDiffDependencies = {
        trees: createMockTreeStore(treeEntries),
        staging: createMockStaging(stagingEntries),
        worktree: createMockWorktree(
          worktreeEntries,
          new Map([
            ["src/file.ts", "src-new-hash"],
            ["other/file.ts", "other-new-hash"],
          ]),
        ),
      };

      const calculator = createIndexDiffCalculator(deps, "head-tree");
      const diff = await calculator.calculate({ pathPrefix: "src/" });

      expect(diff.changed.has("src/file.ts")).toBe(true);
      expect(diff.changed.has("other/file.ts")).toBe(false);
    });
  });
});
