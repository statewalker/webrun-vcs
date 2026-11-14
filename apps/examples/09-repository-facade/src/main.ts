/**
 * Example 09: Repository Facade for Transport
 *
 * Demonstrates how to expose a repository for transport operations
 * using the RepositoryFacade and RefStore interfaces.
 *
 * Topics covered:
 * - Reading refs through the History API
 * - Creating RepositoryFacade for pack import/export
 * - Round-tripping a pack: exportPack from one repository, importPack into another
 * - Adapting core Refs to transport RefStore
 * - Using serveOverDuplex to serve Git requests
 * - Using fetchOverDuplex to fetch from a served repository
 *
 * Run with: pnpm start
 */

import {
  createMemoryHistoryWithOperations,
  FileMode,
  isSymbolicRef,
  type Refs,
} from "@statewalker/vcs-core";
import {
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";

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
//  Step 2: Inspect the repository through the facade
// ============================================================

console.log("\n=== Step 2: Create RepositoryFacade ===\n");

// RepositoryFacade provides what the transport FSM needs: pack import and
// export, existence checks and ancestry walks. It needs both History and
// SerializationApi.
const serverFacade: RepositoryFacade = createVcsRepositoryFacade({
  history: serverHistory,
  serialization: serverHistory.serialization,
});

console.log(`  facade.has(${commitId.slice(0, 7)}): ${await serverFacade.has(commitId)}`);
console.log(`  facade.getObjectSize(blob): ${await serverFacade.getObjectSize?.(blobId)} bytes`);

console.log("  facade.walkAncestors(commit):");
for await (const oid of serverFacade.walkAncestors(commitId)) {
  console.log(`    ${oid.slice(0, 7)}`);
}

// Refs come from the History API; symbolic refs such as HEAD name a target.
console.log("  history.refs.list():");
for await (const ref of serverHistory.refs.list()) {
  if (isSymbolicRef(ref)) {
    console.log(`    ${ref.name} -> ${ref.target} (symbolic)`);
  } else {
    console.log(`    ${ref.name} -> ${ref.objectId?.slice(0, 7)}`);
  }
}

// ============================================================
//  Step 3: Round-trip a pack, adapt Refs to RefStore
// ============================================================

console.log("\n=== Step 3: Pack Round Trip & RefStore ===\n");

// exportPack streams the objects reachable from `wants` and not from `exclude`.
console.log("  Exporting pack (wants=[commit], haves=[]):");
const packChunks: Uint8Array[] = [];
let packSize = 0;
for await (const chunk of serverFacade.exportPack(new Set([commitId]), new Set())) {
  packChunks.push(chunk);
  packSize += chunk.length;
}
const packHeader = readPackHeader(packChunks);
console.log(`    Pack size: ${packSize} bytes`);
console.log(
  `    Pack header: ${packHeader.signature} v${packHeader.version}, ${packHeader.objectCount} objects`,
);

// importPack takes the same stream on the other side.
const scratchHistory = createMemoryHistoryWithOperations();
await scratchHistory.initialize();
const scratchFacade = createVcsRepositoryFacade({
  history: scratchHistory,
  serialization: scratchHistory.serialization,
});
const importResult = await scratchFacade.importPack(
  (async function* () {
    yield* packChunks;
  })(),
);
console.log(
  `  Imported into a scratch repository: ${importResult.objectsImported} objects ` +
    `(${importResult.commitsImported} commit, ${importResult.treesImported} tree)`,
);
for (const [label, oid] of [
  ["commit", commitId],
  ["tree", treeId],
  ["blob", blobId],
] as const) {
  console.log(`    scratch has ${label} ${oid.slice(0, 7)}: ${await scratchFacade.has(oid)}`);
}
await scratchHistory.close();

// RefStore adapts the core Refs interface to the transport RefStore interface.
// The transport layer needs a simpler refs API for protocol operations.
const serverRefStore: RefStore = createRefStoreAdapter(serverHistory.refs);

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
console.log("  - RepositoryFacade: Pack-level import/export operations");
console.log("  - RefStore: Transport-compatible ref storage adapter");
console.log("  - serveOverDuplex: Serve Git requests over any duplex stream");
console.log("  - fetchOverDuplex: Fetch from a served repository");
console.log("\nAdapter functions:");
console.log("  - createVcsRepositoryFacade({ history, serialization })");
console.log("  - createRefStoreAdapter(refs)  (see code in this example)");

await serverHistory.close();
await clientHistory.close();

console.log("\nExample completed successfully!");

// ============================================================
//  Helpers
// ============================================================

/**
 * Reads the 12-byte pack header: "PACK", a version and an object count
 * (big-endian 32-bit integers).
 */
function readPackHeader(chunks: Uint8Array[]): {
  signature: string;
  version: number;
  objectCount: number;
} {
  const header = new Uint8Array(12);
  let filled = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, 12 - filled);
    header.set(chunk.subarray(0, take), filled);
    filled += take;
    if (filled === 12) break;
  }
  const view = new DataView(header.buffer);
  return {
    signature: new TextDecoder().decode(header.subarray(0, 4)),
    version: view.getUint32(4),
    objectCount: view.getUint32(8),
  };
}

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
