/**
 * Test: Sync of merge histories from a real Git repository.
 *
 * Reproduces the bug where syncing a file-backed repository (79 commits
 * with a merge) to an in-memory client via MessagePort only transfers
 * 27 of 79 commits.
 *
 * Uses a real Git repository fixture (tests/fixtures/test-repo) that
 * contains a merge of two divergent branches with 79 total commits.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Git } from "@statewalker/vcs-commands";
import type { History, SerializationApi } from "@statewalker/vcs-core";
import { createMemoryHistory, DefaultSerializationApi } from "@statewalker/vcs-core";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  enqueueJoinAction,
  enqueueRefreshRepoAction,
  enqueueShareAction,
  enqueueStartSyncAction,
} from "../src/actions/index.js";
import { MockTimerApi, setTimerApi } from "../src/apis/index.js";
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.join(__dirname, "fixtures", "test-repo");
const EXPECTED_COMMIT_COUNT = 79;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createSerializationApi(history: History): SerializationApi {
  return new DefaultSerializationApi({ history });
}

/**
 * Create an in-memory app context (same pattern as p2p-sync-integration.test.ts).
 */
async function createInMemoryTestContext(registry: MemoryPeerRegistry): Promise<AppContext> {
  const ctx: AppContext = {};

  const history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  setHistory(ctx, history);

  const staging = createMemoryGitStaging();
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });

  const worktree = new MemoryWorktree({
    blobs: history.blobs,
    trees: history.trees,
  });
  setWorktree(ctx, worktree);

  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });
  setWorkingCopy(ctx, workingCopy);

  const git = Git.fromWorkingCopy(workingCopy);
  setGit(ctx, git);

  const serialization = createSerializationApi(history);
  setSerializationApi(ctx, serialization);

  setConnectionProvider(ctx, new MemoryConnectionProvider(registry));
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Create a file-backed app context from a repository directory.
 */
async function createFileBackedTestContext(
  registry: MemoryPeerRegistry,
  repoDir: string,
): Promise<AppContext> {
  const ctx: AppContext = {};

  const files = createNodeFilesApi({ rootDir: repoDir });
  await initializeGitFromFiles(ctx, files);

  setConnectionProvider(ctx, new MemoryConnectionProvider(registry));
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Wait for a subscribable model to satisfy a condition.
 */
interface SubscribableModel {
  onUpdate(callback: () => void): () => void;
}

async function waitModel<M extends SubscribableModel>(
  model: M,
  check: (model: M) => boolean,
  timeout = 5000,
): Promise<void> {
  if (check(model)) return;

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

    // Re-check after subscribe in case condition became true
    if (check(model)) {
      cleanup();
      resolve();
    }
  });
}

async function flushPromises(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Low-level isolation tests (no controllers)
// ─────────────────────────────────────────────────────────────────────────────

describe("Merge History: Low-level isolation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-merge-history-"));
    execSync(`cp -r "${FIXTURE_REPO}" "${path.join(tempDir, "repo")}"`, { stdio: "pipe" });
    // Fixture stores .git as dot-git to avoid embedded-repo issues; rename back
    execSync(
      `mv "${path.join(tempDir, "repo", "dot-git")}" "${path.join(tempDir, "repo", ".git")}"`,
      { stdio: "pipe" },
    );
  });

  afterEach(async () => {
    try {
      execSync(`chmod -R u+w "${tempDir}"`, { stdio: "ignore" });
    } catch {
      // Ignore chmod errors
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should walk all 79 commits via walkAncestry", async () => {
    const repoDir = path.join(tempDir, "repo");
    const ctx: AppContext = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    if (!history) return;

    // Resolve HEAD
    const headRef = await history.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeTruthy();
    const headOid = headRef?.objectId;

    // Walk all commits from HEAD
    const commitIds: string[] = [];
    for await (const id of history.commits.walkAncestry(headOid)) {
      commitIds.push(id);
    }

    expect(commitIds.length).toBe(EXPECTED_COMMIT_COUNT);
  });

  it("should enumerate all commits via collectReachableObjects", async () => {
    const repoDir = path.join(tempDir, "repo");
    const ctx: AppContext = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    if (!history) return;

    const headRef = await history.refs.resolve("HEAD");
    const headOid = headRef?.objectId;

    // Collect all reachable objects
    const commitCount = { value: 0 };
    const allObjectIds: string[] = [];
    for await (const oid of history.collectReachableObjects(new Set([headOid]), new Set())) {
      allObjectIds.push(oid);
      // Check if it's a commit
      const commit = await history.commits.load(oid);
      if (commit) commitCount.value++;
    }

    expect(commitCount.value).toBe(EXPECTED_COMMIT_COUNT);
  });

  it("should export+import pack preserving all commits", { timeout: 15000 }, async () => {
    const repoDir = path.join(tempDir, "repo");
    const ctx: AppContext = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    if (!history) return;

    const serialization = createSerializationApi(history);
    const headRef = await history.refs.resolve("HEAD");
    const headOid = headRef?.objectId;

    // Collect all server commit OIDs for later verification
    const serverCommitOids: string[] = [];
    for await (const id of history.commits.walkAncestry(headOid)) {
      serverCommitOids.push(id);
    }
    expect(serverCommitOids.length).toBe(EXPECTED_COMMIT_COUNT);

    // Server: export pack
    const facade = createVcsRepositoryFacade({ history, serialization });
    const packChunks: Uint8Array[] = [];
    for await (const chunk of facade.exportPack(new Set([headOid]), new Set())) {
      packChunks.push(chunk);
    }
    expect(packChunks.length).toBeGreaterThan(0);

    // Client: import pack into empty in-memory history
    const clientHistory = createMemoryHistory();
    await clientHistory.initialize();
    const clientSerialization = createSerializationApi(clientHistory);

    async function* yieldChunks() {
      for (const chunk of packChunks) yield chunk;
    }
    const importResult = await clientSerialization.importPack(yieldChunks());
    expect(importResult.objectsImported).toBeGreaterThan(0);

    // Diagnostic: check which server commit OIDs exist on the client
    const missingOnClient: string[] = [];
    const presentOnClient: string[] = [];
    for (const oid of serverCommitOids) {
      const commit = await clientHistory.commits.load(oid);
      if (commit) {
        presentOnClient.push(oid);
      } else {
        // Check if the object exists at all (maybe stored under wrong type?)
        const hasBlob = await clientHistory.blobs.has(oid);
        const hasTree = await clientHistory.trees.has(oid);
        missingOnClient.push(oid);
        if (hasBlob || hasTree) {
          console.error(
            `Commit ${oid.slice(0, 7)} exists as blob=${hasBlob} tree=${hasTree} but NOT as commit`,
          );
        }
      }
    }

    if (missingOnClient.length > 0) {
      console.error(`Missing ${missingOnClient.length} commits on client:`);
      console.error(`  First missing: ${missingOnClient[0].slice(0, 7)}`);
      console.error(`  Last missing: ${missingOnClient[missingOnClient.length - 1].slice(0, 7)}`);
      console.error(
        `  Import result: ${importResult.objectsImported} objects, ${importResult.commitsImported} commits`,
      );

      // Check if the first missing commit has a hash mismatch
      const firstMissing = missingOnClient[0];
      const serverCommit = await history.commits.load(firstMissing);
      if (serverCommit) {
        // Re-serialize and check what hash the client would produce
        const reserializedId = await clientHistory.commits.store(serverCommit);
        console.error(
          `  First missing ${firstMissing.slice(0, 7)} → re-stored as ${reserializedId.slice(0, 7)} (hash mismatch: ${firstMissing !== reserializedId})`,
        );
      }
    }

    // Walk client commits from HEAD
    const clientCommitIds: string[] = [];
    for await (const id of clientHistory.commits.walkAncestry(headOid)) {
      clientCommitIds.push(id);
    }

    expect(clientCommitIds.length).toBe(EXPECTED_COMMIT_COUNT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full application sync test (with controllers and user actions)
// ─────────────────────────────────────────────────────────────────────────────

describe("Merge History: Full P2P sync", () => {
  let tempDir: string;
  let registry: MemoryPeerRegistry;
  let ctx1: AppContext;
  let ctx2: AppContext;
  let cleanup1: (() => void)[];
  let cleanup2: (() => void)[];

  beforeEach(async () => {
    // Copy fixture to temp dir to avoid mutating it
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-merge-sync-"));
    execSync(`cp -r "${FIXTURE_REPO}" "${path.join(tempDir, "repo")}"`, { stdio: "pipe" });
    // Fixture stores .git as dot-git to avoid embedded-repo issues; rename back
    execSync(
      `mv "${path.join(tempDir, "repo", "dot-git")}" "${path.join(tempDir, "repo", ".git")}"`,
      { stdio: "pipe" },
    );

    registry = new MemoryPeerRegistry();

    // App 1: file-backed from real repo
    ctx1 = await createFileBackedTestContext(registry, path.join(tempDir, "repo"));
    cleanup1 = [
      createRepositoryController(ctx1),
      createSessionController(ctx1),
      createSyncController(ctx1),
    ];

    // App 2: in-memory
    ctx2 = await createInMemoryTestContext(registry);
    cleanup2 = [
      createRepositoryController(ctx2),
      createSessionController(ctx2),
      createSyncController(ctx2),
    ];
  });

  afterEach(async () => {
    for (const fn of cleanup1) fn();
    for (const fn of cleanup2) fn();
    cleanup1 = [];
    cleanup2 = [];
    registry.reset();

    try {
      execSync(`chmod -R u+w "${tempDir}"`, { stdio: "ignore" });
    } catch {
      // Ignore
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should sync all 79 commits from file-backed repo to in-memory client", {
    timeout: 30000,
  }, async () => {
    const actionsModel1 = getUserActionsModel(ctx1);
    const actionsModel2 = getUserActionsModel(ctx2);
    const repoModel1 = getRepositoryModel(ctx1);
    const _repoModel2 = getRepositoryModel(ctx2);
    const sessionModel1 = getSessionModel(ctx1);
    const peersModel1 = getPeersModel(ctx1);
    const peersModel2 = getPeersModel(ctx2);
    const syncModel2 = getSyncModel(ctx2);
    const logModel2 = getActivityLogModel(ctx2);

    // Step 1: App 1 refreshes to read the existing repo
    enqueueRefreshRepoAction(actionsModel1);
    await waitModel(repoModel1, (m) => m.getState().initialized, 10000);

    // Verify App 1 sees all 79 commits
    expect(repoModel1.getState().commitCount).toBe(EXPECTED_COMMIT_COUNT);

    // Step 2: App 1 shares
    enqueueShareAction(actionsModel1);
    await waitModel(sessionModel1, (m) => m.getState().mode === "hosting");

    const sessionId = sessionModel1.getState().sessionId;
    expect(sessionId).toBeTruthy();
    if (!sessionId) throw new Error("Session ID not set");

    // Step 3: App 2 joins
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

    // Step 4: App 2 syncs with App 1
    const hostPeerId = peersModel2.getAll()[0].id;
    enqueueStartSyncAction(actionsModel2, { peerId: hostPeerId });

    await waitModel(
      syncModel2,
      (m) => m.getState().phase === "complete" || m.getState().phase === "error",
      15000,
    );

    // Debug: log errors if sync failed
    if (syncModel2.getState().phase === "error") {
      const errorLogs = logModel2.getEntries().filter((e) => e.level === "error");
      console.error(
        "Sync error logs:",
        errorLogs.map((e) => e.message),
      );
    }
    expect(syncModel2.getState().phase).toBe("complete");

    // Step 5: Advance timer to reset sync, wait for checkout/refresh
    const _timerApi2 = new MockTimerApi();
    // The timer is already set in the context, advance the one from ctx2
    const ctxTimerApi = ctx2;
    const syncTimerApi = ctxTimerApi as { _timerApi?: MockTimerApi };
    // Use the injected timer API
    const _injectedTimer = syncTimerApi._timerApi;

    // Wait for checkout and refresh to complete
    await flushPromises(50);

    // Step 6: Verify App 2 received all 79 commits
    // First, check via direct history walk (most reliable)
    const history2 = getHistory(ctx2);
    expect(history2).not.toBeNull();

    const headRef2 = await history2?.refs.resolve("HEAD");
    expect(headRef2?.objectId).toBeTruthy();

    if (!history2 || !headRef2) throw new Error("client history has no HEAD");
    const clientCommitIds: string[] = [];
    for await (const id of history2.commits.walkAncestry(headRef2.objectId)) {
      clientCommitIds.push(id);
    }

    // This is the key assertion — should be 79, not 27
    expect(clientCommitIds.length).toBe(EXPECTED_COMMIT_COUNT);

    // Also verify HEAD matches
    const headRef1 = await getHistory(ctx1)?.refs.resolve("HEAD");
    expect(headRef2?.objectId).toBe(headRef1?.objectId);
  });
});
