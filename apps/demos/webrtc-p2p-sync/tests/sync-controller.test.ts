/**
 * Integration tests for SyncController.
 *
 * Tests the Git synchronization flow between peers using in-memory
 * repositories and MessagePort-based connections. Verifies that the full
 * commit history is synchronized correctly.
 *
 * NOTE: These tests are skipped — they were written for the old JSON-based
 * sync protocol and need a full rewrite to work with the provider-based
 * architecture. The integration tests in p2p-sync-integration.test.ts
 * cover the full sync flow using MemoryConnectionProvider.
 */

import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory, DefaultSerializationApi } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueAddFileAction,
  enqueueInitRepoAction,
  enqueueRefreshRepoAction,
  enqueueStartSyncAction,
} from "../src/actions/index.js";
import { MockTimerApi, setTimerApi } from "../src/apis/index.js";
import type { AppContext } from "../src/controllers/index.js";
import {
  createRepositoryController,
  createSyncController,
  getPeerConnections,
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
 */
async function createTestAppContext(_name: string): Promise<AppContext> {
  const ctx: AppContext = {};

  // Initialize all models
  getSessionModel(ctx);
  getPeersModel(ctx);
  getSyncModel(ctx);
  getRepositoryModel(ctx);
  getActivityLogModel(ctx);
  getUserActionsModel(ctx);

  // Initialize Git infrastructure using Three-Part Architecture
  const history = createMemoryHistory();
  await history.initialize();
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

  const serialization = new DefaultSerializationApi({ history });
  setSerializationApi(ctx, serialization);

  // Inject mock timer API
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Wait for async operations to complete.
 */
async function flushPromises(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait for a condition to become true.
 */
async function waitFor(condition: () => boolean, timeout = 2000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Create commits in a repository, waiting for each to complete.
 */
async function createCommits(ctx: AppContext, count: number): Promise<void> {
  const actionsModel = getUserActionsModel(ctx);
  const repoModel = getRepositoryModel(ctx);

  for (let i = 0; i < count; i++) {
    const currentCount = repoModel.getState().commitCount;
    enqueueAddFileAction(actionsModel, { name: `file-${i}.txt`, content: `Content ${i}` });
    // Wait for commit count to increase
    await waitFor(() => repoModel.getState().commitCount > currentCount, 5000);
  }
}

/**
 * Simulate sync between two peer contexts using MessageChannel.
 *
 * Creates a MessageChannel and injects one port into each context's
 * peer connections map. Then triggers a sync from ctx1.
 */
async function simulateSync(
  ctx1: AppContext,
  ctx2: AppContext,
  peer1Id: string,
  peer2Id: string,
): Promise<void> {
  // Create a MessageChannel for bidirectional communication
  const channel = new MessageChannel();

  // Add MessagePorts to peer connection maps
  const connections1 = getPeerConnections(ctx1);
  const connections2 = getPeerConnections(ctx2);

  connections1.set(peer2Id, channel.port1);
  connections2.set(peer1Id, channel.port2);

  // Update peers model to trigger connection handlers
  const peersModel1 = getPeersModel(ctx1);
  const peersModel2 = getPeersModel(ctx2);

  peersModel1.addPeer({
    id: peer2Id,
    displayName: "Peer 2",
    status: "connected",
    isHost: false,
    lastSyncAt: null,
  });
  peersModel2.addPeer({
    id: peer1Id,
    displayName: "Peer 1",
    status: "connected",
    isHost: false,
    lastSyncAt: null,
  });

  // Wait for handlers to be set up
  await flushPromises(20);

  // Trigger sync from peer1 (will send data to peer2)
  const actionsModel1 = getUserActionsModel(ctx1);
  enqueueStartSyncAction(actionsModel1, { peerId: peer2Id });

  // Wait for sync to complete
  await flushPromises(50);
}

// NOTE: These tests were written for the old JSON-based sync protocol.
// The new native Git protocol implementation uses MessagePort-based communication
// which is now properly set up above, but the test scenarios themselves need
// a full rewrite to work with the provider-based architecture.
// See p2p-sync-integration.test.ts for working integration tests.
describe.skip("SyncController (needs update for Git protocol)", () => {
  let ctx1: AppContext;
  let ctx2: AppContext;
  let cleanup1: () => void;
  let cleanup2: () => void;
  let syncCleanup1: () => void;
  let syncCleanup2: () => void;

  beforeEach(async () => {
    ctx1 = await createTestAppContext("peer1");
    ctx2 = await createTestAppContext("peer2");

    cleanup1 = createRepositoryController(ctx1);
    cleanup2 = createRepositoryController(ctx2);
    syncCleanup1 = createSyncController(ctx1);
    syncCleanup2 = createSyncController(ctx2);
  });

  afterEach(() => {
    syncCleanup1();
    syncCleanup2();
    cleanup1();
    cleanup2();
  });

  describe("full commit history sync", () => {
    it("should sync all commits when peer has more history", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 60);
      await flushPromises(20);

      const peer1CommitCount = repoModel1.getState().commitCount;
      expect(peer1CommitCount).toBe(61);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      expect(repoModel2.getState().commitCount).toBe(1);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(200);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(50);

      const peer2CommitCount = repoModel2.getState().commitCount;
      expect(peer2CommitCount).toBe(peer1CommitCount);
    });

    it("should sync complete history with 100 commits", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 100);
      await flushPromises(30);

      const peer1Count = repoModel1.getState().commitCount;
      expect(peer1Count).toBe(101);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(300);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(50);

      expect(repoModel2.getState().commitCount).toBe(peer1Count);
    });

    it("should have matching commit messages after sync", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 10);
      await flushPromises(20);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(50);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(20);

      const commits1 = repoModel1.getState().commits;
      const commits2 = repoModel2.getState().commits;

      expect(commits1.length).toBe(commits2.length);

      for (let i = 0; i < commits1.length; i++) {
        expect(commits2[i].message).toBe(commits1[i].message);
      }
    });

    it("should have matching files list after sync", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 5);
      await flushPromises(20);

      const peer1Files = repoModel1.getState().files;
      expect(peer1Files.length).toBeGreaterThan(1);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      expect(repoModel2.getState().files.length).toBe(1);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(50);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(20);

      const peer2Files = repoModel2.getState().files;
      expect(peer2Files.length).toBe(peer1Files.length);

      const peer1FileNames = peer1Files.map((f) => f.name).sort();
      const peer2FileNames = peer2Files.map((f) => f.name).sort();
      expect(peer2FileNames).toEqual(peer1FileNames);
    });

    it("should have matching HEAD commit IDs after sync", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 5);
      await flushPromises(20);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(50);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(20);

      const head1 = repoModel1.getState().headCommitId;
      const head2 = repoModel2.getState().headCommitId;

      expect(head1).toBeTruthy();
      expect(head2).toBeTruthy();

      const headCommit1 = repoModel1.getState().commits.find((c) => c.id === head1);
      const headCommit2 = repoModel2.getState().commits.find((c) => c.id === head2);

      if (!headCommit1 || !headCommit2) {
        throw new Error("HEAD commits not found in commit list");
      }
      expect(headCommit2.message).toBe(headCommit1.message);
    });
  });

  describe("sync with empty peer", () => {
    it("should sync to uninitialized peer", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      await createCommits(ctx1, 5);
      await flushPromises(20);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(50);

      const actionsModel2 = getUserActionsModel(ctx2);
      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(20);

      const peer2State = repoModel2.getState();
      expect(peer2State).toBeDefined();
    });
  });

  describe("bidirectional sync", () => {
    it("should allow both peers to sync their histories", async () => {
      const actionsModel1 = getUserActionsModel(ctx1);
      const actionsModel2 = getUserActionsModel(ctx2);
      const repoModel1 = getRepositoryModel(ctx1);
      const repoModel2 = getRepositoryModel(ctx2);

      enqueueInitRepoAction(actionsModel1);
      await waitFor(() => repoModel1.getState().initialized);

      enqueueInitRepoAction(actionsModel2);
      await waitFor(() => repoModel2.getState().initialized);

      await createCommits(ctx1, 20);
      await flushPromises(20);
      expect(repoModel1.getState().commitCount).toBe(21);

      for (let i = 0; i < 10; i++) {
        enqueueAddFileAction(actionsModel2, {
          name: `peer2-file-${i}.txt`,
          content: `Peer2 Content ${i}`,
        });
        await flushPromises();
      }
      expect(repoModel2.getState().commitCount).toBe(11);

      await simulateSync(ctx1, ctx2, "peer1", "peer2");
      await flushPromises(100);

      enqueueRefreshRepoAction(actionsModel2);
      await flushPromises(20);

      expect(repoModel2.getState().commitCount).toBe(21);
    });
  });
});
