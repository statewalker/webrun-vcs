/**
 * E2E Clone Tests
 *
 * End-to-end tests for full clone operations over MessagePort,
 * verifying complete data transfer from server to client.
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
// Clone Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Clone Empty Repository", () => {
  it("should handle cloning an empty repository gracefully", async () => {
    const serverCtx = await createTestRepository();
    const clientCtx = await createTestRepository();
    const pair = createDuplexPair();

    try {
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

      // Both sides detect empty repo and exit cleanly.
      expect(clientResult.success).toBe(true);
      expect(serverResult.success).toBe(true);
    } finally {
      pair.cleanup();
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

describe("E2E: Clone Repository with History", () => {
  it("should clone a repository with a single commit", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Initial content", {
        "README.md": "# My Project",
      });

      const pair = createDuplexPair();
      const serverFacade = createRepositoryFacade(serverCtx.repository);
      const serverRefStore = createTransportRefStore(serverCtx.repository.refs);
      const clientFacade = createRepositoryFacade(clientCtx.repository);
      const clientRefStore = createTransportRefStore(clientCtx.repository.refs);

      const serverHead = await serverRefStore.get("refs/heads/main");

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

      // Client has the commit
      expect(await clientFacade.has(serverHead!)).toBe(true);
      expect(await clientRefStore.get("refs/heads/main")).toBe(serverHead);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });

  it("should clone a repository with commit chain", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      const commit1 = await createTestCommit(serverCtx.repository, "Commit 1", {
        "a.txt": "a",
      });
      const commit2 = await createTestCommit(serverCtx.repository, "Commit 2", {
        "b.txt": "b",
      });
      const commit3 = await createTestCommit(serverCtx.repository, "Commit 3", {
        "c.txt": "c",
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

      // All commits should be present on client
      expect(await clientFacade.has(commit1)).toBe(true);
      expect(await clientFacade.has(commit2)).toBe(true);
      expect(await clientFacade.has(commit3)).toBe(true);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

describe("E2E: Clone with Multiple Branches", () => {
  it("should clone all branches", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Main commit", {
        "main.txt": "main",
      });

      // Create feature branch at same point
      const mainHead = await serverCtx.repository.refs.resolve("HEAD");
      if (!mainHead?.objectId) throw new Error("HEAD not found");
      await serverCtx.repository.refs.set("refs/heads/feature", mainHead.objectId);
      await serverCtx.repository.refs.set("refs/heads/develop", mainHead.objectId);

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

      // All branch refs should be present
      expect(await clientRefStore.get("refs/heads/main")).toBe(mainHead.objectId);
      expect(await clientRefStore.get("refs/heads/feature")).toBe(mainHead.objectId);
      expect(await clientRefStore.get("refs/heads/develop")).toBe(mainHead.objectId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});

describe("E2E: Clone with Tags", () => {
  it("should clone repository with tags", async () => {
    const serverCtx = await createInitializedTestRepository();
    const clientCtx = await createTestRepository();

    try {
      await createTestCommit(serverCtx.repository, "Release commit", {
        "release.txt": "v1.0",
      });

      const head = await serverCtx.repository.refs.resolve("HEAD");
      if (!head?.objectId) throw new Error("HEAD not found");
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

      expect(await clientRefStore.get("refs/tags/v1.0")).toBe(head.objectId);
    } finally {
      await serverCtx.cleanup();
      await clientCtx.cleanup();
    }
  });
});
