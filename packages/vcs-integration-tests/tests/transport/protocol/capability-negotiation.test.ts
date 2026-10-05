/**
 * Capability Negotiation Tests
 *
 * Tests capability exchange between client and server during the
 * Git protocol handshake, verifying that capabilities are correctly
 * negotiated and honored.
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Capability Negotiation: Default Capabilities", () => {
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

  it("should succeed with default server capabilities", async () => {
    await createTestCommit(serverCtx.repository, "Test", { "f.txt": "data" });

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

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });
});

describe("Capability Negotiation: Sideband Modes", () => {
  let serverCtx: TestRepositoryContext;
  let clientCtx: TestRepositoryContext;

  beforeEach(async () => {
    serverCtx = await createInitializedTestRepository();
    clientCtx = await createTestRepository();
    await createTestCommit(serverCtx.repository, "Test", { "f.txt": "data" });
  });

  afterEach(async () => {
    await serverCtx.cleanup();
    await clientCtx.cleanup();
  });

  it("should fetch with side-band-64k", async () => {
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
        capabilities: ["multi_ack_detailed", "side-band-64k", "thin-pack", "ofs-delta", "no-done"],
      }),
      fetchOverDuplex({
        duplex: pair.client,
        repository: clientFacade,
        refStore: clientRefStore,
      }),
    ]);
    pair.cleanup();

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });

  it("should fetch with minimal capabilities", async () => {
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
        capabilities: ["side-band-64k"],
      }),
      fetchOverDuplex({
        duplex: pair.client,
        repository: clientFacade,
        refStore: clientRefStore,
      }),
    ]);
    pair.cleanup();

    expect(serverResult.success).toBe(true);
    expect(clientResult.success).toBe(true);
  });
});

describe("Capability Negotiation: Pack Transfer Integrity", () => {
  it("should verify imported objects match exported objects", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      // Create a commit with known content
      const commitId = await createTestCommit(serverCtx.repository, "Known content", {
        "hello.txt": "Hello, World!",
        "config.json": '{"key": "value"}',
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

      // Verify the commit exists on client
      const hasCommit = await clientFacade.has(commitId);
      expect(hasCommit).toBe(true);

      // Walk ancestors from the commit — should find the full chain
      const ancestors: string[] = [];
      for await (const oid of clientFacade.walkAncestors(commitId)) {
        ancestors.push(oid);
      }
      expect(ancestors.length).toBeGreaterThanOrEqual(1);
      expect(ancestors).toContain(commitId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });

  it("should verify all refs are present after fetch", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Commit 1", { "a.txt": "a" });

      // Create multiple branches
      const head = await serverCtx.repository.refs.resolve("HEAD");
      if (!head?.objectId) throw new Error("HEAD not found");
      await serverCtx.repository.refs.set("refs/heads/dev", head.objectId);
      await serverCtx.repository.refs.set("refs/tags/v1.0", head.objectId);

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

      // Verify all refs were transferred
      const clientMain = await clientRefStore.get("refs/heads/main");
      const clientDev = await clientRefStore.get("refs/heads/dev");
      const clientTag = await clientRefStore.get("refs/tags/v1.0");

      expect(clientMain).toBe(head.objectId);
      expect(clientDev).toBe(head.objectId);
      expect(clientTag).toBe(head.objectId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
