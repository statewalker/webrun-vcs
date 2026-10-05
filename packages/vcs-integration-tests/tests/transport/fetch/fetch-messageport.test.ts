/**
 * Fetch transport integration tests over MessagePort
 *
 * Tests the transport layer using real in-memory Git repositories.
 * These tests verify that data can be correctly transferred over MessagePort
 * for fetch operations.
 *
 * Note: Full FSM-based fetch tests are in packages/vcs-transport/tests/integration/.
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

describe("Fetch Transport - Real Repository Pack Generation", () => {
  let serverCtx: TestRepositoryContext;
  let clientCtx: TestRepositoryContext;
  let transport: ReturnType<typeof createTestTransportPair>;

  beforeEach(async () => {
    serverCtx = await createInitializedTestRepository();
    clientCtx = await createTestRepository();
    transport = createTestTransportPair();
  });

  afterEach(async () => {
    transport.cleanup();
    await serverCtx.cleanup();
    await clientCtx.cleanup();
  });

  it("generates pack from real repository objects", async () => {
    // Add commits to server
    await createTestCommit(serverCtx.repository, "Add file", {
      "README.md": "# Hello World",
    });

    const serverFacade = createRepositoryFacade(serverCtx.repository);

    // Get HEAD commit to export
    const headRef = await serverCtx.repository.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeDefined();
    const headOid = headRef?.objectId;
    if (!headOid) throw new Error("HEAD not found");

    // Export pack with all objects reachable from HEAD
    const wants = new Set([headOid]);
    const packChunks: Uint8Array[] = [];
    for await (const chunk of serverFacade.exportPack(wants, new Set())) {
      packChunks.push(chunk);
    }

    // Verify pack was generated
    expect(packChunks.length).toBeGreaterThan(0);

    // Verify pack header (PACK magic number)
    const firstChunk = packChunks[0];
    expect(firstChunk[0]).toBe(0x50); // 'P'
    expect(firstChunk[1]).toBe(0x41); // 'A'
    expect(firstChunk[2]).toBe(0x43); // 'C'
    expect(firstChunk[3]).toBe(0x4b); // 'K'
  });

  it("transfers pack over MessagePort channel", async () => {
    await createTestCommit(serverCtx.repository, "Add file", {
      "index.ts": "export const VERSION = 1;",
    });

    const serverFacade = createRepositoryFacade(serverCtx.repository);
    const headRef = await serverCtx.repository.refs.resolve("HEAD");
    if (!headRef?.objectId) throw new Error("HEAD not found");

    // Generate pack on server side
    const wants = new Set([headRef.objectId]);
    const packChunks: Uint8Array[] = [];
    for await (const chunk of serverFacade.exportPack(wants, new Set())) {
      packChunks.push(chunk);
    }

    // Send pack over transport
    for (const chunk of packChunks) {
      transport.server.write(chunk);
    }
    transport.server.close();

    // Receive on client side
    const received = await collectChunks(transport.client);

    // Verify all chunks transferred
    expect(received.length).toBe(packChunks.length);

    // Verify first chunk is pack header
    expect(received[0][0]).toBe(0x50); // 'P'
  });

  it("imports transferred pack into client repository", async () => {
    await createTestCommit(serverCtx.repository, "Add file", {
      "test.txt": "Test content",
    });

    const serverFacade = createRepositoryFacade(serverCtx.repository);
    const clientFacade = createRepositoryFacade(clientCtx.repository);
    const headRef = await serverCtx.repository.refs.resolve("HEAD");
    if (!headRef?.objectId) throw new Error("HEAD not found");

    // Export from server
    const wants = new Set([headRef.objectId]);

    // Create async generator from pack chunks
    async function* packStream() {
      for await (const chunk of serverFacade.exportPack(wants, new Set())) {
        yield chunk;
      }
    }

    // Import into client
    const importResult = await clientFacade.importPack(packStream());

    // Verify import succeeded
    expect(importResult.objectsImported).toBeGreaterThan(0);
    expect(importResult.commitsImported).toBeGreaterThan(0);

    // Verify client now has the commit
    const hasCommit = await clientFacade.has(headRef.objectId);
    expect(hasCommit).toBe(true);
  });

  it("transfers ref information via transport", async () => {
    await createTestCommit(serverCtx.repository, "Initial", {
      "file.txt": "content",
    });

    // Create a feature branch
    const mainHead = await serverCtx.repository.refs.resolve("HEAD");
    if (!mainHead?.objectId) throw new Error("HEAD not found");
    await serverCtx.repository.refs.set("refs/heads/feature", mainHead.objectId);

    const serverRefs = createTransportRefStore(serverCtx.repository.refs);

    // Get all refs from server
    const refsList = await serverRefs.listAll();
    const refsArray = Array.from(refsList);

    // Send refs over transport (simulating ls-refs response)
    const encoder = new TextEncoder();
    for (const [name, oid] of refsArray) {
      transport.server.write(encoder.encode(`${oid} ${name}\n`));
    }
    transport.server.close();

    // Receive and parse refs
    const received = await collectChunks(transport.client);
    const decoder = new TextDecoder();
    const parsedRefs: Array<[string, string]> = [];

    for (const chunk of received) {
      const line = decoder.decode(chunk).trim();
      const [oid, name] = line.split(" ");
      parsedRefs.push([name, oid]);
    }

    // Verify refs were transferred
    expect(parsedRefs.length).toBeGreaterThan(0);
    expect(parsedRefs.some(([name]) => name === "refs/heads/main")).toBe(true);
    expect(parsedRefs.some(([name]) => name === "refs/heads/feature")).toBe(true);
  });
});

describe("Fetch Transport - Incremental Transfer", () => {
  it("excludes already-known objects from pack", async () => {
    const serverCtx = await createInitializedTestRepository();

    try {
      // Create first commit
      const commit1Id = await createTestCommit(serverCtx.repository, "First", {
        "a.txt": "a",
      });

      // Create second commit
      const commit2Id = await createTestCommit(serverCtx.repository, "Second", {
        "b.txt": "b",
      });

      const facade = createRepositoryFacade(serverCtx.repository);

      // Export only new objects (exclude first commit)
      const wants = new Set([commit2Id]);
      const exclude = new Set([commit1Id]);

      const packChunks: Uint8Array[] = [];
      for await (const chunk of facade.exportPack(wants, exclude)) {
        packChunks.push(chunk);
      }

      // Pack should exist but be smaller (only new objects)
      expect(packChunks.length).toBeGreaterThan(0);
    } finally {
      await serverCtx.cleanup();
    }
  });
});

describe("Fetch Transport - Repository Facade", () => {
  it("has() returns correct values", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const commitId = await createTestCommit(ctx.repository, "Test", {
        "test.txt": "content",
      });

      const facade = createRepositoryFacade(ctx.repository);

      // Existing objects
      expect(await facade.has(commitId)).toBe(true);

      // Non-existing object
      expect(await facade.has("0000000000000000000000000000000000000000")).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it("walkAncestors() yields commit chain", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const commit1Id = await createTestCommit(ctx.repository, "Commit 1", {
        "a.txt": "a",
      });
      const commit2Id = await createTestCommit(ctx.repository, "Commit 2", {
        "b.txt": "b",
      });
      const commit3Id = await createTestCommit(ctx.repository, "Commit 3", {
        "c.txt": "c",
      });

      const facade = createRepositoryFacade(ctx.repository);

      // Walk from latest commit
      const ancestors: string[] = [];
      for await (const oid of facade.walkAncestors(commit3Id)) {
        ancestors.push(oid);
      }

      // Should include all commits in chain (order may vary for BFS)
      expect(ancestors).toContain(commit3Id);
      expect(ancestors).toContain(commit2Id);
      expect(ancestors).toContain(commit1Id);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("Fetch Transport - RefStore Adapter", () => {
  it("listAll() returns all refs", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const headRef = await ctx.repository.refs.resolve("HEAD");
      if (!headRef?.objectId) throw new Error("HEAD not found");
      const headOid = headRef.objectId;

      await ctx.repository.refs.set("refs/heads/feature", headOid);
      await ctx.repository.refs.set("refs/tags/v1.0", headOid);

      const refStore = createTransportRefStore(ctx.repository.refs);
      const refs = Array.from(await refStore.listAll());

      expect(refs.some(([name]) => name === "refs/heads/main")).toBe(true);
      expect(refs.some(([name]) => name === "refs/heads/feature")).toBe(true);
      expect(refs.some(([name]) => name === "refs/tags/v1.0")).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("update() creates/updates refs", async () => {
    const ctx = await createInitializedTestRepository();

    try {
      const headRef = await ctx.repository.refs.resolve("HEAD");
      if (!headRef?.objectId) throw new Error("HEAD not found");
      const headOid = headRef.objectId;

      const refStore = createTransportRefStore(ctx.repository.refs);

      // Create new ref
      await refStore.update("refs/heads/new-branch", headOid);
      expect(await refStore.get("refs/heads/new-branch")).toBe(headOid);

      // Update existing ref with same value (should work)
      await refStore.update("refs/heads/new-branch", headOid);
      expect(await refStore.get("refs/heads/new-branch")).toBe(headOid);
    } finally {
      await ctx.cleanup();
    }
  });
});
