/**
 * E2E Conflict Resolution Tests
 *
 * Tests for handling divergent histories, fast-forward scenarios,
 * and ref update conflicts during transport operations.
 */

import {
  createMessagePortDuplex,
  type Duplex,
  fetchOverDuplex,
  serveOverDuplex,
} from "@statewalker/vcs-transport";
import { describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTransportRefStore,
} from "../helpers/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DuplexWithClose extends Duplex {
  close(): Promise<void>;
}

function createDuplexPair(): {
  client: DuplexWithClose;
  server: DuplexWithClose;
  cleanup: () => void;
} {
  const channel = new MessageChannel();
  return {
    client: createMessagePortDuplex(channel.port1) as DuplexWithClose,
    server: createMessagePortDuplex(channel.port2) as DuplexWithClose,
    cleanup: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast-Forward Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Fast-Forward Fetch", () => {
  it("should fast-forward client ref when server is ahead", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createInitializedTestRepository();

    try {
      // Both repos start at same initial commit
      const clientHead = await clientCtx.repository.refs.resolve("HEAD");
      expect(clientHead?.objectId).toBeDefined();

      // Server advances with 2 more commits
      await createTestCommit(serverCtx.repository, "Server advance 1", {
        "s1.txt": "server 1",
      });
      const serverHeadCommit = await createTestCommit(serverCtx.repository, "Server advance 2", {
        "s2.txt": "server 2",
      });

      // Fetch from server to client
      const pair = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      await Promise.all([
        serveOverDuplex({
          duplex: pair.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair.cleanup();

      // Client should be at server's HEAD now
      const updatedClientHead = await clientRefStore.get("refs/heads/main");
      expect(updatedClientHead).toBe(serverHeadCommit);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Divergent History Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Divergent Histories", () => {
  it("should handle fetch when both sides have diverged", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createInitializedTestRepository();

    try {
      // Server creates unique commits
      await createTestCommit(serverCtx.repository, "Server-only commit", {
        "server-file.txt": "server content",
      });

      // Client creates different commits
      await createTestCommit(clientCtx.repository, "Client-only commit", {
        "client-file.txt": "client content",
      });

      // Fetch server's state into client
      const pair = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      const [serverResult, clientResult] = await Promise.all([
        serveOverDuplex({
          duplex: pair.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair.cleanup();

      // Both sides should succeed — fetch updates refs
      expect(serverResult.success).toBe(true);
      expect(clientResult.success).toBe(true);

      // Client's refs/heads/main is updated to server's value
      const serverHead = await serverRefStore.get("refs/heads/main");
      const clientHead = await clientRefStore.get("refs/heads/main");
      expect(clientHead).toBe(serverHead);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });

  it("should preserve server objects after fetch from diverged repo", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createInitializedTestRepository();

    try {
      const serverCommit = await createTestCommit(serverCtx.repository, "Server commit", {
        "s.txt": "server",
      });

      const pair = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      await Promise.all([
        serveOverDuplex({
          duplex: pair.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair.cleanup();

      // Client now has server's commit object
      expect(await clientFacade.has(serverCommit)).toBe(true);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ref Update Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Ref Update Behavior", () => {
  it("should update all advertised refs on client after fetch", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createInitializedTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Server commit", {
        "data.txt": "data",
      });

      const serverHead = await serverCtx.repository.refs.resolve("HEAD");
      if (!serverHead?.objectId) throw new Error("HEAD not found");

      // Create additional refs on server
      await serverCtx.repository.refs.set("refs/heads/dev", serverHead.objectId);
      await serverCtx.repository.refs.set("refs/tags/release", serverHead.objectId);

      const pair = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      await Promise.all([
        serveOverDuplex({
          duplex: pair.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair.cleanup();

      // All server refs should be on client
      expect(await clientRefStore.get("refs/heads/main")).toBe(serverHead.objectId);
      expect(await clientRefStore.get("refs/heads/dev")).toBe(serverHead.objectId);
      expect(await clientRefStore.get("refs/tags/release")).toBe(serverHead.objectId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
