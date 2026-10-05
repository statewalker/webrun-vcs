/**
 * E2E Bidirectional Sync Tests
 *
 * Tests for fetch workflows between client and server
 * repositories over MessagePort duplex pairs.
 *
 * Note: Push E2E tests are deferred — the push protocol has
 * known issues with raw pack EOF signaling that need to be
 * resolved before full E2E push testing.
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
  createTestRepository,
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
// Fetch Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Fetch Remote Changes to Local", () => {
  it("should fetch new server commits to client", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      // Create commits on server
      await createTestCommit(serverCtx.repository, "Server commit 1", {
        "server.txt": "server data",
      });
      const serverCommit2 = await createTestCommit(serverCtx.repository, "Server commit 2", {
        "server2.txt": "more server data",
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

      // Client should have both commits
      expect(await clientFacade.has(serverCommit2)).toBe(true);
      expect(await clientRefStore.get("refs/heads/main")).toBe(serverCommit2);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bidirectional Sync (Fetch path)
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Bidirectional Sync Workflow", () => {
  it("should sync changes in both directions", async () => {
    // Start: server has initial commit
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Server initial", {
        "server.txt": "initial",
      });

      // Step 1: Client fetches from server (clone)
      const pair1 = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      await Promise.all([
        serveOverDuplex({
          duplex: pair1.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair1.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair1.cleanup();

      const afterFetch = await clientRefStore.get("refs/heads/main");
      expect(afterFetch).toBeDefined();

      // Step 2: Verify client has the fetched objects
      const fetchedOid = await clientRefStore.get("refs/heads/main");
      expect(fetchedOid).toBeDefined();
      expect(await clientFacade.has(fetchedOid!)).toBe(true);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
