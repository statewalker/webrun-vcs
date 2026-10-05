/**
 * Push transport integration tests over MessagePort
 *
 * Tests the transport layer using real in-memory Git repositories.
 * These tests verify that data can be correctly transferred over MessagePort
 * for push operations.
 *
 * Note: Full FSM-based push tests are in packages/vcs-transport/tests/integration/.
 * These tests focus on the repository integration aspects.
 */

import { createMessagePortDuplex, type Duplex } from "@statewalker/vcs-transport";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInitializedTestRepository,
  createRepositoryFacade,
  createTestCommit,
  createTestRepository,
  createTransportRefStore,
  type TestRepositoryContext,
} from "../helpers/index.js";

/**
 * Duplex with close method for tests
 */
interface DuplexWithClose extends Duplex {
  close(): Promise<void>;
}

/**
 * Create a connected pair of MessagePort transports for testing.
 */
function createTestTransportPair(): {
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

// Helper to collect all chunks from a reader
async function collectChunks(reader: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const result: Uint8Array[] = [];
  for await (const chunk of reader) {
    result.push(chunk);
  }
  return result;
}

describe("Push Transport - Repository Preparation", () => {
  let clientCtx: TestRepositoryContext;
  let serverCtx: TestRepositoryContext;
  let transport: ReturnType<typeof createTestTransportPair>;

  beforeEach(async () => {
    clientCtx = await createInitializedTestRepository();
    serverCtx = await createTestRepository();
    transport = createTestTransportPair();
  });

  afterEach(async () => {
    transport.cleanup();
    await clientCtx.cleanup();
    await serverCtx.cleanup();
  });

  it("creates commits on client for push", async () => {
    await createTestCommit(clientCtx.repository, "New feature", {
      "feature.ts": "export function feature() {}",
    });

    const headRef = await clientCtx.repository.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeDefined();

    // Verify commit exists
    const hasCommit = await clientCtx.repository.commits.has(headRef?.objectId ?? "");
    expect(hasCommit).toBe(true);
  });

  it("server can receive ref updates", async () => {
    // Initialize server with main branch
    serverCtx = await createInitializedTestRepository();

    const serverRefs = createTransportRefStore(serverCtx.repository.refs);

    // Get current HEAD
    const initialOid = await serverRefs.get("refs/heads/main");
    expect(initialOid).toBeDefined();

    // Simulate receiving a new commit OID
    const newOid = "abc123def456abc123def456abc123def456abc1";
    await serverRefs.update("refs/heads/feature", newOid);

    // Verify ref was created
    expect(await serverRefs.get("refs/heads/feature")).toBe(newOid);
  });
});

describe("Push Transport - Data Transfer", () => {
  it("transfers binary data from client to server", async () => {
    const transport = createTestTransportPair();

    try {
      // Simulate pack data
      const packData = new Uint8Array([
        0x50,
        0x41,
        0x43,
        0x4b, // "PACK"
        0x00,
        0x00,
        0x00,
        0x02, // version 2
        0x00,
        0x00,
        0x00,
        0x01, // 1 object
        // ... more data would follow
      ]);

      // Send from client
      transport.client.write(packData);
      transport.client.close();

      // Receive on server
      const received = await collectChunks(transport.server);

      expect(received.length).toBe(1);
      expect(received[0]).toEqual(packData);
    } finally {
      transport.cleanup();
    }
  });

  it("transfers ref update commands", async () => {
    const transport = createTestTransportPair();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    try {
      // Simulate ref update command
      const oldOid = "0000000000000000000000000000000000000000";
      const newOid = "abc123def456abc123def456abc123def456abc1";
      const refName = "refs/heads/feature";

      const command = `${oldOid} ${newOid} ${refName}\n`;
      transport.client.write(encoder.encode(command));
      transport.client.close();

      // Receive on server
      const received = await collectChunks(transport.server);

      expect(received.length).toBe(1);
      const receivedCommand = decoder.decode(received[0]);
      expect(receivedCommand).toContain(oldOid);
      expect(receivedCommand).toContain(newOid);
      expect(receivedCommand).toContain(refName);
    } finally {
      transport.cleanup();
    }
  });
});

describe("Push Transport - Repository Facade", () => {
  it("checks object existence on server", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const commitId = await createTestCommit(ctx.repository, "Test commit", {
        "test.txt": "content",
      });

      const facade = createRepositoryFacade(ctx.repository);

      // Object exists
      expect(await facade.has(commitId)).toBe(true);

      // Object doesn't exist
      expect(await facade.has("nonexistent0000000000000000000000000")).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it("walks ancestors for negotiation", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const commit1 = await createTestCommit(ctx.repository, "Commit 1", {
        "a.txt": "a",
      });
      const commit2 = await createTestCommit(ctx.repository, "Commit 2", {
        "b.txt": "b",
      });

      const facade = createRepositoryFacade(ctx.repository);

      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(commit2)) {
        ancestors.push(oid);
      }

      expect(ancestors).toContain(commit2);
      expect(ancestors).toContain(commit1);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("Push Transport - RefStore Operations", () => {
  it("updates refs atomically", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const headRef = await ctx.repository.refs.resolve("HEAD");
      if (!headRef?.objectId) throw new Error("HEAD not found");

      const refStore = createTransportRefStore(ctx.repository.refs);

      // Create branch
      await refStore.update("refs/heads/new-feature", headRef.objectId);
      expect(await refStore.get("refs/heads/new-feature")).toBe(headRef.objectId);

      // List all refs
      const allRefs = Array.from(await refStore.listAll());
      expect(allRefs.some(([name]) => name === "refs/heads/new-feature")).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("getSymrefTarget returns symbolic ref target", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const refStore = createTransportRefStore(ctx.repository.refs);

      // HEAD is a symbolic ref pointing to refs/heads/main
      const target = await refStore.getSymrefTarget?.("HEAD");
      expect(target).toBe("refs/heads/main");

      // Non-symbolic refs return undefined
      const nonSymbolic = await refStore.getSymrefTarget?.("refs/heads/main");
      expect(nonSymbolic).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it("isRefTip checks if OID is a ref tip", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      await createTestCommit(ctx.repository, "Head commit", {
        "file.txt": "content",
      });

      const headRef = await ctx.repository.refs.resolve("HEAD");
      if (!headRef?.objectId) throw new Error("HEAD not found");

      const refStore = createTransportRefStore(ctx.repository.refs);

      // HEAD OID is a tip
      const isTip = await refStore.isRefTip?.(headRef.objectId);
      expect(isTip).toBe(true);

      // Random OID is not a tip
      const notTip = await refStore.isRefTip?.("abc123def456abc123def456abc123def456abc1");
      expect(notTip).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });
});
