/**
 * Integration test for P2P sync workflow.
 *
 * Tests the full sync flow between two applications using MemoryConnectionProvider
 * (no PeerJS mocking). Verifies that:
 * - Client 1 can initialize, create files, and share
 * - Client 2 can join and sync
 * - All commits are properly transferred
 */

import { Git } from "@statewalker/vcs-commands";
import type { History, SerializationApi } from "@statewalker/vcs-core";
import { createMemoryHistory, DefaultSerializationApi } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

function createSerializationApi(history: History): SerializationApi {
  return new DefaultSerializationApi({ history });
}

import { fetchOverDuplex, serveOverDuplex } from "@statewalker/vcs-transport";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMessagePortClientDuplex,
  createRefStoreAdapter,
  waitForMessagePortClientService,
} from "../src/adapters/index.js";

// Mock window.location for Node.js environment
beforeAll(() => {
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = {
      location: {
        origin: "http://localhost:3000",
        pathname: "/",
      },
    };
  }
});

import {
  enqueueAddFileAction,
  enqueueCheckoutAction,
  enqueueInitRepoAction,
  enqueueJoinAction,
  enqueueRefreshRepoAction,
  enqueueShareAction,
  enqueueStartSyncAction,
} from "../src/actions/index.js";
import { getTimerApi, MockTimerApi, setTimerApi } from "../src/apis/index.js";
import {
  MemoryConnectionProvider,
  MemoryPeerRegistry,
} from "../src/apis/memory-connection-provider.js";
import type { AppContext } from "../src/controllers/index.js";
import {
  createRepositoryController,
  createSessionController,
  createSyncController,
  getHistory,
  initializeGitFromFiles,
  setConnectionProvider,
  setGit,
  setHistory,
  setSerializationApi,
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
 * Create a test context with in-memory Git infrastructure.
 * Uses MemoryConnectionProvider instead of mock PeerJS infrastructure.
 */
async function createTestAppContext(registry: MemoryPeerRegistry): Promise<AppContext> {
  const ctx: AppContext = {};

  // // Initialize all models
  // getSessionModel(ctx);
  // getPeersModel(ctx);
  // getSyncModel(ctx);
  // getRepositoryModel(ctx);
  // getActivityLogModel(ctx);
  // getUserActionsModel(ctx);

  // Initialize Git infrastructure using Three-Part Architecture

  // 1. Create in-memory History (blobs, trees, commits, tags, refs)
  const history = createMemoryHistory();
  await history.initialize();
  // Set HEAD as symbolic ref so CommitCommand creates refs/heads/main
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
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

  // 7. Create SerializationApi for pack import/export
  const serialization = createSerializationApi(history);
  setSerializationApi(ctx, serialization);

  // Inject memory connection provider (replaces MockPeerJsApi)
  setConnectionProvider(ctx, new MemoryConnectionProvider(registry));
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Interface for models that support update subscription.
 */
interface SubscribableModel {
  onUpdate(callback: () => void): () => void;
}

/**
 * Wait for a model to satisfy a condition (event-based).
 */
async function waitModel<M extends SubscribableModel>(
  model: M,
  check: (model: M) => boolean,
  timeout = 5000,
): Promise<void> {
  if (check(model)) {
    return;
  }

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    unsubscribe = model.onUpdate(() => {
      if (check(model)) {
        cleanup();
        resolve();
      }
    });

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`waitModel timeout: condition not satisfied within ${timeout}ms`));
    }, timeout);

    if (check(model)) {
      cleanup();
      resolve();
    }
  });
}

/**
 * Wait for async operations to complete.
 */
async function flushPromises(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Minimal isolation test - bypasses all controllers, tests duplex adapter + transport directly.
 */
describe("Duplex Adapter Isolation", () => {
  it("should complete a fetch over MessagePort duplex", { timeout: 10000 }, async () => {
    // Create linked MessagePorts directly (no mocks!)
    const channel = new MessageChannel();
    const clientPort = channel.port1;
    const serverPort = channel.port2;

    // Create server-side history with a commit
    const serverHistory = createMemoryHistory();
    await serverHistory.initialize();
    const serverSerialization = createSerializationApi(serverHistory);

    // Create a blob, tree, and commit manually
    const blobId = await serverHistory.blobs.store([new TextEncoder().encode("hello world")]);
    const treeId = await serverHistory.trees.store([
      { name: "test.txt", mode: 0o100644, id: blobId },
    ]);
    const now = Math.floor(Date.now() / 1000);
    const commitId = await serverHistory.commits.store({
      tree: treeId,
      parents: [],
      author: { name: "Test", email: "test@test.com", timestamp: now, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: now, tzOffset: "+0000" },
      message: "initial commit",
    });
    await serverHistory.refs.set("refs/heads/main", commitId);

    // Create client-side empty history
    const clientHistory = createMemoryHistory();
    await clientHistory.initialize();
    const clientSerialization = createSerializationApi(clientHistory);

    // Set up server: wait for service byte, then serve
    const serverRepo = createVcsRepositoryFacade({
      history: serverHistory,
      serialization: serverSerialization,
    });
    const serverRefStore = createRefStoreAdapter(serverHistory.refs);

    const serverPromise = (async () => {
      const { duplex, service } = await waitForMessagePortClientService(serverPort);
      return await serveOverDuplex({
        duplex,
        repository: serverRepo,
        refStore: serverRefStore,
        service,
      });
    })();

    // Set up client: create duplex + fetch
    const clientRepo = createVcsRepositoryFacade({
      history: clientHistory,
      serialization: clientSerialization,
    });
    const clientRefStore = createRefStoreAdapter(clientHistory.refs);

    const clientDuplex = createMessagePortClientDuplex(clientPort, "git-upload-pack");
    const clientResult = await fetchOverDuplex({
      duplex: clientDuplex,
      repository: clientRepo,
      refStore: clientRefStore,
    });

    const serverResult = await serverPromise;

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });
});

describe("P2P Sync Integration", () => {
  let registry: MemoryPeerRegistry;
  let ctx1: AppContext;
  let ctx2: AppContext;
  let cleanup1: (() => void)[] = [];
  let cleanup2: (() => void)[] = [];

  beforeEach(async () => {
    // Create shared registry for peer connections
    registry = new MemoryPeerRegistry();

    // Create two independent app contexts
    ctx1 = await createTestAppContext(registry);
    ctx2 = await createTestAppContext(registry);

    // Initialize controllers for both clients
    cleanup1 = [
      createRepositoryController(ctx1),
      createSessionController(ctx1),
      createSyncController(ctx1),
    ];
    cleanup2 = [
      createRepositoryController(ctx2),
      createSessionController(ctx2),
      createSyncController(ctx2),
    ];
  });

  afterEach(() => {
    // Cleanup controllers
    for (const fn of cleanup1) fn();
    for (const fn of cleanup2) fn();
    cleanup1 = [];
    cleanup2 = [];

    // Reset registry
    registry.reset();
  });

  it("should establish P2P connection and sync refs between clients", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const sessionModel1 = getSessionModel(ctx1);
    const sessionModel2 = getSessionModel(ctx2);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);
    const logModel2 = getActivityLogModel(ctx2);

    // ========================================
    // Client 1: Initialize repository with commits
    // ========================================
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    // Create 5 files (5 additional commits)
    for (let i = 1; i <= 5; i++) {
      enqueueAddFileAction(actionsModel1, {
        name: `file${i}.txt`,
        content: `Content of file ${i}`,
      });
      const expectedCount = i + 1;
      await waitModel(repoModel1, (m) => m.getState().commitCount === expectedCount);
    }

    expect(repoModel1.getState().commitCount).toBe(6);

    // ========================================
    // Client 1: Share repository
    // ========================================
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");

    const sessionId = sessionModel1.getState().sessionId;
    expect(sessionId).toBeTruthy();
    if (!sessionId) throw new Error("Session ID not set");

    // ========================================
    // Client 2: Join session (without initializing own repo - matches real demo flow)
    // ========================================
    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(sessionModel2, (m) => m.getState().mode === "joined");

    // Wait for bidirectional connection
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    // ========================================
    // Verify: Connection established
    // ========================================
    expect(peersModel1.count).toBe(1);
    expect(peersModel1.getAll()[0].status).toBe("connected");
    expect(peersModel2.count).toBe(1);
    expect(peersModel2.getAll()[0].status).toBe("connected");

    // ========================================
    // Client 2: Start sync with the host
    // ========================================
    const hostPeerId = peersModel2.getAll()[0].id;

    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });

    // Wait for sync to complete
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );

    // ========================================
    // Verify: Sync completed successfully
    // ========================================
    expect(syncModel2.getState().phase).toBe("complete");

    // ========================================
    // Verify: Remote tracking ref was synced
    // ========================================
    const logs = logModel2.getEntries();
    const refUpdateLog = logs.find((e) => e.message.includes("Updated ref refs/remotes/peer/main"));
    expect(refUpdateLog).toBeDefined();

    const localMainLog = logs.find(
      (e) => e.message.includes("Set local main") || e.message.includes("Updated local main"),
    );
    expect(localMainLog).toBeDefined();

    const client1Head = repoModel1.getState().headCommitId;
    expect(client1Head).toBeTruthy();
    expect(localMainLog?.message).toContain(client1Head?.slice(0, 7));
  });

  it("should sync refs from host to joiner without prior initialization", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const sessionModel1 = getSessionModel(ctx1);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);

    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    for (let i = 1; i <= 3; i++) {
      enqueueAddFileAction(actionsModel1, {
        name: `client1-file${i}.txt`,
        content: `Client 1 file ${i}`,
      });
      const expectedCount = i + 1;
      await waitModel(repoModel1, (m) => m.getState().commitCount === expectedCount);
    }
    expect(repoModel1.getState().commitCount).toBe(4);

    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(peersModel2, (m) => m.getAll()[0]?.status === "connected");
    await waitModel(peersModel1, (m) => m.getAll()[0]?.status === "connected");

    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      10000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    const logModel2 = getActivityLogModel(ctx2);
    const logs2 = logModel2.getEntries();

    const remoteRefLog = logs2.find((e) =>
      e.message.includes("Updated ref refs/remotes/peer/main"),
    );
    expect(remoteRefLog).toBeDefined();

    const localMainLog = logs2.find(
      (e) => e.message.includes("Set local main") || e.message.includes("Updated local main"),
    );
    expect(localMainLog).toBeDefined();

    const client1Head = repoModel1.getState().headCommitId;
    expect(client1Head).toBeTruthy();
    expect(localMainLog?.message).toContain(client1Head?.slice(0, 7));
  });

  it("should allow second sync after Client 2 creates new commits", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);
    const logModel2 = getActivityLogModel(ctx2);

    // Client 1: Initialize repository and create files
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    for (let i = 1; i <= 2; i++) {
      enqueueAddFileAction(actionsModel1, {
        name: `client1-file${i}.txt`,
        content: `Client 1 file ${i}`,
      });
      const expectedCount = i + 1;
      await waitModel(repoModel1, (m) => m.getState().commitCount === expectedCount);
    }
    expect(repoModel1.getState().commitCount).toBe(3);

    // Client 1: Share
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    // Client 2: Join
    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(peersModel2, (m) => m.getAll()[0]?.status === "connected", 10000);
    await waitModel(peersModel1, (m) => m.getAll()[0]?.status === "connected", 10000);

    // Client 2: First sync
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      10000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Advance the mock timer to trigger sync model reset
    const timerApi2 = getTimerApi(ctx2) as MockTimerApi;
    timerApi2.advance(3000);

    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);

    // Wait for checkout and refresh to complete after sync
    await flushPromises(20);
    await waitModel(
      repoModel2,
      (m) => m.getState().commitCount === repoModel1.getState().commitCount,
      5000,
    );

    // Client 2: Create new files (2 additional commits)
    logModel2.info("--- Client 2 creating new commits ---");
    for (let i = 1; i <= 2; i++) {
      enqueueAddFileAction(actionsModel2, {
        name: `client2-file${i}.txt`,
        content: `Client 2 file ${i}`,
      });
      const expectedCount = repoModel1.getState().commitCount + i;
      await waitModel(repoModel2, (m) => m.getState().commitCount === expectedCount, 5000);
    }

    const client2CommitCount = repoModel2.getState().commitCount;
    const client1CommitCount = repoModel1.getState().commitCount;
    expect(client2CommitCount).toBe(client1CommitCount + 2);

    // Client 2: Second sync
    logModel2.info("--- Client 2 starting second sync ---");
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });

    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );

    expect(syncModel2.getState().phase).toBe("complete");

    const client2Head = repoModel2.getState().headCommitId;
    expect(client2Head).toBeTruthy();
  });

  it("full round-trip: Client 1 creates repo, Client 2 syncs and adds commits, Client 1 receives all files", {
    timeout: 30000,
  }, async () => {
    // Helper: read blob content as string
    async function readBlobContent(ctx: AppContext, blobId: string): Promise<string> {
      const history = getHistory(ctx);
      const stream = await history?.blobs.load(blobId);
      if (!stream) throw new Error(`Blob ${blobId} not found`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const combined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(combined);
    }

    // Helper: get sorted file names from repo model
    function getFileNames(ctx: AppContext): string[] {
      return getRepositoryModel(ctx)
        .getState()
        .files.filter((f) => f.type === "file")
        .map((f) => f.name)
        .sort();
    }

    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const sessionModel2 = getSessionModel(ctx2);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);

    // ========================================
    // Step 1: Client 1 — init repo + create 3 files
    // ========================================
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    const client1Files = [
      { name: "alpha.txt", content: "Alpha content from Client 1" },
      { name: "beta.txt", content: "Beta content from Client 1" },
      { name: "gamma.txt", content: "Gamma content from Client 1" },
    ];

    for (let i = 0; i < client1Files.length; i++) {
      enqueueAddFileAction(actionsModel1, client1Files[i]);
      await waitModel(repoModel1, (m) => m.getState().commitCount === i + 2);
    }

    // Client 1 should have 4 commits (init + 3 files) and 4 files (README.md + 3)
    expect(repoModel1.getState().commitCount).toBe(4);
    expect(getFileNames(ctx1)).toEqual(["README.md", "alpha.txt", "beta.txt", "gamma.txt"]);

    // ========================================
    // Step 2: Client 1 — share
    // ========================================

    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    // ========================================
    // Step 3: Client 2 — join and sync
    // ========================================

    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(sessionModel2, (m) => m.getState().mode === "joined");
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Advance timer to reset sync model, then wait for checkout/refresh
    const timerApi2 = getTimerApi(ctx2) as MockTimerApi;
    timerApi2.advance(3000);
    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);
    await flushPromises(20);
    await waitModel(repoModel2, (m) => m.getState().commitCount === 4, 5000);

    // ========================================
    // Step 4: Verify Client 2 has same data as Client 1
    // ========================================

    expect(repoModel2.getState().commitCount).toBe(repoModel1.getState().commitCount);
    expect(repoModel2.getState().headCommitId).toBe(repoModel1.getState().headCommitId);
    expect(getFileNames(ctx2)).toEqual(["README.md", "alpha.txt", "beta.txt", "gamma.txt"]);

    // Verify file content on Client 2 matches what Client 1 wrote
    const client2Files = repoModel2.getState().files.filter((f) => f.type === "file");
    for (const expectedFile of client1Files) {
      const file = client2Files.find((f) => f.name === expectedFile.name);
      expect(file, `File ${expectedFile.name} should exist on Client 2`).toBeDefined();
      if (!file?.id) continue;
      const content = await readBlobContent(ctx2, file.id);
      expect(content).toBe(expectedFile.content);
    }

    // ========================================
    // Step 5: Client 2 — add new files
    // ========================================

    const client2NewFiles = [
      { name: "delta.txt", content: "Delta content from Client 2" },
      { name: "epsilon.txt", content: "Epsilon content from Client 2" },
    ];

    for (let i = 0; i < client2NewFiles.length; i++) {
      enqueueAddFileAction(actionsModel2, client2NewFiles[i]);
      await waitModel(repoModel2, (m) => m.getState().commitCount === 4 + i + 1, 5000);
    }

    expect(repoModel2.getState().commitCount).toBe(6);
    expect(getFileNames(ctx2)).toEqual([
      "README.md",
      "alpha.txt",
      "beta.txt",
      "delta.txt",
      "epsilon.txt",
      "gamma.txt",
    ]);

    // ========================================
    // Step 6: Client 2 — second sync (pushes new commits to Client 1)
    // ========================================

    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // ========================================
    // Step 7: Refresh Client 1 to see pushed changes
    // ========================================

    enqueueCheckoutAction(actionsModel1);
    enqueueRefreshRepoAction(actionsModel1);
    await flushPromises(20);
    await waitModel(repoModel1, (m) => m.getState().commitCount === 6, 5000);

    // ========================================
    // Step 8: Verify Client 1 has all files from both clients
    // ========================================
    expect(repoModel1.getState().commitCount).toBe(6);
    expect(repoModel1.getState().headCommitId).toBe(repoModel2.getState().headCommitId);
    expect(getFileNames(ctx1)).toEqual([
      "README.md",
      "alpha.txt",
      "beta.txt",
      "delta.txt",
      "epsilon.txt",
      "gamma.txt",
    ]);

    // Verify Client 2's file content is readable on Client 1
    const client1AllFiles = repoModel1.getState().files.filter((f) => f.type === "file");
    for (const expectedFile of [...client1Files, ...client2NewFiles]) {
      const file = client1AllFiles.find((f) => f.name === expectedFile.name);
      expect(file, `File ${expectedFile.name} should exist on Client 1`).toBeDefined();
      if (!file?.id) continue;
      const content = await readBlobContent(ctx1, file.id);
      expect(content).toBe(expectedFile.content);
    }
  });

  it("should auto-refresh server repo when peer pushes commits (no manual refresh needed)", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const sessionModel2 = getSessionModel(ctx2);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);

    // Step 1: Client 1 initializes repo with a file
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    enqueueAddFileAction(actionsModel1, {
      name: "host-file.txt",
      content: "Host file content",
    });
    await waitModel(repoModel1, (m) => m.getState().commitCount === 2);

    // Step 2: Client 1 shares
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    // Step 3: Client 2 joins
    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(sessionModel2, (m) => m.getState().mode === "joined");
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    // Step 4: Client 2 syncs (fetches Client 1's repo)
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Reset sync model
    const timerApi2 = getTimerApi(ctx2) as MockTimerApi;
    timerApi2.advance(3000);
    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);
    await flushPromises(20);
    await waitModel(repoModel2, (m) => m.getState().commitCount === 2, 5000);

    // Step 5: Client 2 adds a new file
    enqueueAddFileAction(actionsModel2, {
      name: "joiner-file.txt",
      content: "Joiner file content",
    });
    await waitModel(repoModel2, (m) => m.getState().commitCount === 3, 5000);

    // Step 6: Client 2 syncs again (pushes new commit to Client 1's server)
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Step 7: Wait for auto-refresh on Client 1 (NO manual enqueueCheckoutAction/enqueueRefreshRepoAction!)
    await flushPromises(30);
    await waitModel(repoModel1, (m) => m.getState().commitCount === 3, 5000);

    // Verify Client 1 sees the joiner's file without manual refresh
    const client1Files = repoModel1
      .getState()
      .files.filter((f) => f.type === "file")
      .map((f) => f.name)
      .sort();
    expect(client1Files).toContain("joiner-file.txt");
    expect(client1Files).toContain("host-file.txt");
    expect(client1Files).toContain("README.md");
  });

  it("should not roll back peer files when server commits after receiving push", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const sessionModel2 = getSessionModel(ctx2);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);

    // Step 1: Client 1 initializes repo
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    enqueueAddFileAction(actionsModel1, {
      name: "original.txt",
      content: "Original content",
    });
    await waitModel(repoModel1, (m) => m.getState().commitCount === 2);

    // Step 2: Client 1 shares, Client 2 joins
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(sessionModel2, (m) => m.getState().mode === "joined");
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    // Step 3: Client 2 syncs (fetches Client 1's repo)
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    const timerApi2 = getTimerApi(ctx2) as MockTimerApi;
    timerApi2.advance(3000);
    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);
    await flushPromises(20);
    await waitModel(repoModel2, (m) => m.getState().commitCount === 2, 5000);

    // Step 4: Client 2 adds a file
    enqueueAddFileAction(actionsModel2, {
      name: "peer-file.txt",
      content: "Peer file content",
    });
    await waitModel(repoModel2, (m) => m.getState().commitCount === 3, 5000);

    // Step 5: Client 2 syncs again (pushes peer-file.txt to Client 1)
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Step 6: Wait for auto-refresh on Client 1
    await flushPromises(30);
    await waitModel(repoModel1, (m) => m.getState().commitCount === 3, 5000);

    // Verify Client 1 sees peer-file.txt
    let client1Files = repoModel1
      .getState()
      .files.filter((f) => f.type === "file")
      .map((f) => f.name)
      .sort();
    expect(client1Files).toContain("peer-file.txt");

    // Step 7: Client 1 creates a NEW commit (this is the critical test)
    enqueueAddFileAction(actionsModel1, {
      name: "server-new-file.txt",
      content: "Server new content",
    });
    await waitModel(repoModel1, (m) => m.getState().commitCount === 4, 5000);

    // Step 8: Verify Client 1's new commit did NOT revert peer-file.txt
    client1Files = repoModel1
      .getState()
      .files.filter((f) => f.type === "file")
      .map((f) => f.name)
      .sort();
    expect(client1Files).toEqual([
      "README.md",
      "original.txt",
      "peer-file.txt",
      "server-new-file.txt",
    ]);
  });

  it("should merge divergent histories before pushing instead of creating backup branches", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const sessionModel2 = getSessionModel(ctx2);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);
    const logModel2 = getActivityLogModel(ctx2);

    // Step 1: Client 1 initializes repo with a file
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    enqueueAddFileAction(actionsModel1, {
      name: "shared.txt",
      content: "Shared content",
    });
    await waitModel(repoModel1, (m) => m.getState().commitCount === 2);

    // Step 2: Client 1 shares, Client 2 joins
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    enqueueJoinAction(actionsModel2, { sessionId });
    await waitModel(sessionModel2, (m) => m.getState().mode === "joined");
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    // Step 3: Client 2 syncs (gets Client 1's commits)
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Reset sync model
    const timerApi2 = getTimerApi(ctx2) as MockTimerApi;
    timerApi2.advance(3000);
    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);
    await flushPromises(20);
    await waitModel(repoModel2, (m) => m.getState().commitCount === 2, 5000);

    // Step 4: Both clients create commits independently (DIVERGENT HISTORY!)
    // Client 1 adds a file
    enqueueAddFileAction(actionsModel1, {
      name: "host-divergent.txt",
      content: "Host divergent content",
    });
    await waitModel(repoModel1, (m) => m.getState().commitCount === 3, 5000);

    // Client 2 adds a file
    enqueueAddFileAction(actionsModel2, {
      name: "joiner-divergent.txt",
      content: "Joiner divergent content",
    });
    await waitModel(repoModel2, (m) => m.getState().commitCount === 3, 5000);

    // Step 5: Client 2 syncs again (should merge remote into local, then push)
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    expect(syncModel2.getState().phase).toBe("complete");

    // Verify merge log message appeared
    const logs = logModel2.getEntries();
    const mergeLog = logs.find((e) => e.message.includes("Merge successful"));
    expect(mergeLog).toBeDefined();

    // Wait for checkout/refresh on Client 2
    timerApi2.advance(3000);
    await waitModel(syncModel2, (m) => m.getState().phase === "idle", 5000);
    await flushPromises(20);

    // Step 6: Verify Client 2 has ALL files from both peers (merged)
    // Commits: init(1) + shared(1) + host(1) + joiner(1) + merge(1) = 5
    await waitModel(repoModel2, (m) => m.getState().commitCount >= 4, 5000);

    const client2Files = repoModel2
      .getState()
      .files.filter((f) => f.type === "file")
      .map((f) => f.name)
      .sort();
    expect(client2Files).toContain("README.md");
    expect(client2Files).toContain("shared.txt");
    expect(client2Files).toContain("host-divergent.txt");
    expect(client2Files).toContain("joiner-divergent.txt");

    // Step 7: Wait for auto-refresh on Client 1 (push should have updated it)
    await flushPromises(30);
    await waitModel(repoModel1, (m) => m.getState().commitCount >= 4, 5000);

    // Verify Client 1 also has all files
    const client1Files = repoModel1
      .getState()
      .files.filter((f) => f.type === "file")
      .map((f) => f.name)
      .sort();
    expect(client1Files).toContain("README.md");
    expect(client1Files).toContain("shared.txt");
    expect(client1Files).toContain("host-divergent.txt");
    expect(client1Files).toContain("joiner-divergent.txt");

    // Step 8: Verify NO backup branches were created on Client 1
    const history1 = getHistory(ctx1);
    if (!history1) throw new Error("History not initialized");
    const backupRefs: string[] = [];
    for await (const entry of history1.refs.list("refs/heads/local-")) {
      backupRefs.push(entry.name);
    }
    expect(backupRefs).toHaveLength(0);
  });
});

/**
 * Create a test context backed by MemFilesApi instead of pure MemoryHistory.
 */
async function createFilesBackedTestContext(registry: MemoryPeerRegistry): Promise<AppContext> {
  const ctx: AppContext = {};

  // Initialize git from MemFilesApi (file-backed storage in memory)
  const files = new MemFilesApi();
  await initializeGitFromFiles(ctx, files);

  // Inject memory connection provider
  setConnectionProvider(ctx, new MemoryConnectionProvider(registry));
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

describe("P2P Sync with FilesApi-backed repos", () => {
  let registry: MemoryPeerRegistry;
  let ctx1: AppContext;
  let ctx2: AppContext;
  let cleanup1: (() => void)[] = [];
  let cleanup2: (() => void)[] = [];

  beforeEach(async () => {
    registry = new MemoryPeerRegistry();

    // Both clients use FilesApi-backed git
    ctx1 = await createFilesBackedTestContext(registry);
    ctx2 = await createFilesBackedTestContext(registry);

    cleanup1 = [
      createRepositoryController(ctx1),
      createSessionController(ctx1),
      createSyncController(ctx1),
    ];
    cleanup2 = [
      createRepositoryController(ctx2),
      createSessionController(ctx2),
      createSyncController(ctx2),
    ];
  });

  afterEach(() => {
    for (const fn of cleanup1) fn();
    for (const fn of cleanup2) fn();
    cleanup1 = [];
    cleanup2 = [];
    registry.reset();
  });

  it("should sync between two FilesApi-backed repos", { timeout: 30000 }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const sessionModel1 = getSessionModel(ctx1);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);
    const logModel2 = getActivityLogModel(ctx2);

    // Client 1: Init repo and create files
    enqueueInitRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized);

    for (let i = 1; i <= 3; i++) {
      enqueueAddFileAction(actionsModel1, {
        name: `file${i}.txt`,
        content: `File ${i} content`,
      });
      await waitModel(repoModel1, (m) => m.getState().commitCount === i + 1);
    }
    expect(repoModel1.getState().commitCount).toBe(4);

    // Client 1: Share
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");
    const sessionId = sessionModel1.getState().sessionId;
    if (!sessionId) throw new Error("Session ID not set");

    // Client 2: Join
    enqueueJoinAction(actionsModel2, { sessionId });
    await flushPromises(50);
    await waitModel(
      peersModel2,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );
    await waitModel(
      peersModel1,
      (m) => m.count > 0 && m.getAll()[0]?.status === "connected",
      10000,
    );

    // Client 2: Sync
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });
    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );
    if (syncModel2.getState().phase === "error") {
      const errorLogs = logModel2.getEntries().filter((e) => e.level === "error");
      const allLogs = logModel2.getEntries().map((e) => `[${e.level}] ${e.message}`);
      console.error("Sync error logs:", errorLogs);
      console.error("All logs:", allLogs);
    }
    expect(syncModel2.getState().phase).toBe("complete");

    // Verify refs were synced
    const refUpdateLog = logModel2
      .getEntries()
      .find((e) => e.message.includes("Updated ref refs/remotes/peer/main"));
    expect(refUpdateLog).toBeDefined();

    const localMainLog = logModel2
      .getEntries()
      .find(
        (e) => e.message.includes("Set local main") || e.message.includes("Updated local main"),
      );
    expect(localMainLog).toBeDefined();

    // Verify Client 2's history has the commits
    const client2History = getHistory(ctx2);
    expect(client2History).not.toBeNull();
    const client2Head = await client2History?.refs.resolve("refs/heads/main");
    const client1Head = repoModel1.getState().headCommitId;
    expect(client2Head?.objectId).toBe(client1Head);
  });
});
