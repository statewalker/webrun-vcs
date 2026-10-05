/**
 * T3.5: Status Calculation Integration Tests
 *
 * Tests worktree status calculation with realistic scenarios:
 * - Clean state detection
 * - Staged changes (add, modify, delete)
 * - Unstaged changes
 * - Untracked files
 * - Conflict state detection
 */

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

// Test helper to create realistic mocks

interface TestScenario {
  /** Tree entries for HEAD commit */
  headTree: Map<string, TreeEntry[]>;
  /** Index/staging entries */
  staging: StagingEntry[];
  /** Working tree entries */
  worktree: WorktreeEntry[];
  /** Worktree file hashes (for content comparison) */
  worktreeHashes: Map<string, string>;
  /** Optional HEAD commit ID */
  headCommitId?: string;
  /** Conflicted paths */
  conflictPaths?: string[];
}

function createTestContext(scenario: TestScenario) {
  const trees = createMockTreeStore(scenario.headTree);
  const staging = createMockStaging(scenario.staging, scenario.conflictPaths ?? []);
  const worktree = createMockWorktree(scenario.worktree, scenario.worktreeHashes);
  const commits = createMockCommitStore(scenario.headTree.size > 0 ? "root-tree-id" : undefined);
  const refs = createMockRefStore(scenario.headCommitId);

  return createStatusCalculator({
    worktree,
    staging,
    trees,
    commits,
    refs,
  });
}

describe("Status Calculation Integration", () => {
  describe("clean state", () => {
    it("reports clean status when worktree matches HEAD", async () => {
      const fileHash = "abc123def456789012345678901234567890abcd";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "file.txt", mode: FileMode.REGULAR_FILE, id: fileHash }]],
        ]),
        staging: [
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: fileHash,
            size: 100,
            stage: 0,
          },
        ],
        worktree: [
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            size: 100,
            // mtime must be older than indexUpdateTime - 3000 (racily clean detection)
            // indexUpdateTime = Date.now() - 10000, so mtime < Date.now() - 13000
            mtime: Date.now() - 20000,
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([["file.txt", fileHash]]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.isClean).toBe(true);
      expect(result.hasStaged).toBe(false);
      expect(result.hasUnstaged).toBe(false);
      expect(result.hasUntracked).toBe(false);
      expect(result.files).toHaveLength(0); // No changed files
    });

    it("reports clean status with multiple files", async () => {
      const hash1 = "1111111111111111111111111111111111111111";
      const hash2 = "2222222222222222222222222222222222222222";
      const hash3 = "3333333333333333333333333333333333333333";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [
            treeId,
            [
              { name: "a.txt", mode: FileMode.REGULAR_FILE, id: hash1 },
              { name: "b.txt", mode: FileMode.REGULAR_FILE, id: hash2 },
              { name: "c.txt", mode: FileMode.REGULAR_FILE, id: hash3 },
            ],
          ],
        ]),
        staging: [
          { path: "a.txt", mode: FileMode.REGULAR_FILE, objectId: hash1, size: 10, stage: 0 },
          { path: "b.txt", mode: FileMode.REGULAR_FILE, objectId: hash2, size: 20, stage: 0 },
          { path: "c.txt", mode: FileMode.REGULAR_FILE, objectId: hash3, size: 30, stage: 0 },
        ],
        worktree: [
          // mtime must be older than indexUpdateTime - 3000 (racily clean detection)
          {
            path: "a.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now() - 20000,
            isDirectory: false,
            isIgnored: false,
          },
          {
            path: "b.txt",
            mode: FileMode.REGULAR_FILE,
            size: 20,
            mtime: Date.now() - 20000,
            isDirectory: false,
            isIgnored: false,
          },
          {
            path: "c.txt",
            mode: FileMode.REGULAR_FILE,
            size: 30,
            mtime: Date.now() - 20000,
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([
          ["a.txt", hash1],
          ["b.txt", hash2],
          ["c.txt", hash3],
        ]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.isClean).toBe(true);
      expect(result.files).toHaveLength(0);
    });
  });

  describe("staged changes", () => {
    it("detects new staged file", async () => {
      const existingHash = "1111111111111111111111111111111111111111";
      const newHash = "2222222222222222222222222222222222222222";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "existing.txt", mode: FileMode.REGULAR_FILE, id: existingHash }]],
        ]),
        staging: [
          {
            path: "existing.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: existingHash,
            size: 10,
            stage: 0,
          },
          { path: "new.txt", mode: FileMode.REGULAR_FILE, objectId: newHash, size: 20, stage: 0 },
        ],
        worktree: [
          {
            path: "existing.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now() - 10000,
            isDirectory: false,
            isIgnored: false,
          },
          {
            path: "new.txt",
            mode: FileMode.REGULAR_FILE,
            size: 20,
            mtime: Date.now() - 10000,
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([
          ["existing.txt", existingHash],
          ["new.txt", newHash],
        ]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasStaged).toBe(true);
      expect(result.files.find((f) => f.path === "new.txt")?.indexStatus).toBe(FileStatus.ADDED);
    });

    it("detects modified staged file", async () => {
      const originalHash = "1111111111111111111111111111111111111111";
      const modifiedHash = "2222222222222222222222222222222222222222";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "file.txt", mode: FileMode.REGULAR_FILE, id: originalHash }]],
        ]),
        staging: [
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: modifiedHash,
            size: 100,
            stage: 0,
          },
        ],
        worktree: [
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            size: 100,
            mtime: Date.now() - 10000,
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([["file.txt", modifiedHash]]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasStaged).toBe(true);
      const fileEntry = result.files.find((f) => f.path === "file.txt");
      expect(fileEntry?.indexStatus).toBe(FileStatus.MODIFIED);
    });

    it("detects deleted staged file", async () => {
      const hash = "1111111111111111111111111111111111111111";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [
            treeId,
            [
              { name: "keep.txt", mode: FileMode.REGULAR_FILE, id: hash },
              { name: "deleted.txt", mode: FileMode.REGULAR_FILE, id: hash },
            ],
          ],
        ]),
        staging: [
          // deleted.txt is NOT in staging - indicating staged deletion
          { path: "keep.txt", mode: FileMode.REGULAR_FILE, objectId: hash, size: 10, stage: 0 },
        ],
        worktree: [
          {
            path: "keep.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now() - 10000,
            isDirectory: false,
            isIgnored: false,
          },
          // deleted.txt is not in worktree either
        ],
        worktreeHashes: new Map([["keep.txt", hash]]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasStaged).toBe(true);
      const deletedEntry = result.files.find((f) => f.path === "deleted.txt");
      expect(deletedEntry?.indexStatus).toBe(FileStatus.DELETED);
    });
  });

  describe("unstaged changes", () => {
    it("detects modified but not staged", async () => {
      const originalHash = "1111111111111111111111111111111111111111";
      const modifiedHash = "2222222222222222222222222222222222222222";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "file.txt", mode: FileMode.REGULAR_FILE, id: originalHash }]],
        ]),
        staging: [
          // Staging matches HEAD (not staged)
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: originalHash,
            size: 10,
            stage: 0,
          },
        ],
        worktree: [
          // But worktree has different content
          {
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            size: 20,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([["file.txt", modifiedHash]]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasUnstaged).toBe(true);
      const fileEntry = result.files.find((f) => f.path === "file.txt");
      expect(fileEntry?.workTreeStatus).toBe(FileStatus.MODIFIED);
    });

    it("detects deleted but not staged", async () => {
      const hash = "1111111111111111111111111111111111111111";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "file.txt", mode: FileMode.REGULAR_FILE, id: hash }]],
        ]),
        staging: [
          // File still in staging
          { path: "file.txt", mode: FileMode.REGULAR_FILE, objectId: hash, size: 10, stage: 0 },
        ],
        worktree: [
          // But not in worktree
        ],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasUnstaged).toBe(true);
      const fileEntry = result.files.find((f) => f.path === "file.txt");
      expect(fileEntry?.workTreeStatus).toBe(FileStatus.DELETED);
    });
  });

  describe("untracked files", () => {
    it("lists untracked files", async () => {
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([[treeId, []]]), // Empty HEAD
        staging: [], // Empty staging
        worktree: [
          // Untracked files
          {
            path: "untracked1.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
          {
            path: "untracked2.txt",
            mode: FileMode.REGULAR_FILE,
            size: 20,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasUntracked).toBe(true);
      const untracked = result.files.filter((f) => f.workTreeStatus === FileStatus.UNTRACKED);
      expect(untracked).toHaveLength(2);
    });

    it("respects .gitignore (ignored files)", async () => {
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([[treeId, []]]),
        staging: [],
        worktree: [
          {
            path: "tracked.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
          {
            path: "ignored.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: true,
          },
        ],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
      });

      // Default: ignored files not included
      const result = await status.calculateStatus();
      expect(result.files.find((f) => f.path === "ignored.txt")).toBeUndefined();
      expect(result.files.find((f) => f.path === "tracked.txt")).toBeDefined();

      // With includeIgnored: true
      const resultWithIgnored = await status.calculateStatus({ includeIgnored: true });
      const ignoredFile = resultWithIgnored.files.find((f) => f.path === "ignored.txt");
      expect(ignoredFile).toBeDefined();
      expect(ignoredFile?.workTreeStatus).toBe(FileStatus.IGNORED);
    });
  });

  describe("conflict state", () => {
    it("reports conflicted files during merge", async () => {
      const baseHash = "1111111111111111111111111111111111111111";
      const oursHash = "2222222222222222222222222222222222222222";
      const theirsHash = "3333333333333333333333333333333333333333";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "conflict.txt", mode: FileMode.REGULAR_FILE, id: oursHash }]],
        ]),
        staging: [
          // Conflict stages (1 = base, 2 = ours, 3 = theirs)
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: baseHash,
            size: 10,
            stage: 1,
          },
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: oursHash,
            size: 10,
            stage: 2,
          },
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: theirsHash,
            size: 10,
            stage: 3,
          },
        ],
        worktree: [
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            size: 50,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
        conflictPaths: ["conflict.txt"],
      });

      const result = await status.calculateStatus();

      expect(result.hasConflicts).toBe(true);
      const conflicted = result.files.find((f) => f.path === "conflict.txt");
      expect(conflicted?.indexStatus).toBe(FileStatus.CONFLICTED);
    });

    it("identifies conflict with multiple stages present", async () => {
      // The standard calculateStatus() marks files as CONFLICTED based on
      // hasConflicts/getConflictedPaths from staging.
      // Detailed stage info (base/ours/theirs) is available via calculateStatusFromIndexDiff()
      const baseHash = "1111111111111111111111111111111111111111";
      const oursHash = "2222222222222222222222222222222222222222";
      const theirsHash = "3333333333333333333333333333333333333333";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [treeId, [{ name: "conflict.txt", mode: FileMode.REGULAR_FILE, id: oursHash }]],
        ]),
        staging: [
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: baseHash,
            size: 10,
            stage: 1,
          },
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: oursHash,
            size: 10,
            stage: 2,
          },
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: theirsHash,
            size: 10,
            stage: 3,
          },
        ],
        worktree: [
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            size: 50,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
        conflictPaths: ["conflict.txt"],
      });

      const result = await status.calculateStatus();

      // Verify the file is identified as conflicted
      expect(result.hasConflicts).toBe(true);
      const conflicted = result.files.find((f) => f.path === "conflict.txt");
      expect(conflicted).toBeDefined();
      expect(conflicted?.indexStatus).toBe(FileStatus.CONFLICTED);
    });

    it("detects delete-modify conflict scenario", async () => {
      // A delete-modify conflict: file was deleted on our side but modified on theirs
      // The standard calculateStatus() reports this as CONFLICTED without detailed stage info
      const baseHash = "1111111111111111111111111111111111111111";
      const theirsHash = "3333333333333333333333333333333333333333";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([[treeId, []]]), // We deleted
        staging: [
          // Only base and theirs (ours deleted it)
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: baseHash,
            size: 10,
            stage: 1,
          },
          {
            path: "conflict.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: theirsHash,
            size: 10,
            stage: 3,
          },
        ],
        worktree: [],
        worktreeHashes: new Map(),
        headCommitId: "commit-123",
        conflictPaths: ["conflict.txt"],
      });

      const result = await status.calculateStatus();

      // Verify the conflict is detected
      expect(result.hasConflicts).toBe(true);
      const conflicted = result.files.find((f) => f.path === "conflict.txt");
      expect(conflicted).toBeDefined();
      expect(conflicted?.indexStatus).toBe(FileStatus.CONFLICTED);
    });
  });

  describe("combined scenarios", () => {
    it("handles mix of staged and unstaged changes", async () => {
      const hash1 = "1111111111111111111111111111111111111111";
      const hash2 = "2222222222222222222222222222222222222222";
      const hash3 = "3333333333333333333333333333333333333333";
      const treeId = "root-tree-id";

      const status = createTestContext({
        headTree: new Map([
          [
            treeId,
            [
              { name: "staged.txt", mode: FileMode.REGULAR_FILE, id: hash1 },
              { name: "unstaged.txt", mode: FileMode.REGULAR_FILE, id: hash1 },
            ],
          ],
        ]),
        staging: [
          // staged.txt is modified in staging
          { path: "staged.txt", mode: FileMode.REGULAR_FILE, objectId: hash2, size: 10, stage: 0 },
          // unstaged.txt is unchanged in staging
          {
            path: "unstaged.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: hash1,
            size: 10,
            stage: 0,
          },
        ],
        worktree: [
          // staged.txt matches staging
          {
            path: "staged.txt",
            mode: FileMode.REGULAR_FILE,
            size: 10,
            mtime: Date.now() - 10000,
            isDirectory: false,
            isIgnored: false,
          },
          // unstaged.txt is modified in worktree
          {
            path: "unstaged.txt",
            mode: FileMode.REGULAR_FILE,
            size: 20,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
          // new untracked file
          {
            path: "untracked.txt",
            mode: FileMode.REGULAR_FILE,
            size: 5,
            mtime: Date.now(),
            isDirectory: false,
            isIgnored: false,
          },
        ],
        worktreeHashes: new Map([
          ["staged.txt", hash2],
          ["unstaged.txt", hash3],
        ]),
        headCommitId: "commit-123",
      });

      const result = await status.calculateStatus();

      expect(result.hasStaged).toBe(true);
      expect(result.hasUnstaged).toBe(true);
      expect(result.hasUntracked).toBe(true);
      expect(result.isClean).toBe(false);

      expect(result.files.find((f) => f.path === "staged.txt")?.indexStatus).toBe(
        FileStatus.MODIFIED,
      );
      expect(result.files.find((f) => f.path === "unstaged.txt")?.workTreeStatus).toBe(
        FileStatus.MODIFIED,
      );
      expect(result.files.find((f) => f.path === "untracked.txt")?.workTreeStatus).toBe(
        FileStatus.UNTRACKED,
      );
    });
  });

  describe("getStageState helper", () => {
    it("computes correct stage state from flags", () => {
      // All three stages = BOTH_MODIFIED
      expect(getStageState(true, true, true)).toBe(StageState.BOTH_MODIFIED);

      // Only ours and theirs = BOTH_ADDED
      expect(getStageState(false, true, true)).toBe(StageState.BOTH_ADDED);

      // Base + theirs = DELETED_BY_US
      expect(getStageState(true, false, true)).toBe(StageState.DELETED_BY_US);

      // Base + ours = DELETED_BY_THEM
      expect(getStageState(true, true, false)).toBe(StageState.DELETED_BY_THEM);

      // Only base = BOTH_DELETED
      expect(getStageState(true, false, false)).toBe(StageState.BOTH_DELETED);

      // Only ours = ADDED_BY_US
      expect(getStageState(false, true, false)).toBe(StageState.ADDED_BY_US);

      // Only theirs = ADDED_BY_THEM
      expect(getStageState(false, false, true)).toBe(StageState.ADDED_BY_THEM);
    });
  });
});

// --- Mock helpers ---

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
    getUpdateTime: vi.fn().mockReturnValue(Date.now() - 10000),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as Staging;
}

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
    writeContent: vi.fn(),
    remove: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    checkoutTree: vi.fn(),
    checkoutPaths: vi.fn(),
  } as unknown as Worktree;
}

function createMockCommitStore(treeId?: string): Commits {
  return {
    load: vi.fn(),
    store: vi.fn(),
    has: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
    getTree: vi.fn().mockResolvedValue(treeId),
    getParents: vi.fn().mockResolvedValue([]),
    walkAncestry: vi.fn(),
    findMergeBase: vi.fn(),
    isAncestor: vi.fn(),
  } as unknown as Commits;
}

function createMockRefStore(headCommitId?: string): Refs {
  return {
    get: vi
      .fn()
      .mockResolvedValue(
        headCommitId ? { name: "HEAD", target: "refs/heads/main", type: "symbolic" } : undefined,
      ),
    resolve: vi
      .fn()
      .mockResolvedValue(headCommitId ? { name: "HEAD", objectId: headCommitId } : undefined),
    list: vi.fn().mockImplementation(async function* () {}),
    has: vi.fn().mockResolvedValue(!!headCommitId),
    set: vi.fn(),
    setSymbolic: vi.fn(),
    remove: vi.fn(),
    compareAndSwap: vi.fn().mockResolvedValue({ success: true }),
    initialize: vi.fn(),
    optimize: vi.fn(),
    getReflog: vi.fn(),
    packRefs: vi.fn(),
  } as unknown as Refs;
}
