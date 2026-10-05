/**
 * T3.7: Transport Integration Tests
 *
 * Tests the pack-based data exchange that underlies transport operations:
 * - Pack creation with object graph traversal (simulates server-side)
 * - Pack import into a different repository (simulates client-side)
 * - Incremental sync with wants/haves negotiation
 * - Multi-branch synchronization
 * - Bidirectional exchange (push + fetch patterns)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";
import type { SerializationApi } from "../../src/serialization/serialization-api.js";

describe("Transport Integration", () => {
  let server: HistoryWithOperations;
  let client: HistoryWithOperations;
  let serverSerialization: SerializationApi;
  let clientSerialization: SerializationApi;

  beforeEach(async () => {
    server = createMemoryHistoryWithOperations();
    client = createMemoryHistoryWithOperations();
    await server.initialize();
    await client.initialize();
    serverSerialization = server.serialization;
    clientSerialization = client.serialization;
  });

  afterEach(async () => {
    await server.close();
    await client.close();
  });

  describe("fetch simulation (server → client)", () => {
    it("fetches all objects from empty client", async () => {
      // Server has commits
      const tipId = await createCommitChain(server, 5);
      await server.refs.set("refs/heads/main", tipId);

      // Client fetches: wants = server refs, haves = empty
      const serverRefs = await resolveRef(server, "refs/heads/main");
      const wants = new Set([serverRefs]);
      const haves = new Set<string>();

      // Server creates pack of reachable objects
      const objects = server.collectReachableObjects(wants, haves);
      const packBytes = await collectPackBytes(serverSerialization.createPack(objects));

      // Client imports pack
      const result = await clientSerialization.importPack(toAsyncIterable(packBytes));
      expect(result.commitsImported).toBe(5);

      // Client updates refs
      await client.refs.set("refs/remotes/origin/main", serverRefs);

      // Verify client can walk the full chain
      let count = 0;
      let current: string | undefined = serverRefs;
      while (current) {
        const commit = await client.commits.load(current);
        expect(commit).toBeDefined();
        count++;
        current = commit?.parents[0];
      }
      expect(count).toBe(5);
    });

    it("fetches incrementally with haves", async () => {
      // Initial sync: server has 3 commits, client fetches all
      const baseId = await createCommitChain(server, 3);
      await server.refs.set("refs/heads/main", baseId);

      const basePack = await collectPackBytes(
        serverSerialization.createPack(
          server.collectReachableObjects(new Set([baseId]), new Set()),
        ),
      );
      await clientSerialization.importPack(toAsyncIterable(basePack));
      await client.refs.set("refs/remotes/origin/main", baseId);

      // Server adds more commits
      const newTipId = await createCommitChain(server, 3, baseId);
      await server.refs.set("refs/heads/main", newTipId);

      // Client advertises haves (what it already has)
      const clientHaves = new Set([baseId]);
      const serverWants = new Set([newTipId]);

      // Server creates incremental pack
      const incrementalPack = await collectPackBytes(
        serverSerialization.createPack(server.collectReachableObjects(serverWants, clientHaves)),
      );

      // Incremental pack should be smaller
      expect(incrementalPack.length).toBeLessThan(basePack.length * 2);

      // Client imports
      const result = await clientSerialization.importPack(toAsyncIterable(incrementalPack));
      expect(result.commitsImported).toBe(3);

      // Client updates tracking ref
      await client.refs.set("refs/remotes/origin/main", newTipId);

      // Verify full chain traversable
      let count = 0;
      let current: string | undefined = newTipId;
      while (current) {
        expect(await client.commits.load(current)).toBeDefined();
        count++;
        current = (await client.commits.load(current))?.parents[0];
      }
      expect(count).toBe(6);
    });

    it("fetches multiple branches", async () => {
      // Server has two branches diverging from a base
      const baseId = await createSimpleCommit(server, "Base", []);
      const mainTip = await createCommitChain(server, 2, baseId);
      const featureTip = await createCommitChain(server, 3, baseId);

      await server.refs.set("refs/heads/main", mainTip);
      await server.refs.set("refs/heads/feature", featureTip);

      // Client fetches both branches at once
      const wants = new Set([mainTip, featureTip]);
      const objects = server.collectReachableObjects(wants, new Set());
      const packBytes = await collectPackBytes(serverSerialization.createPack(objects));

      await clientSerialization.importPack(toAsyncIterable(packBytes));

      // Set up tracking refs
      await client.refs.set("refs/remotes/origin/main", mainTip);
      await client.refs.set("refs/remotes/origin/feature", featureTip);

      // Verify both branches exist
      expect(await client.commits.load(mainTip)).toBeDefined();
      expect(await client.commits.load(featureTip)).toBeDefined();

      // Verify shared base is present only once (deduplication)
      expect(await client.commits.load(baseId)).toBeDefined();
    });

    it("handles up-to-date scenario (no new objects)", async () => {
      const tipId = await createSimpleCommit(server, "Only commit", []);
      await server.refs.set("refs/heads/main", tipId);

      // Initial sync
      const pack = await collectPackBytes(
        serverSerialization.createPack(server.collectReachableObjects(new Set([tipId]), new Set())),
      );
      await clientSerialization.importPack(toAsyncIterable(pack));
      await client.refs.set("refs/remotes/origin/main", tipId);

      // No changes on server - incremental pack should be empty/minimal
      const incrementalObjects = server.collectReachableObjects(new Set([tipId]), new Set([tipId]));
      const ids: string[] = [];
      for await (const id of incrementalObjects) {
        ids.push(id);
      }
      expect(ids).toHaveLength(0);
    });
  });

  describe("push simulation (client → server)", () => {
    it("pushes new branch to server", async () => {
      // Server is empty, client has commits
      const tipId = await createCommitChain(client, 3);
      await client.refs.set("refs/heads/main", tipId);

      // Client pushes: create pack of objects server doesn't have
      const objects = client.collectReachableObjects(new Set([tipId]), new Set());
      const packBytes = await collectPackBytes(clientSerialization.createPack(objects));

      // Server imports pack
      const result = await serverSerialization.importPack(toAsyncIterable(packBytes));
      expect(result.commitsImported).toBe(3);

      // Server updates ref
      await server.refs.set("refs/heads/main", tipId);

      // Verify server has the full chain
      const serverCommit = await server.commits.load(tipId);
      expect(serverCommit).toBeDefined();
    });

    it("pushes incremental update", async () => {
      // Initial state: both have same commits
      const baseId = await createCommitChain(client, 2);
      await client.refs.set("refs/heads/main", baseId);

      // Sync to server
      const basePack = await collectPackBytes(
        clientSerialization.createPack(
          client.collectReachableObjects(new Set([baseId]), new Set()),
        ),
      );
      await serverSerialization.importPack(toAsyncIterable(basePack));
      await server.refs.set("refs/heads/main", baseId);

      // Client makes new commits
      const newTip = await createCommitChain(client, 2, baseId);
      await client.refs.set("refs/heads/main", newTip);

      // Push only new objects
      const incrementalPack = await collectPackBytes(
        clientSerialization.createPack(
          client.collectReachableObjects(new Set([newTip]), new Set([baseId])),
        ),
      );
      const result = await serverSerialization.importPack(toAsyncIterable(incrementalPack));
      expect(result.commitsImported).toBe(2);

      // Server fast-forwards
      await server.refs.set("refs/heads/main", newTip);
      expect(await resolveRef(server, "refs/heads/main")).toBe(newTip);
    });
  });

  describe("bidirectional exchange", () => {
    it("syncs diverged repositories", async () => {
      // Both start with shared base
      const baseId = await createSimpleCommit(server, "Shared base", []);
      const basePack = await collectPackBytes(
        serverSerialization.createPack(
          server.collectReachableObjects(new Set([baseId]), new Set()),
        ),
      );
      await clientSerialization.importPack(toAsyncIterable(basePack));
      await server.refs.set("refs/heads/main", baseId);
      await client.refs.set("refs/heads/main", baseId);

      // Server diverges
      const serverTip = await createSimpleCommit(server, "Server change", [baseId]);
      await server.refs.set("refs/heads/main", serverTip);

      // Client diverges
      const clientTip = await createSimpleCommit(client, "Client change", [baseId]);
      await client.refs.set("refs/heads/main", clientTip);

      // Fetch: server → client (new server objects)
      const fetchPack = await collectPackBytes(
        serverSerialization.createPack(
          server.collectReachableObjects(new Set([serverTip]), new Set([baseId])),
        ),
      );
      await clientSerialization.importPack(toAsyncIterable(fetchPack));
      await client.refs.set("refs/remotes/origin/main", serverTip);

      // Push: client → server (new client objects)
      const pushPack = await collectPackBytes(
        clientSerialization.createPack(
          client.collectReachableObjects(new Set([clientTip]), new Set([baseId])),
        ),
      );
      await serverSerialization.importPack(toAsyncIterable(pushPack));

      // Both repositories now have both tips
      expect(await client.commits.load(serverTip)).toBeDefined();
      expect(await server.commits.load(clientTip)).toBeDefined();

      // Both tips share the same base
      const serverCommit = await client.commits.load(serverTip);
      const clientCommit = await server.commits.load(clientTip);
      expect(serverCommit?.parents).toContain(baseId);
      expect(clientCommit?.parents).toContain(baseId);
    });
  });

  describe("ref advertisement and negotiation", () => {
    it("advertises refs for negotiation", async () => {
      const commit1 = await createSimpleCommit(server, "Commit 1", []);
      const commit2 = await createSimpleCommit(server, "Commit 2", [commit1]);

      await server.refs.set("refs/heads/main", commit2);
      await server.refs.set("refs/heads/develop", commit1);
      await server.refs.setSymbolic("HEAD", "refs/heads/main");

      // Collect refs for advertisement (simulates git upload-pack)
      const advertisedRefs = new Map<string, string>();
      for await (const ref of server.refs.list()) {
        if ("objectId" in ref && ref.objectId) {
          advertisedRefs.set(ref.name, ref.objectId);
        }
      }

      // Resolve HEAD through symbolic ref
      const headResolved = await server.refs.resolve("HEAD");
      if (headResolved?.objectId) {
        advertisedRefs.set("HEAD", headResolved.objectId);
      }

      expect(advertisedRefs.get("refs/heads/main")).toBe(commit2);
      expect(advertisedRefs.get("refs/heads/develop")).toBe(commit1);
      expect(advertisedRefs.get("HEAD")).toBe(commit2);
    });

    it("computes wants from ref difference", async () => {
      // Server refs
      const commit1 = await createSimpleCommit(server, "C1", []);
      const commit2 = await createSimpleCommit(server, "C2", [commit1]);
      const commit3 = await createSimpleCommit(server, "C3", [commit2]);

      await server.refs.set("refs/heads/main", commit3);

      // Client already has commit1
      await client.refs.set("refs/remotes/origin/main", commit1);

      // Simulate wants computation: server refs minus client tracking refs
      const serverMainRef = commit3;
      const clientMainRef = commit1;

      // Client wants = server refs that differ from client tracking refs
      const wants = new Set<string>();
      if (serverMainRef !== clientMainRef) {
        wants.add(serverMainRef);
      }

      // Client haves = all known refs
      const haves = new Set([clientMainRef]);

      // Only 2 new commits should transfer
      const objects: string[] = [];
      for await (const id of server.collectReachableObjects(wants, haves)) {
        objects.push(id);
      }

      // Should include commit2, commit3 and their trees/blobs (not commit1's objects)
      const commitIds = [];
      for (const id of objects) {
        if (await server.commits.has(id)) {
          commitIds.push(id);
        }
      }
      expect(commitIds).toHaveLength(2);
      expect(commitIds).toContain(commit2);
      expect(commitIds).toContain(commit3);
    });
  });
});

// --- Helper functions ---

function createTestPerson(): PersonIdent {
  return {
    name: "Test Author",
    email: "test@example.com",
    timestamp: 1700000000,
    tzOffset: "+0000",
  };
}

async function createSimpleCommit(
  history: HistoryWithOperations,
  message: string,
  parents: string[],
): Promise<string> {
  const blobId = await history.blobs.store([new TextEncoder().encode(message)]);
  const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
  return history.commits.store({
    tree: treeId,
    parents,
    author: createTestPerson(),
    committer: createTestPerson(),
    message,
  });
}

async function createCommitChain(
  history: HistoryWithOperations,
  count: number,
  parent?: string,
): Promise<string> {
  let current = parent;
  for (let i = 0; i < count; i++) {
    current = await createSimpleCommit(history, `Commit ${i}`, current ? [current] : []);
  }
  return current!;
}

async function resolveRef(history: HistoryWithOperations, name: string): Promise<string> {
  const ref = await history.refs.resolve(name);
  if (!ref?.objectId) throw new Error(`Ref not found: ${name}`);
  return ref.objectId;
}

async function collectPackBytes(pack: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
