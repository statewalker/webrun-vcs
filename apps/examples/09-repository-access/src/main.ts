/**
 * Example 09: Repository Access for Transport
 *
 * Demonstrates how to expose a repository for transport operations
 * using the RepositoryAccess, RepositoryFacade, and RefStore interfaces.
 *
 * Topics covered:
 * - Creating RepositoryAccess from a History instance
 * - Creating RepositoryFacade for pack import/export
 * - Adapting core Refs to transport RefStore
 * - Using serveOverDuplex to serve Git requests
 * - Using fetchOverDuplex to fetch from a served repository
 *
 * Run with: pnpm start
 */

import { createMemoryHistoryWithOperations, FileMode, type Refs } from "@statewalker/vcs-core";
import {
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import {
  createVcsRepositoryAccess,
  createVcsRepositoryFacade,
} from "@statewalker/vcs-transport-adapters";

// ============================================================
//  Step 1: Create and populate a server repository
// ============================================================

console.log("=== Step 1: Create Server Repository ===\n");

const serverHistory = createMemoryHistoryWithOperations();
await serverHistory.initialize();
await serverHistory.refs.setSymbolic("HEAD", "refs/heads/main");

// Create some content
const encoder = new TextEncoder();

const blobId = await serverHistory.blobs.store([
  encoder.encode("# Hello from Server\n\nThis file was served via transport."),
]);
const treeId = await serverHistory.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);
const now = Date.now() / 1000;
const commitId = await serverHistory.commits.store({
  tree: treeId,
  parents: [],
  author: {
    name: "Server",
    email: "server@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Server",
    email: "server@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Initial commit from server",
});
await serverHistory.refs.set("refs/heads/main", commitId);

console.log(`  Server commit: ${commitId.slice(0, 7)}`);
console.log(`  Server blob:   ${blobId.slice(0, 7)}`);
console.log(`  Server tree:   ${treeId.slice(0, 7)}`);

// ============================================================
//  Step 2: Create RepositoryAccess adapter
// ============================================================

console.log("\n=== Step 2: Create RepositoryAccess ===\n");

// RepositoryAccess provides low-level byte-level operations for
// protocol handlers. It bridges History to the transport layer.
const repoAccess = createVcsRepositoryAccess({
  history: serverHistory,
});

// Demonstrate RepositoryAccess operations
const hasCommit = await repoAccess.hasObject(commitId);
console.log(`  hasObject(${commitId.slice(0, 7)}): ${hasCommit}`);

const commitInfo = await repoAccess.getObjectInfo(commitId);
console.log(`  getObjectInfo: type=${commitInfo?.type} size=${commitInfo?.size}`);

const headInfo = await repoAccess.getHead();
console.log(`  getHead: target=${headInfo?.target}`);

console.log("  listRefs:");
for await (const ref of repoAccess.listRefs()) {
  console.log(`    ${ref.name} -> ${ref.objectId.slice(0, 7)}`);
}

// Walk the object graph
console.log("  walkObjects (from commit, no exclusions):");
let objectCount = 0;
const typeNames = ["", "commit", "tree", "blob", "tag"];
for await (const obj of repoAccess.walkObjects([commitId], [])) {
  console.log(`    ${typeNames[obj.type]}: ${obj.id.slice(0, 7)} (${obj.content.length} bytes)`);
  objectCount++;
}
console.log(`  Total objects walked: ${objectCount}`);

// ============================================================
//  Step 3: Create RepositoryFacade and RefStore adapter
// ============================================================

console.log("\n=== Step 3: Create RepositoryFacade & RefStore ===\n");

// RepositoryFacade provides pack-level operations (importPack, exportPack)
// for the transport FSM. It needs both History and SerializationApi.
const serverFacade: RepositoryFacade = createVcsRepositoryFacade({
  history: serverHistory,
  serialization: serverHistory.serialization,
});

// RefStore adapts the core Refs interface to the transport RefStore interface.
// The transport layer needs a simpler refs API for protocol operations.
const serverRefStore: RefStore = createRefStoreAdapter(serverHistory.refs);

// Verify the facade works
const hasFacadeCommit = await serverFacade.has(commitId);
console.log(`  facade.has(${commitId.slice(0, 7)}): ${hasFacadeCommit}`);

// Export a pack to demonstrate
console.log("  Exporting pack (wants=[commit], haves=[]):");
let packSize = 0;
for await (const chunk of serverFacade.exportPack(new Set([commitId]), new Set())) {
  packSize += chunk.length;
}
console.log(`    Pack size: ${packSize} bytes`);

// List refs via RefStore adapter
const allRefs = await serverRefStore.listAll();
console.log("  RefStore.listAll():");
for (const [name, oid] of allRefs) {
  console.log(`    ${name} -> ${oid.slice(0, 7)}`);
}

// ============================================================
//  Step 4: Serve repository over MessagePort duplex
// ============================================================

console.log("\n=== Step 4: Serve Over Duplex (MessagePort) ===\n");

// In a real application, you would use MessagePort, WebSocket, or WebRTC.
// This demonstrates the pattern using the standard (global) MessageChannel,
// available in browsers, workers and Node.
const { serveOverDuplex, fetchOverDuplex, createMessagePortDuplex } = await import(
  "@statewalker/vcs-transport"
);

const channel = new MessageChannel();

// Wrap MessagePorts into transport-compatible Duplex objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serverDuplex = createMessagePortDuplex(channel.port1 as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientDuplex = createMessagePortDuplex(channel.port2 as any);

// Create a client-side history to receive the data
const clientHistory = createMemoryHistoryWithOperations();
await clientHistory.initialize();
await clientHistory.refs.setSymbolic("HEAD", "refs/heads/main");

const clientFacade = createVcsRepositoryFacade({
  history: clientHistory,
  serialization: clientHistory.serialization,
});
const clientRefStore = createRefStoreAdapter(clientHistory.refs);

// Run server and client concurrently
const [serveResult, fetchResult] = await Promise.all([
  // Server side: serve the repository
  serveOverDuplex({
    duplex: serverDuplex,
    repository: serverFacade,
    refStore: serverRefStore,
    service: "git-upload-pack",
  }),
  // Client side: fetch from the served repository
  fetchOverDuplex({
    duplex: clientDuplex,
    repository: clientFacade,
    refStore: clientRefStore,
  }),
]);

console.log(`  Server result: success=${serveResult.success}`);
console.log(`  Client result: refs updated=${fetchResult.updatedRefs?.size ?? 0}`);

// Verify the client got the data
const clientMainRef = await clientHistory.refs.resolve("refs/heads/main");
if (clientMainRef?.objectId) {
  const clientCommit = await clientHistory.commits.load(clientMainRef.objectId);
  if (clientCommit) {
    console.log(`  Client received commit: "${clientCommit.message}"`);
  }
}

// Clean up MessagePorts
channel.port1.close();
channel.port2.close();

// ============================================================
//  Summary
// ============================================================

console.log("\n=== Summary ===\n");
console.log("Key interfaces demonstrated:");
console.log("  - RepositoryAccess: Low-level byte-level protocol operations");
console.log("  - RepositoryFacade: Pack-level import/export operations");
console.log("  - RefStore: Transport-compatible ref storage adapter");
console.log("  - serveOverDuplex: Serve Git requests over any duplex stream");
console.log("  - fetchOverDuplex: Fetch from a served repository");
console.log("\nAdapter functions:");
console.log("  - createVcsRepositoryAccess({ history })");
console.log("  - createVcsRepositoryFacade({ history, serialization })");
console.log("  - createRefStoreAdapter(refs)  (see code in this example)");

await serverHistory.close();
await clientHistory.close();

console.log("\nExample completed successfully!");

// ============================================================
//  Helper: RefStore adapter (inline for clarity)
// ============================================================

/**
 * Adapts core Refs interface to transport RefStore.
 *
 * The transport layer uses a simpler RefStore interface:
 * - get(name) returns string|undefined (not RefValue)
 * - update(name, oid) instead of set(name, oid)
 * - listAll() returns Iterable<[string, string]>
 */
function createRefStoreAdapter(refs: Refs): RefStore {
  // The shared adapter from @statewalker/vcs-transport (pushes go through Refs.batch).
  return createTransportRefStore(refs);
}
