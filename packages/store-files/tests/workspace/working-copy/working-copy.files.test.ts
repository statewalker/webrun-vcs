import {
  type Blobs,
  type Commits,
  FileMode,
  type History,
  type Refs,
  type TreeEntry,
  type Trees,
} from "@statewalker/vcs-core";
import { GitWorkingCopy, type WorkingCopyFilesApi } from "@statewalker/vcs-store-files";
import {
  type Checkout,
  FileStatus,
  MemoryStashStore,
  type Staging,
  type StagingEntry,
  type Worktree,
  type WorktreeEntry,
} from "@statewalker/vcs-working-tree";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Create mock files API
 */
function createMockFilesApi(): WorkingCopyFilesApi {
  return {
    readFile: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(false),
    readDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkingCopyFilesApi;
}

/**
 * Create mock tree store (Trees interface)
 */
function createMockTreeStore(entries: Map<string, TreeEntry[]>): Trees {
  return {
    // New Trees interface
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
 * Create mock staging interface
 */
function createMockStaging(
  stagingEntries: StagingEntry[] = [],
  conflictPaths: string[] = [],
): Staging {
  return {
    // New Staging interface methods
    entries: vi.fn().mockImplementation(async function* () {
      for (const entry of stagingEntries) {
        yield entry;
      }
    }),
    getEntry: vi.fn().mockImplementation(async (path: string) => {
      return stagingEntries.find((e) => e.path === path && e.stage === 0);
    }),
    getEntries: vi.fn().mockImplementation(async (path: string) => {
      return stagingEntries.filter((e) => e.path === path);
    }),
    setEntry: vi.fn(),
    removeEntry: vi.fn(),
    hasEntry: vi.fn(),
    getEntryCount: vi.fn().mockResolvedValue(stagingEntries.length),
    hasConflicts: vi.fn().mockResolvedValue(conflictPaths.length > 0),
    getConflictedPaths: vi.fn().mockResolvedValue(conflictPaths),
    resolveConflict: vi.fn(),
    createBuilder: vi.fn(),
    createEditor: vi.fn(),
    clear: vi.fn(),
    writeTree: vi.fn(),
    readTree: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    isOutdated: vi.fn(),
    getUpdateTime: vi.fn().mockReturnValue(Date.now() - 10000),
  } as unknown as Staging;
}

/**
 * Create mock worktree interface
 */
function createMockWorktree(
  entries: WorktreeEntry[] = [],
  hashes: Map<string, string> = new Map(),
): Worktree {
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
    readContent: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    isIgnored: vi.fn().mockResolvedValue(false),
    writeContent: vi.fn(),
    remove: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    checkoutTree: vi.fn(),
    checkoutPaths: vi.fn(),
    getRoot: vi.fn().mockReturnValue("/repo"),
    refreshIgnore: vi.fn(),
  } as unknown as Worktree;
}

/**
 * Create mock commit store
 */
function createMockCommitStore(trees: Map<string, string> = new Map()): Commits {
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
 * Create mock ref store
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
 * Create mock blob store
 */
function createMockBlobStore(): Blobs {
  return {
    store: vi.fn(),
    load: vi.fn(),
    has: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
    size: vi.fn(),
  } as unknown as Blobs;
}

/**
 * Create mock history interface
 */
function createMockHistory(options: {
  headCommit?: string;
  branch?: string;
  treeEntries?: Map<string, TreeEntry[]>;
  commitTrees?: Map<string, string>;
}): History {
  const { headCommit, branch = "main", treeEntries = new Map(), commitTrees = new Map() } = options;

  return {
    refs: createMockRefStore(headCommit, branch),
    trees: createMockTreeStore(treeEntries),
    commits: createMockCommitStore(commitTrees),
    blobs: createMockBlobStore(),
    tags: {} as unknown,
    objects: {} as unknown,
    config: {},
    close: vi.fn(),
    isInitialized: vi.fn().mockResolvedValue(true),
    initialize: vi.fn(),
  } as unknown as History;
}

/**
 * Create mock checkout interface
 */
function createMockCheckout(staging: Staging, headCommit?: string, branch?: string): Checkout {
  return {
    staging,
    stash: undefined,
    config: undefined,
    getHead: vi.fn().mockImplementation(async () => {
      if (branch) {
        return { type: "symbolic", target: `refs/heads/${branch}` };
      }
      if (headCommit) {
        return { type: "detached", commitId: headCommit };
      }
      return { type: "symbolic", target: "refs/heads/main" };
    }),
    setHead: vi.fn(),
    getHeadCommit: vi.fn().mockResolvedValue(headCommit),
    getCurrentBranch: vi.fn().mockResolvedValue(branch),
    isDetached: vi.fn().mockResolvedValue(!branch),
    getOperationState: vi.fn().mockResolvedValue(undefined),
    hasOperationInProgress: vi.fn().mockResolvedValue(false),
    getMergeState: vi.fn().mockResolvedValue(undefined),
    setMergeState: vi.fn(),
    getMergeHead: vi.fn().mockResolvedValue(undefined),
    getRebaseState: vi.fn().mockResolvedValue(undefined),
    setRebaseState: vi.fn(),
    getCherryPickState: vi.fn().mockResolvedValue(undefined),
    setCherryPickState: vi.fn(),
    getRevertState: vi.fn().mockResolvedValue(undefined),
    setRevertState: vi.fn(),
    abortOperation: vi.fn(),
    initialize: vi.fn(),
    refresh: vi.fn(),
    close: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(true),
  } as unknown as Checkout;
}

/**
 * Create staging entry helper
 */
function createStagingEntry(
  path: string,
  objectId: string,
  options: Partial<StagingEntry> = {},
): StagingEntry {
  return {
    path,
    objectId,
    mode: FileMode.REGULAR_FILE,
    stage: 0,
    size: 100,
    mtime: Date.now() - 10000,
    ...options,
  };
}

/**
 * Create working tree entry helper
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

describe("GitWorkingCopy", () => {
  let workingCopy: GitWorkingCopy;
  let mockHistory: History;
  let mockCheckout: Checkout;
  let mockWorktree: Worktree;
  let mockStaging: Staging;
  let mockStash: MemoryStashStore;
  let mockFiles: WorkingCopyFilesApi;

  beforeEach(() => {
    mockHistory = createMockHistory({
      headCommit: "abc123",
      branch: "main",
    });
    mockStaging = createMockStaging();
    mockCheckout = createMockCheckout(mockStaging, "abc123", "main");
    mockWorktree = createMockWorktree();
    mockStash = new MemoryStashStore();
    mockFiles = createMockFilesApi();

    workingCopy = new GitWorkingCopy({
      history: mockHistory,
      checkout: mockCheckout,
      worktree: mockWorktree,
      stash: mockStash,
      config: {},
      files: mockFiles,
      gitDir: "/repo/.git",
    });
  });

  describe("getHead", () => {
    it("should return commit ID from refs", async () => {
      const head = await workingCopy.getHead();
      expect(head).toBe("abc123");
    });

    it("should return undefined when no HEAD", async () => {
      mockHistory = createMockHistory({});
      mockStaging = createMockStaging();
      mockCheckout = createMockCheckout(mockStaging, undefined, undefined);
      vi.mocked(mockCheckout.getHeadCommit).mockResolvedValue(undefined);

      workingCopy = new GitWorkingCopy({
        history: mockHistory,
        checkout: mockCheckout,
        worktree: mockWorktree,
        stash: mockStash,
        config: {},
        files: mockFiles,
        gitDir: "/repo/.git",
      });

      const head = await workingCopy.getHead();
      expect(head).toBeUndefined();
    });
  });

  describe("getCurrentBranch", () => {
    it("should return branch name", async () => {
      const branch = await workingCopy.getCurrentBranch();
      expect(branch).toBe("main");
    });

    it("should return undefined when detached HEAD", async () => {
      vi.mocked(mockCheckout.getCurrentBranch).mockResolvedValue(undefined);
      vi.mocked(mockCheckout.isDetached).mockResolvedValue(true);

      const branch = await workingCopy.getCurrentBranch();
      expect(branch).toBeUndefined();
    });
  });

  describe("getStatus - StatusCalculator integration", () => {
    it("should return clean status for empty repository", async () => {
      const status = await workingCopy.getStatus();

      expect(status.files).toEqual([]);
      expect(status.isClean).toBe(true);
      expect(status.hasStaged).toBe(false);
      expect(status.hasUnstaged).toBe(false);
      expect(status.hasUntracked).toBe(false);
      expect(status.branch).toBe("main");
    });

    it("should detect added file in staging", async () => {
      // Set up repository with head commit and tree
      const treeEntries = new Map<string, TreeEntry[]>();
      treeEntries.set("head-tree", []);

      const commitTrees = new Map<string, string>();
      commitTrees.set("head-commit", "head-tree");

      mockHistory = createMockHistory({
        headCommit: "head-commit",
        branch: "main",
        treeEntries,
        commitTrees,
      });

      // Add file to staging
      const stagingEntries = [createStagingEntry("new-file.txt", "new-hash")];
      mockStaging = createMockStaging(stagingEntries);
      mockCheckout = createMockCheckout(mockStaging, "head-commit", "main");

      // Add file to worktree
      const worktreeEntries = [createWorktreeEntry("new-file.txt")];
      const worktreeHashes = new Map([["new-file.txt", "new-hash"]]);
      mockWorktree = createMockWorktree(worktreeEntries, worktreeHashes);

      workingCopy = new GitWorkingCopy({
        history: mockHistory,
        checkout: mockCheckout,
        worktree: mockWorktree,
        stash: mockStash,
        config: {},
        files: mockFiles,
        gitDir: "/repo/.git",
      });

      const status = await workingCopy.getStatus();

      expect(status.hasStaged).toBe(true);
      expect(
        status.files.some((f) => f.path === "new-file.txt" && f.indexStatus === FileStatus.ADDED),
      ).toBe(true);
    });

    it("should detect untracked files", async () => {
      // Add untracked file to worktree
      const worktreeEntries = [createWorktreeEntry("untracked.txt")];
      mockWorktree = createMockWorktree(worktreeEntries);

      workingCopy = new GitWorkingCopy({
        history: mockHistory,
        checkout: mockCheckout,
        worktree: mockWorktree,
        stash: mockStash,
        config: {},
        files: mockFiles,
        gitDir: "/repo/.git",
      });

      const status = await workingCopy.getStatus();

      expect(status.hasUntracked).toBe(true);
      expect(
        status.files.some(
          (f) => f.path === "untracked.txt" && f.workTreeStatus === FileStatus.UNTRACKED,
        ),
      ).toBe(true);
    });

    it("should detect conflicts", async () => {
      mockStaging = createMockStaging([], ["conflict.txt"]);
      mockCheckout = createMockCheckout(mockStaging, "abc123", "main");

      const worktreeEntries = [createWorktreeEntry("conflict.txt")];
      mockWorktree = createMockWorktree(worktreeEntries);

      workingCopy = new GitWorkingCopy({
        history: mockHistory,
        checkout: mockCheckout,
        worktree: mockWorktree,
        stash: mockStash,
        config: {},
        files: mockFiles,
        gitDir: "/repo/.git",
      });

      const status = await workingCopy.getStatus();

      expect(status.hasConflicts).toBe(true);
    });

    it("should respect status options like includeUntracked", async () => {
      const worktreeEntries = [createWorktreeEntry("untracked.txt")];
      mockWorktree = createMockWorktree(worktreeEntries);

      workingCopy = new GitWorkingCopy({
        history: mockHistory,
        checkout: mockCheckout,
        worktree: mockWorktree,
        stash: mockStash,
        config: {},
        files: mockFiles,
        gitDir: "/repo/.git",
      });

      const status = await workingCopy.getStatus({ includeUntracked: false });

      expect(status.files.some((f) => f.path === "untracked.txt")).toBe(false);
    });
  });

  describe("setHead", () => {
    it("should set HEAD to branch", async () => {
      await workingCopy.setHead("feature");

      expect(mockCheckout.setHead).toHaveBeenCalledWith({
        type: "symbolic",
        target: "refs/heads/feature",
      });
    });

    it("should set HEAD to full ref path", async () => {
      await workingCopy.setHead("refs/heads/develop");

      expect(mockCheckout.setHead).toHaveBeenCalledWith({
        type: "symbolic",
        target: "refs/heads/develop",
      });
    });

    it("should set detached HEAD for commit ID", async () => {
      const commitId = "abcdef1234567890abcdef1234567890abcdef12";
      await workingCopy.setHead(commitId);

      expect(mockCheckout.setHead).toHaveBeenCalledWith({
        type: "detached",
        commitId,
      });
    });
  });

  describe("isDetachedHead", () => {
    it("should return false when on branch", async () => {
      vi.mocked(mockCheckout.isDetached).mockResolvedValue(false);

      expect(await workingCopy.isDetachedHead()).toBe(false);
    });

    it("should return true when detached", async () => {
      vi.mocked(mockCheckout.isDetached).mockResolvedValue(true);

      expect(await workingCopy.isDetachedHead()).toBe(true);
    });
  });
});
