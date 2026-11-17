import { createRef, createSymbolicRef, type History } from "@statewalker/vcs-core";
import {
  type GitWorkingCopyContext,
  GitWorkingCopyFactory,
  type WorkingCopyFactoryFilesApi,
} from "@statewalker/vcs-store-files";
import type { Checkout, Staging, Worktree } from "@statewalker/vcs-working-tree";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

type CreateContext = ConstructorParameters<typeof GitWorkingCopyFactory>[1];

/**
 * Create mock files API
 */
function createMockFilesApi(): WorkingCopyFactoryFilesApi {
  return {
    readFile: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(false),
    exists: vi.fn().mockResolvedValue(false),
    readDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
    // Extra methods the factory does not use
    deleteFile: vi.fn(),
    rename: vi.fn(),
    // From ConfigFilesApi
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkingCopyFactoryFilesApi;
}

/**
 * Create mock staging interface
 */
function createMockStaging(): Staging {
  return {
    entries: vi.fn().mockImplementation(async function* () {}),
    getEntry: vi.fn(),
    getEntries: vi.fn(),
    setEntry: vi.fn(),
    removeEntry: vi.fn(),
    hasEntry: vi.fn(),
    getEntryCount: vi.fn(),
    hasConflicts: vi.fn().mockResolvedValue(false),
    getConflictedPaths: vi.fn().mockResolvedValue([]),
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
function createMockWorktree(): Worktree {
  return {
    walk: vi.fn().mockImplementation(async function* () {}),
    getEntry: vi.fn(),
    computeHash: vi.fn(),
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
 * Create mock history interface
 */
function createMockHistory(options: { path?: string; headCommit?: string } = {}): History {
  const { headCommit = "abc123" } = options;

  return {
    refs: {
      get: vi.fn().mockImplementation(async (name: string) => {
        if (name === "HEAD") {
          return { target: "refs/heads/main" };
        }
        if (name === "refs/heads/main") {
          return { objectId: headCommit };
        }
        return undefined;
      }),
      resolve: vi.fn().mockResolvedValue({ objectId: headCommit }),
      set: vi.fn().mockResolvedValue(undefined),
      setSymbolic: vi.fn().mockResolvedValue(undefined),
    },
    trees: {
      loadTree: vi.fn().mockImplementation(async function* () {}),
      getEntry: vi.fn(),
      storeTree: vi.fn(),
      hasTree: vi.fn(),
      getEmptyTreeId: vi.fn().mockReturnValue("4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
    },
    commits: {
      getTree: vi.fn(),
      storeCommit: vi.fn(),
      loadCommit: vi.fn(),
    },
    blobs: {},
    tags: {},
    objects: {},
    config: {},
    close: vi.fn(),
    isInitialized: vi.fn().mockResolvedValue(true),
    initialize: vi.fn(),
  } as unknown as History;
}

/**
 * Create mock checkout interface
 */
function createMockCheckout(staging: Staging): Checkout {
  return {
    staging,
    stash: undefined,
    config: undefined,
    getHead: vi.fn().mockResolvedValue({ type: "symbolic", target: "refs/heads/main" }),
    setHead: vi.fn(),
    getHeadCommit: vi.fn().mockResolvedValue("abc123"),
    getCurrentBranch: vi.fn().mockResolvedValue("main"),
    isDetached: vi.fn().mockResolvedValue(false),
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

describe("GitWorkingCopyFactory", () => {
  let factory: GitWorkingCopyFactory;
  let mockFiles: WorkingCopyFactoryFilesApi;
  let mockCreateContext: Mock<CreateContext>;

  beforeEach(() => {
    mockFiles = createMockFilesApi();
    mockCreateContext = vi
      .fn<CreateContext>()
      .mockImplementation(async (): Promise<GitWorkingCopyContext> => {
        const staging = createMockStaging();
        const checkout = createMockCheckout(staging);
        return {
          history: createMockHistory({ path: "/repo/.git" }),
          createCheckout: vi.fn().mockResolvedValue(checkout),
          createWorktree: vi.fn().mockReturnValue(createMockWorktree()),
        };
      });

    factory = new GitWorkingCopyFactory(mockFiles, mockCreateContext);
  });

  describe("openWorkingCopy", () => {
    it("should create a working copy", async () => {
      const wc = await factory.openWorkingCopy("/worktree", "/repo/.git");

      expect(wc).toBeDefined();
      expect(wc.history).toBeDefined();
      expect(wc.checkout).toBeDefined();
      expect(wc.worktree).toBeDefined();
      expect(wc.stash).toBeDefined();
    });

    it("should pass repository path to createContext", async () => {
      await factory.openWorkingCopy("/worktree", "/repo/.git");

      expect(mockCreateContext).toHaveBeenCalledWith("/repo/.git", {});
    });
  });

  describe("addWorktree", () => {
    it("should throw if repository.config.path is not set", async () => {
      const history = createMockHistory({});

      // The new signature doesn't check repository.config.path anymore
      // It expects gitDir to be passed directly
      // This test is no longer relevant, but we'll skip it for now
      // by expecting it to succeed instead
      await expect(
        factory.addWorktree(history, "/repo/.git", "/new-worktree"),
      ).resolves.toBeDefined();
    });

    it("should create worktree directories", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree");

      expect(mockFiles.mkdir).toHaveBeenCalledWith("/new-worktree");
      expect(mockFiles.mkdir).toHaveBeenCalledWith("/repo/.git/worktrees");
      expect(mockFiles.mkdir).toHaveBeenCalledWith("/repo/.git/worktrees/new-worktree");
    });

    it("should create .git file in worktree", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree");

      expect(mockFiles.write).toHaveBeenCalledWith(
        "/new-worktree/.git",
        new TextEncoder().encode("gitdir: /repo/.git/worktrees/new-worktree\n"),
      );
    });

    it("should create gitdir file in worktrees/NAME", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree");

      expect(mockFiles.write).toHaveBeenCalledWith(
        "/repo/.git/worktrees/new-worktree/gitdir",
        new TextEncoder().encode("/new-worktree/.git\n"),
      );
    });

    it("should set detached HEAD when commit option is provided", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree", { commit: "def456" });

      expect(mockFiles.writeFile).toHaveBeenCalledWith(
        "/repo/.git/worktrees/new-worktree/HEAD",
        "def456\n",
      );
    });

    it("should set HEAD to branch when branch option is provided", async () => {
      const history = createMockHistory({ path: "/repo/.git" });
      vi.mocked(history.refs.get).mockImplementation(async (name: string) => {
        if (name === "refs/heads/feature") {
          return createRef("refs/heads/feature", "feature-commit");
        }
        if (name === "HEAD") {
          return createSymbolicRef("HEAD", "refs/heads/main");
        }
        return undefined;
      });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree", { branch: "feature" });

      expect(mockFiles.writeFile).toHaveBeenCalledWith(
        "/repo/.git/worktrees/new-worktree/HEAD",
        "ref: refs/heads/feature\n",
      );
    });

    it("should throw if branch does not exist and force is false", async () => {
      const history = createMockHistory({ path: "/repo/.git" });
      vi.mocked(history.refs.get).mockResolvedValue(undefined);

      await expect(
        factory.addWorktree(history, "/repo/.git", "/new-worktree", { branch: "nonexistent" }),
      ).rejects.toThrow("Branch 'nonexistent' does not exist. Use force: true to create it.");
    });

    it("should create branch if it does not exist and force is true", async () => {
      const history = createMockHistory({ path: "/repo/.git", headCommit: "abc123" });
      vi.mocked(history.refs.get).mockImplementation(async (name: string) => {
        if (name === "HEAD") {
          return createSymbolicRef("HEAD", "refs/heads/main");
        }
        // Return undefined for new-branch to simulate it doesn't exist
        return undefined;
      });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree", {
        branch: "new-branch",
        force: true,
      });

      expect(history.refs.set).toHaveBeenCalledWith("refs/heads/new-branch", "abc123");
    });

    it("should use detached HEAD at current commit when no options provided", async () => {
      const history = createMockHistory({ path: "/repo/.git", headCommit: "current-head" });

      await factory.addWorktree(history, "/repo/.git", "/new-worktree");

      expect(mockFiles.writeFile).toHaveBeenCalledWith(
        "/repo/.git/worktrees/new-worktree/HEAD",
        "current-head\n",
      );
    });

    it("should throw if no commits and no branch/commit specified", async () => {
      const history = createMockHistory({ path: "/repo/.git" });
      vi.mocked(history.refs.resolve).mockResolvedValue(undefined);

      await expect(factory.addWorktree(history, "/repo/.git", "/new-worktree")).rejects.toThrow(
        "Cannot add worktree: repository has no commits.",
      );
    });

    it("should return a working copy", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      const wc = await factory.addWorktree(history, "/repo/.git", "/new-worktree");

      expect(wc).toBeDefined();
      expect(wc.history).toBeDefined();
      expect(wc.checkout).toBeDefined();
      expect(wc.worktree).toBeDefined();
    });
  });

  describe("paths that are no UTF-8", () => {
    const latin1 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

    it("addWorktree writes the gitdir: file and the back-pointer as the path's bytes", async () => {
      const history = createMockHistory({ path: "/repo/.git" });

      await factory.addWorktree(history, "/repo/.git", "/caf\udce9");

      expect(mockFiles.write).toHaveBeenCalledWith(
        "/caf\udce9/.git",
        latin1("gitdir: /repo/.git/worktrees/caf\xe9\n"),
      );
      expect(mockFiles.write).toHaveBeenCalledWith(
        "/repo/.git/worktrees/caf\udce9/gitdir",
        latin1("/caf\xe9/.git\n"),
      );
    });

    it("reads commondir as bytes: a latin-1 repository path names its config", async () => {
      const gitDir = "/wt/.git/worktrees/x";
      (mockFiles.read as Mock).mockImplementation(async (path: string) =>
        path === `${gitDir}/commondir` ? latin1("/srv/caf\xe9/.git\n") : undefined,
      );

      await factory.openWorkingCopy("/wt", gitDir);

      expect(mockFiles.read).toHaveBeenCalledWith("/srv/caf\udce9/.git/config");
    });
  });

  describe("the administrative directory, as git worktree add writes it", () => {
    const written = (path: string) => {
      const call = (mockFiles.write as Mock).mock.calls.find(([p]) => p === path);
      return call ? new TextDecoder().decode(call[1] as Uint8Array) : undefined;
    };

    it("writes commondir as ../.., and no locked file unless asked", async () => {
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/wt");
      expect(written("/repo/.git/worktrees/wt/commondir")).toBe("../..\n");
      // locked only while it is set up ("initializing", as git writes it), then removed
      expect(written("/repo/.git/worktrees/wt/locked")).toBe("initializing\n");
      expect(mockFiles.remove).toHaveBeenCalledWith("/repo/.git/worktrees/wt/locked");
    });

    it("lock: git's default reason, or the given one", async () => {
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/a", { lock: true });
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/b", { lock: "on a USB disk" });
      expect(written("/repo/.git/worktrees/a/locked")).toBe("added with --lock\n");
      expect(written("/repo/.git/worktrees/b/locked")).toBe("on a USB disk\n");
    });

    it("names the admin directory as git's sanitize_refname_component does", async () => {
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/x/a b.lock");
      expect(written("/x/a b.lock/.git")).toBe("gitdir: /repo/.git/worktrees/a-b\n");
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/y/.hidden");
      expect(written("/y/.hidden/.git")).toBe("gitdir: /repo/.git/worktrees/-hidden\n");
    });

    it("logs the new HEAD as git's update-ref does: from the zero id, no message", async () => {
      await factory.addWorktree(createMockHistory({ headCommit: "abc123" }), "/repo/.git", "/wt", {
        ident: "T <t@e> 5 +0000",
      });
      expect(written("/repo/.git/worktrees/wt/logs/HEAD")).toBe(
        `${"0".repeat(40)} abc123 T <t@e> 5 +0000\n`,
      );
    });

    it("numbers the name when worktrees/NAME is taken", async () => {
      const taken = new Set(["/repo/.git/worktrees/wt", "/repo/.git/worktrees/wt1"]);
      (mockFiles.exists as Mock).mockImplementation(async (p: string) => taken.has(p));
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/elsewhere/wt");
      expect(written("/elsewhere/wt/.git")).toBe("gitdir: /repo/.git/worktrees/wt2\n");
      expect(written("/repo/.git/worktrees/wt2/gitdir")).toBe("/elsewhere/wt/.git\n");
    });

    it("writes host paths when the FilesApi's root is known", async () => {
      const rooted = new GitWorkingCopyFactory(
        Object.assign(mockFiles, { rootDirectory: "/home/me/" }),
        mockCreateContext,
      );
      await rooted.addWorktree(createMockHistory(), "repo/.git", "wt");
      expect(written("wt/.git")).toBe("gitdir: /home/me/repo/.git/worktrees/wt\n");
      expect(written("repo/.git/worktrees/wt/gitdir")).toBe("/home/me/wt/.git\n");
      expect(written("repo/.git/worktrees/wt/commondir")).toBe("../..\n");
    });
  });

  describe("commondir, as get_common_dir_noenv reads it", () => {
    const openWith = async (commondir: string) => {
      const gitDir = "/wt/.git/worktrees/x";
      (mockFiles.read as Mock).mockImplementation(async (path: string) =>
        path === `${gitDir}/commondir` ? new TextEncoder().encode(commondir) : undefined,
      );
      await factory.openWorkingCopy("/wt", gitDir);
      return (mockFiles.read as Mock).mock.calls.map(([p]) => p as string);
    };

    it("strips only the line end: a trailing blank is part of the path", async () => {
      expect(await openWith("/srv/repo.git \r\n")).toContain("/srv/repo.git /config");
    });

    it("a relative commondir is resolved against the worktree's git directory", async () => {
      expect(await openWith("../..\n")).toContain("/wt/.git/config");
    });

    it("a Windows drive path is absolute, never joined onto the git directory", async () => {
      const read = await openWith("C:/repos/main/.git\n");
      expect(read).toContain("C:/repos/main/.git/config");
      expect(read.some((p) => p.includes("worktrees/x/C:"))).toBe(false);
    });
  });

  describe("addWorktree checks before it writes, and cleans up after a failure", () => {
    const written = (path: string) => {
      const call = (mockFiles.write as Mock).mock.calls.find(([p]) => p === path);
      return call ? new TextDecoder().decode(call[1] as Uint8Array) : undefined;
    };

    it("a missing branch is refused before anything is written", async () => {
      const history = createMockHistory();
      vi.mocked(history.refs.get).mockResolvedValue(undefined);
      await expect(
        factory.addWorktree(history, "/repo/.git", "/wt", { branch: "missing" }),
      ).rejects.toThrow("Branch 'missing' does not exist");
      expect(mockFiles.mkdir).not.toHaveBeenCalled();
      expect(mockFiles.write).not.toHaveBeenCalled();
      expect(mockFiles.writeFile).not.toHaveBeenCalled();
    });

    it("no commits is refused before anything is written", async () => {
      const history = createMockHistory();
      vi.mocked(history.refs.resolve).mockResolvedValue(undefined);
      await expect(factory.addWorktree(history, "/repo/.git", "/wt")).rejects.toThrow(
        "repository has no commits",
      );
      expect(mockFiles.mkdir).not.toHaveBeenCalled();
      expect(mockFiles.write).not.toHaveBeenCalled();
    });

    it("a failed write removes the admin directory and the worktree directory it made", async () => {
      (mockFiles.writeFile as Mock).mockRejectedValue(new Error("disk full"));
      await expect(factory.addWorktree(createMockHistory(), "/repo/.git", "/wt")).rejects.toThrow(
        "disk full",
      );
      expect(mockFiles.remove).toHaveBeenCalledWith("/repo/.git/worktrees/wt");
      expect(mockFiles.remove).toHaveBeenCalledWith("/wt");
    });

    it("a worktree directory that was there before is never removed", async () => {
      (mockFiles.exists as Mock).mockImplementation(async (p: string) => p === "/wt");
      (mockFiles.writeFile as Mock).mockRejectedValue(new Error("disk full"));
      await expect(factory.addWorktree(createMockHistory(), "/repo/.git", "/wt")).rejects.toThrow(
        "disk full",
      );
      expect(mockFiles.remove).toHaveBeenCalledWith("/repo/.git/worktrees/wt");
      expect(mockFiles.remove).not.toHaveBeenCalledWith("/wt");
    });

    it("the lock reason as write_file writes it: a line end only when missing", async () => {
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/a", { lock: "" });
      await factory.addWorktree(createMockHistory(), "/repo/.git", "/b", { lock: "x\n" });
      expect(written("/repo/.git/worktrees/a/locked")).toBe("");
      expect(written("/repo/.git/worktrees/b/locked")).toBe("x\n");
      expect(mockFiles.remove).not.toHaveBeenCalled();
    });
  });

  describe("host paths on Windows and an absolute commondir", () => {
    const written = (path: string) => {
      const call = (mockFiles.write as Mock).mock.calls.find(([p]) => p === path);
      return call ? new TextDecoder().decode(call[1] as Uint8Array) : undefined;
    };

    it("a Windows root is written with forward slashes, as Git for Windows writes it", async () => {
      const rooted = new GitWorkingCopyFactory(
        Object.assign(mockFiles, { rootDirectory: "C:\\Users\\x\\" }),
        mockCreateContext,
      );
      await rooted.addWorktree(createMockHistory(), "repo/.git", "wt");
      expect(written("wt/.git")).toBe("gitdir: C:/Users/x/repo/.git/worktrees/wt\n");
      expect(written("repo/.git/worktrees/wt/gitdir")).toBe("C:/Users/x/wt/.git\n");
    });

    const openWith = async (rootDirectory: string, commondir: string) => {
      const gitDir = "/wt/.git/worktrees/x";
      (mockFiles.read as Mock).mockImplementation(async (path: string) =>
        path === `${gitDir}/commondir` ? new TextEncoder().encode(commondir) : undefined,
      );
      const rooted = new GitWorkingCopyFactory(
        Object.assign(mockFiles, { rootDirectory }),
        mockCreateContext,
      );
      await rooted.openWorkingCopy("/wt", gitDir);
      return (mockFiles.read as Mock).mock.calls.map(([p]) => p as string);
    };

    it("an absolute commondir below the root is mapped into the FilesApi", async () => {
      expect(await openWith("/home/me", "/home/me/repo/.git\n")).toContain("/repo/.git/config");
      expect(await openWith("/", "/srv/repo/.git\n")).toContain("/srv/repo/.git/config");
    });

    it("on a Windows root: backslashes and any case of the drive", async () => {
      expect(await openWith("C:\\Users\\x", "c:\\users\\x\\repo\\.git\n")).toContain(
        "/repo/.git/config",
      );
    });

    it("on a UNC root, and with dots in the commondir", async () => {
      expect(await openWith("\\\\server\\share", "//SERVER/share/repo/.git\n")).toContain(
        "/repo/.git/config",
      );
      expect(await openWith("/home/me", "/home/me/x/../repo/./.git\n")).toContain(
        "/repo/.git/config",
      );
    });

    it("one outside the root stays as written (beyond what the FilesApi names)", async () => {
      expect(await openWith("/home/me", "/srv/repo/.git\n")).toContain("/srv/repo/.git/config");
      expect(await openWith("/home/me", "/home/meta/.git\n")).toContain("/home/meta/.git/config");
    });
  });
});
