/**
 * Integration tests for RepositoryController.
 *
 * Tests the commit history update flow using models and controllers
 * with in-memory Git repositories and mocked WebRTC APIs.
 */

import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueAddFileAction,
  enqueueInitRepoAction,
  enqueueRefreshRepoAction,
} from "../src/actions/index.js";
import type { PeerConnection, PeerInstance, PeerJsApi } from "../src/apis/index.js";
import { MockTimerApi, setPeerJsApi, setTimerApi } from "../src/apis/index.js";
import type { AppContext } from "../src/controllers/index.js";
import {
  createRepositoryController,
  getGit,
  getWorktree,
  setGit,
  setHistory,
  setWorkingCopy,
  setWorktree,
} from "../src/controllers/index.js";
import {
  getActivityLogModel,
  getPeersModel,
  getRepositoryModel,
  getSessionModel,
  getSyncModel,
  getUserActionsModel,
} from "../src/models/index.js";

/**
 * Mock PeerConnection for testing.
 */
class MockPeerConnection implements PeerConnection {
  readonly peer: string;
  open = false;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(peerId: string) {
    this.peer = peerId;
  }

  send(_data: ArrayBuffer | Uint8Array): void {
    // Mock send - does nothing in tests
  }

  close(): void {
    this.open = false;
    this.emit("close");
  }

  on(event: "open", handler: () => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "data", handler: (data: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: ((...args: unknown[]) => void) | (() => void)): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as (...args: unknown[]) => void);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  // Test helper: emit an event
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) {
      h(...args);
    }
  }

  // Test helper: simulate connection open
  simulateOpen(): void {
    this.open = true;
    this.emit("open");
  }
}

/**
 * Mock PeerInstance for testing.
 */
class MockPeerInstance implements PeerInstance {
  readonly id: string;
  open = false;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private connections: MockPeerConnection[] = [];

  constructor(id: string) {
    this.id = id;
  }

  connect(
    peerId: string,
    _options?: { serialization?: string; reliable?: boolean },
  ): PeerConnection {
    const conn = new MockPeerConnection(peerId);
    this.connections.push(conn);
    return conn;
  }

  destroy(): void {
    this.open = false;
    for (const c of this.connections) {
      c.close();
    }
    this.connections = [];
    this.emit("close");
  }

  on(event: "open", handler: (id: string) => void): void;
  on(event: "connection", handler: (conn: PeerConnection) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "disconnected", handler: () => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: ((...args: unknown[]) => void) | (() => void)): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as (...args: unknown[]) => void);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  // Test helper: emit an event
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) {
      h(...args);
    }
  }

  // Test helper: simulate peer ready
  simulateOpen(): void {
    this.open = true;
    this.emit("open", this.id);
  }
}

/**
 * Mock PeerJsApi for testing.
 */
class MockPeerJsApi implements PeerJsApi {
  private peers: MockPeerInstance[] = [];
  private nextId = 1;

  createPeer(id?: string): PeerInstance {
    const peerId = id ?? `mock-peer-${this.nextId++}`;
    const peer = new MockPeerInstance(peerId);
    this.peers.push(peer);
    return peer;
  }

  // Test helper: get all created peers
  getPeers(): MockPeerInstance[] {
    return this.peers;
  }

  // Test helper: reset
  reset(): void {
    for (const p of this.peers) {
      p.destroy();
    }
    this.peers = [];
    this.nextId = 1;
  }
}

/**
 * Create a test context with in-memory Git infrastructure.
 * Uses the new Three-Part Architecture (History/Checkout/Worktree).
 */
async function createTestAppContext(): Promise<AppContext> {
  const ctx: AppContext = {};

  // Initialize all models
  getSessionModel(ctx);
  getPeersModel(ctx);
  getSyncModel(ctx);
  getRepositoryModel(ctx);
  getActivityLogModel(ctx);
  getUserActionsModel(ctx);

  // Initialize Git infrastructure using Three-Part Architecture

  // 1. Create in-memory History (blobs, trees, commits, tags, refs)
  const history = createMemoryHistory();
  await history.initialize();
  setHistory(ctx, history);

  // 2. Create in-memory Staging
  const staging = createMemoryGitStaging();

  // 3. Create in-memory Checkout (HEAD, operation states)
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });

  // 4. Create in-memory Worktree (file storage)
  const worktree = new MemoryWorktree({
    blobs: history.blobs,
    trees: history.trees,
  });
  setWorktree(ctx, worktree);

  // 5. Create WorkingCopy (combines history, checkout, worktree)
  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });
  setWorkingCopy(ctx, workingCopy);

  // 6. Create Git porcelain API
  const git = Git.fromWorkingCopy(workingCopy);
  setGit(ctx, git);

  // Inject mock APIs
  setPeerJsApi(ctx, new MockPeerJsApi());
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Wait for a condition to become true (for async state changes).
 */
async function waitFor(condition: () => boolean, timeout = 1000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe("RepositoryController", () => {
  let ctx: AppContext;
  let cleanup: () => void;

  beforeEach(async () => {
    ctx = await createTestAppContext();
    cleanup = createRepositoryController(ctx);
  });

  afterEach(() => {
    cleanup();
  });

  describe("initialization", () => {
    it("should start with uninitialized repository state", () => {
      const repoModel = getRepositoryModel(ctx);
      const state = repoModel.getState();

      expect(state.initialized).toBe(false);
      expect(state.commitCount).toBe(0);
      expect(state.commits).toEqual([]);
    });

    it("should initialize repository when init action is requested", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      // Request initialization
      enqueueInitRepoAction(actionsModel);

      // Wait for repository to be initialized
      await waitFor(() => repoModel.getState().initialized);

      // Verify state updated
      const state = repoModel.getState();
      expect(state.initialized).toBe(true);
      expect(state.branch).toBe("main");
      expect(state.commitCount).toBe(1);
      expect(state.commits).toHaveLength(1);
      expect(state.commits[0].message).toBe("Initial commit");
      expect(state.headCommitId).toBeTruthy();
    });
  });

  describe("adding files", () => {
    beforeEach(async () => {
      // Initialize repository first
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);
    });

    it("should update commit count when a file is added", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      // Initial state after init
      expect(repoModel.getState().commitCount).toBe(1);

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "test-file.txt", content: "Hello, World!" });
      await waitFor(() => repoModel.getState().commitCount === 2);

      // Verify commit count increased
      const state = repoModel.getState();
      expect(state.commitCount).toBe(2);
      expect(state.commits).toHaveLength(2);
      expect(state.commits[0].message).toBe("Add test-file.txt");
    });

    it("should update commit count for multiple file additions", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      // Add first file
      enqueueAddFileAction(actionsModel, { name: "file1.txt", content: "Content 1" });
      await waitFor(() => repoModel.getState().commitCount === 2);
      expect(repoModel.getState().commitCount).toBe(2);

      // Add second file
      enqueueAddFileAction(actionsModel, { name: "file2.txt", content: "Content 2" });
      await waitFor(() => repoModel.getState().commitCount === 3);
      expect(repoModel.getState().commitCount).toBe(3);

      // Add third file
      enqueueAddFileAction(actionsModel, { name: "file3.txt", content: "Content 3" });
      await waitFor(() => repoModel.getState().commitCount === 4);
      expect(repoModel.getState().commitCount).toBe(4);

      // Verify all commits are in history
      const commits = repoModel.getState().commits;
      expect(commits).toHaveLength(4);
      expect(commits[0].message).toBe("Add file3.txt");
      expect(commits[1].message).toBe("Add file2.txt");
      expect(commits[2].message).toBe("Add file1.txt");
      expect(commits[3].message).toBe("Initial commit");
    });

    it("should update files list when file is added", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      // Initial state has README.md
      expect(repoModel.getState().files).toHaveLength(1);
      expect(repoModel.getState().files[0].name).toBe("README.md");

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "new-file.txt", content: "Content" });
      await waitFor(() => repoModel.getState().files.length === 2);

      // Verify files list updated
      const files = repoModel.getState().files;
      expect(files).toHaveLength(2);
      const fileNames = files.map((f) => f.name).sort();
      expect(fileNames).toEqual(["README.md", "new-file.txt"]);
    });

    it("should update headCommitId when file is added", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      const initialHeadId = repoModel.getState().headCommitId;
      expect(initialHeadId).toBeTruthy();

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "test.txt", content: "Content" });
      await waitFor(() => repoModel.getState().headCommitId !== initialHeadId);

      const newHeadId = repoModel.getState().headCommitId;
      expect(newHeadId).toBeTruthy();
      expect(newHeadId).not.toBe(initialHeadId);
    });
  });

  describe("model notifications", () => {
    beforeEach(async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);
    });

    it("should notify listeners when commit count changes", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      const listener = vi.fn();
      repoModel.onUpdate(listener);

      // Reset call count after subscription
      listener.mockClear();

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "test.txt", content: "Content" });

      // Wait for the commit to complete (state change)
      await waitFor(() => repoModel.getState().commitCount === 2);

      // Listener should have been called
      expect(listener).toHaveBeenCalled();

      // Verify the state
      const state = repoModel.getState();
      expect(state.commitCount).toBe(2);
    });

    it("should allow multiple listeners to receive updates", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      repoModel.onUpdate(listener1);
      repoModel.onUpdate(listener2);
      repoModel.onUpdate(listener3);

      // Clear initial calls
      listener1.mockClear();
      listener2.mockClear();
      listener3.mockClear();

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "test.txt", content: "Content" });
      await waitFor(() => repoModel.getState().commitCount === 2);

      // All listeners should have been called
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
      expect(listener3).toHaveBeenCalled();
    });
  });

  describe("activity log", () => {
    it("should log initialization message", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      const logModel = getActivityLogModel(ctx);

      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);

      const entries = logModel.getEntries();
      const initMessages = entries.filter(
        (e) => e.message.includes("Initializing") || e.message.includes("initialized"),
      );
      expect(initMessages.length).toBeGreaterThan(0);
    });

    it("should log file addition message", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      const logModel = getActivityLogModel(ctx);

      // Initialize first
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "my-file.txt", content: "Content" });
      await waitFor(() => repoModel.getState().commitCount === 2);

      const entries = logModel.getEntries();
      const addMessages = entries.filter((e) => e.message.includes("my-file.txt"));
      expect(addMessages.length).toBeGreaterThan(0);
    });
  });

  describe("refresh", () => {
    beforeEach(async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);
    });

    it("should refresh repository state on request", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);

      const listener = vi.fn();
      repoModel.onUpdate(listener);
      listener.mockClear();

      // Request refresh
      enqueueRefreshRepoAction(actionsModel);
      await waitFor(() => listener.mock.calls.length > 0);

      // Listener should have been called
      expect(listener).toHaveBeenCalled();

      // State should remain consistent
      const state = repoModel.getState();
      expect(state.initialized).toBe(true);
      expect(state.commitCount).toBe(1);
    });
  });

  describe("direct Git verification", () => {
    it("should create actual commits in the Git store", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      const git = getGit(ctx);
      if (!git) {
        throw new Error("Git not initialized");
      }

      // Initialize
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);

      // Add files
      enqueueAddFileAction(actionsModel, { name: "file1.txt", content: "Content 1" });
      await waitFor(() => repoModel.getState().commitCount === 2);
      enqueueAddFileAction(actionsModel, { name: "file2.txt", content: "Content 2" });
      await waitFor(() => repoModel.getState().commitCount === 3);

      // Verify commits directly via Git API
      const commits: string[] = [];
      for await (const commit of await git.log().call()) {
        commits.push(commit.message);
      }

      expect(commits).toHaveLength(3);
      expect(commits[0]).toBe("Add file2.txt");
      expect(commits[1]).toBe("Add file1.txt");
      expect(commits[2]).toBe("Initial commit");
    });

    it("should store files in the repository", async () => {
      const actionsModel = getUserActionsModel(ctx);
      const repoModel = getRepositoryModel(ctx);
      const worktree = getWorktree(ctx);
      if (!worktree) {
        throw new Error("Worktree not initialized");
      }

      // Initialize
      enqueueInitRepoAction(actionsModel);
      await waitFor(() => repoModel.getState().initialized);

      // Add a file
      enqueueAddFileAction(actionsModel, { name: "hello.txt", content: "Hello, World!" });
      await waitFor(() => repoModel.getState().commitCount === 2);

      // Verify file exists in working directory
      const content: Uint8Array[] = [];
      for await (const chunk of worktree.readContent("hello.txt")) {
        content.push(chunk);
      }
      const text = new TextDecoder().decode(content[0]);
      expect(text).toBe("Hello, World!");
    });
  });
});
