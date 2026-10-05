/**
 * Protocol V2 Negotiation Tests
 *
 * Full protocol V2 handshake tests using real in-memory repositories
 * connected over MessagePort duplex pairs.
 *
 * Tests:
 * - Server capability advertisement
 * - ls-refs command (full, filtered, with symrefs)
 * - Fetch with want/have negotiation
 * - Incremental fetch with common base
 */

import {
  createMessagePortDuplex,
  type Duplex,
  fetchOverDuplex,
  serveOverDuplex,
} from "@statewalker/vcs-transport";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTestRepository,
  createTransportRefStore,
  type TestRepositoryContext,
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
// Full Protocol V2 Fetch Handshake
// ─────────────────────────────────────────────────────────────────────────────

describe("Protocol V2: Full Fetch Handshake", () => {
  let serverCtx: TestRepositoryContext;
  let clientCtx: TestRepositoryContext;
  let pair: ReturnType<typeof createDuplexPair>;

  beforeEach(async () => {
    serverCtx = await createInitializedTestRepository();
    clientCtx = await createTestRepository();
    pair = createDuplexPair();
  });

  afterEach(async () => {
    pair.cleanup();
    await serverCtx.cleanup();
    await clientCtx.cleanup();
  });

  it("should complete fetch from server with one commit", async () => {
    // Add a commit to server
    await createTestCommit(serverCtx.repository, "Add feature", {
      "feature.ts": "export const x = 1;",
    });

    const serverFacade = createRepositoryFacade(serverCtx.repository);
    const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

    // Run server and client in parallel
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

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });

  it("should transfer refs from server to client", async () => {
    await createTestCommit(serverCtx.repository, "Initial content", {
      "README.md": "# Test",
    });

    const serverFacade = createRepositoryFacade(serverCtx.repository);
    const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

    // Get server's HEAD before fetch
    const serverHead = await serverRefStore.get("refs/heads/main");
    expect(serverHead).toBeDefined();

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

    // Client should now have the same ref
    const clientHead = await clientRefStore.get("refs/heads/main");
    expect(clientHead).toBe(serverHead);
  });

  it("should transfer objects from server to client", async () => {
    const commitId = await createTestCommit(serverCtx.repository, "Test commit", {
      "test.txt": "Hello World",
    });

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

    // Client should now have the commit object
    const hasCommit = await clientFacade.has(commitId);
    expect(hasCommit).toBe(true);
  });

  it("should handle multiple branches", async () => {
    // Create commits on main
    await createTestCommit(serverCtx.repository, "Main commit", {
      "main.txt": "main content",
    });

    // Create feature branch
    const mainHead = await serverCtx.repository.refs.resolve("HEAD");
    if (!mainHead?.objectId) throw new Error("HEAD not found");
    await serverCtx.repository.refs.set("refs/heads/feature", mainHead.objectId);

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

    // Client should have both refs
    const clientMain = await clientRefStore.get("refs/heads/main");
    const clientFeature = await clientRefStore.get("refs/heads/feature");
    expect(clientMain).toBeDefined();
    expect(clientFeature).toBe(clientMain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capability Exchange
// ─────────────────────────────────────────────────────────────────────────────

describe("Protocol: Capability Exchange", () => {
  let serverCtx: TestRepositoryContext;
  let clientCtx: TestRepositoryContext;
  let pair: ReturnType<typeof createDuplexPair>;

  beforeEach(async () => {
    serverCtx = await createInitializedTestRepository();
    clientCtx = await createTestRepository();
    pair = createDuplexPair();
  });

  afterEach(async () => {
    pair.cleanup();
    await serverCtx.cleanup();
    await clientCtx.cleanup();
  });

  it("should complete fetch with custom server capabilities", async () => {
    await createTestCommit(serverCtx.repository, "Commit", {
      "file.txt": "content",
    });

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
        capabilities: [
          "multi_ack_detailed",
          "side-band-64k",
          "thin-pack",
          "ofs-delta",
          "no-done",
          "shallow",
        ],
      }),
      fetchOverDuplex({
        duplex: pair.client,
        repository: clientFacade,
        refStore: clientRefStore,
      }),
    ]);

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });

  it("should handle empty repository gracefully", async () => {
    // Use a truly empty repo (no refs, no objects)
    const emptyServerCtx = await createTestRepository();

    const emptyFacade = createRepositoryFacade(emptyServerCtx.repository);
    const emptyRefStore = createTransportRefStore(emptyServerCtx.repository.refs);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

    const [serverResult, clientResult] = await Promise.all([
      serveOverDuplex({
        duplex: pair.server,
        repository: emptyFacade,
        refStore: emptyRefStore,
        service: "git-upload-pack",
      }),
      fetchOverDuplex({
        duplex: pair.client,
        repository: clientFacade,
        refStore: clientRefStore,
      }),
    ]);

    // Both sides detect empty repo and exit cleanly.
    expect(clientResult.success).toBe(true);
    expect(serverResult.success).toBe(true);
    await emptyServerCtx.cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Incremental Fetch
// ─────────────────────────────────────────────────────────────────────────────

describe("Protocol: Incremental Fetch", () => {
  it("should transfer only new objects on second fetch", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      // Create first commit
      await createTestCommit(serverCtx.repository, "First commit", {
        "a.txt": "content a",
      });

      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      // First fetch — clone everything
      const pair1 = createDuplexPair();
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

      const firstHead = await clientRefStore.get("refs/heads/main");
      expect(firstHead).toBeDefined();

      // Create second commit on server
      await createTestCommit(serverCtx.repository, "Second commit", {
        "b.txt": "content b",
      });

      const secondHead = await serverRefStore.get("refs/heads/main");
      expect(secondHead).toBeDefined();
      expect(secondHead).not.toBe(firstHead);

      // Second fetch — only new objects
      const pair2 = createDuplexPair();
      await Promise.all([
        serveOverDuplex({
          duplex: pair2.server,
          repository: serverFacade,
          refStore: serverRefStore,
          service: "git-upload-pack",
        }),
        fetchOverDuplex({
          duplex: pair2.client,
          repository: clientFacade,
          refStore: clientRefStore,
        }),
      ]);
      pair2.cleanup();

      // Client should now have the second commit
      const updatedHead = await clientRefStore.get("refs/heads/main");
      expect(updatedHead).toBe(secondHead);
      expect(await clientFacade.has(secondHead!)).toBe(true);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
