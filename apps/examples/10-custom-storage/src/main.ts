/**
 * Example 10: Custom Storage Backends
 *
 * Demonstrates how to build History instances from components,
 * compose custom storage backends, and use different factory patterns.
 *
 * Topics covered:
 * - createMemoryHistory() for quick in-memory testing
 * - createMemoryHistoryWithOperations() for delta/serialization support
 * - createHistoryFromComponents() with raw storage + object store
 * - createHistoryFromStores() with explicit store instances
 * - Understanding HistoryWithOperations vs History
 *
 * Run with: pnpm start
 */

import {
  createBlobs,
  createCommits,
  createGitObjects,
  createHistoryFromComponents,
  createHistoryFromStores,
  createMemoryHistory,
  createMemoryHistoryWithOperations,
  createMemoryRefs,
  createTags,
  createTrees,
  FileMode,
  type History,
  type HistoryWithOperations,
  MemoryRawStorage,
  rawStorageStaging,
} from "@statewalker/vcs-core";

const encoder = new TextEncoder();

// ============================================================
//  Pattern 1: createMemoryHistory()
// ============================================================

console.log("=== Pattern 1: createMemoryHistory() ===\n");
console.log("  Best for: unit tests, quick prototypes, in-memory operations");
console.log("  Returns: History (basic interface)\n");

const history1: History = createMemoryHistory();
await history1.initialize();
await history1.refs.setSymbolic("HEAD", "refs/heads/main");

const blob1 = await history1.blobs.store([encoder.encode("Pattern 1: basic in-memory")]);
const tree1 = await history1.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blob1 },
]);
const now = Date.now() / 1000;
const commit1 = await history1.commits.store({
  tree: tree1,
  parents: [],
  author: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Pattern 1 commit",
});
await history1.refs.set("refs/heads/main", commit1);
console.log(`  Commit: ${commit1.slice(0, 7)}`);
console.log(`  Available APIs: blobs, trees, commits, tags, refs`);

await history1.close();

// ============================================================
//  Pattern 2: createMemoryHistoryWithOperations()
// ============================================================

console.log("\n=== Pattern 2: createMemoryHistoryWithOperations() ===\n");
console.log("  Best for: tests needing delta/serialization, transport testing");
console.log("  Returns: HistoryWithOperations (extended interface)\n");

const history2: HistoryWithOperations = createMemoryHistoryWithOperations();
await history2.initialize();
await history2.refs.setSymbolic("HEAD", "refs/heads/main");

const blob2 = await history2.blobs.store([encoder.encode("Pattern 2: with operations")]);
const tree2 = await history2.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blob2 },
]);
const commit2 = await history2.commits.store({
  tree: tree2,
  parents: [],
  author: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Pattern 2 commit",
});
await history2.refs.set("refs/heads/main", commit2);

console.log(`  Commit: ${commit2.slice(0, 7)}`);
console.log(`  Additional APIs: delta, serialization, capabilities`);
console.log(`  Capabilities: ${JSON.stringify(history2.capabilities)}`);

// Demonstrate serialization API: create a pack from objects
const reachable = history2.collectReachableObjects(new Set([commit2]), new Set());
const objectIds: string[] = [];
for await (const oid of reachable) {
  objectIds.push(oid);
}
console.log(`  Reachable objects from commit: ${objectIds.length}`);

await history2.close();

// ============================================================
//  Pattern 3: createHistoryFromComponents()
// ============================================================

console.log("\n=== Pattern 3: createHistoryFromComponents() ===\n");
console.log("  Best for: custom storage layers, shared storage between instances");
console.log("  Returns: History (basic interface)\n");

// Use a single object store for all Git objects (blobs, trees, commits, tags).
// createHistoryFromComponents builds typed stores (blobs, trees, commits, tags)
// from the shared GitObjects automatically.
const objectStorage = new MemoryRawStorage();
const objects = createGitObjects(rawStorageStaging(objectStorage));

const history3 = createHistoryFromComponents({
  objects,
  refs: { type: "memory" },
});
await history3.initialize();
await history3.refs.setSymbolic("HEAD", "refs/heads/main");

const blob3 = await history3.blobs.store([encoder.encode("Pattern 3: from components")]);
const tree3 = await history3.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blob3 },
]);
const commit3 = await history3.commits.store({
  tree: tree3,
  parents: [],
  author: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Pattern 3 commit",
});
await history3.refs.set("refs/heads/main", commit3);

console.log(`  Commit: ${commit3.slice(0, 7)}`);
console.log("  All Git objects share a single MemoryRawStorage via GitObjects");
console.log("  createHistoryFromComponents auto-builds typed stores (blobs, trees, commits, tags)");

await history3.close();

// ============================================================
//  Pattern 4: createHistoryFromStores()
// ============================================================

console.log("\n=== Pattern 4: createHistoryFromStores() ===\n");
console.log("  Best for: fully custom stores, wrapping external databases");
console.log("  Returns: History (basic interface)\n");

// Build individual store instances manually
const _customBlobStorage = new MemoryRawStorage();
const customObjectStorage = new MemoryRawStorage();
const customObjects = createGitObjects(rawStorageStaging(customObjectStorage));

const customBlobs = createBlobs(customObjects);
const customTrees = createTrees(customObjects);
const customCommits = createCommits(customObjects);
const customTags = createTags(customObjects);
const customRefs = createMemoryRefs();

// Compose into History from explicit store instances
const history4 = createHistoryFromStores({
  blobs: customBlobs,
  trees: customTrees,
  commits: customCommits,
  tags: customTags,
  refs: customRefs,
  objects: customObjects, // received packs are written through it byte for byte
});
await history4.initialize();
await history4.refs.setSymbolic("HEAD", "refs/heads/main");

const blob4 = await history4.blobs.store([encoder.encode("Pattern 4: from stores")]);
const tree4 = await history4.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "file.txt", id: blob4 },
]);
const commit4 = await history4.commits.store({
  tree: tree4,
  parents: [],
  author: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Pattern 4 commit",
});
await history4.refs.set("refs/heads/main", commit4);

console.log(`  Commit: ${commit4.slice(0, 7)}`);
console.log("  Each store (blobs, trees, commits, tags, refs) is independently constructed");
console.log("  Store instances can wrap any backing storage (memory, SQL, IndexedDB, etc.)");

await history4.close();

// ============================================================
//  Pattern 5: Shared storage between History instances
// ============================================================

console.log("\n=== Pattern 5: Shared Storage ===\n");
console.log("  Best for: multi-workspace, testing isolation, read replicas");
console.log("  Pattern: Multiple History instances sharing the same raw storage\n");

// Create shared object storage
const sharedObjectStorage = new MemoryRawStorage();
const sharedObjects = createGitObjects(rawStorageStaging(sharedObjectStorage));

// Create two History instances that share the same underlying storage
const historyA = createHistoryFromComponents({
  objects: sharedObjects,
  refs: { type: "memory" }, // separate refs per workspace
});
await historyA.initialize();
await historyA.refs.setSymbolic("HEAD", "refs/heads/main");

const historyB = createHistoryFromComponents({
  objects: sharedObjects,
  refs: { type: "memory" }, // separate refs per workspace
});
await historyB.initialize();
await historyB.refs.setSymbolic("HEAD", "refs/heads/feature");

// Write from workspace A
const sharedBlob = await historyA.blobs.store([encoder.encode("Shared content")]);
const sharedTree = await historyA.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "shared.txt", id: sharedBlob },
]);
const sharedCommit = await historyA.commits.store({
  tree: sharedTree,
  parents: [],
  author: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  committer: {
    name: "Dev",
    email: "dev@example.com",
    timestamp: now,
    tzOffset: "+0000",
  },
  message: "Shared commit",
});
await historyA.refs.set("refs/heads/main", sharedCommit);

// Read from workspace B (same objects, different refs)
const commitFromB = await historyB.commits.load(sharedCommit);
if (commitFromB) {
  console.log(`  Workspace A wrote commit: ${sharedCommit.slice(0, 7)}`);
  console.log(`  Workspace B can read it: "${commitFromB.message}"`);
}

// B has its own refs
await historyB.refs.set("refs/heads/feature", sharedCommit);
const refA = await historyA.refs.resolve("refs/heads/feature");
const refB = await historyB.refs.resolve("refs/heads/feature");
console.log(`  Workspace A refs/heads/feature: ${refA?.objectId ?? "not set"}`);
console.log(`  Workspace B refs/heads/feature: ${refB?.objectId?.slice(0, 7) ?? "not set"}`);

await historyA.close();
await historyB.close();

// ============================================================
//  Summary: Factory function decision guide
// ============================================================

console.log("\n=== Decision Guide ===\n");
console.log("  createMemoryHistory()");
console.log("    -> Quick testing, no delta/serialization needed\n");
console.log("  createMemoryHistoryWithOperations()");
console.log("    -> Testing with transport/pack/delta operations\n");
console.log("  createHistoryFromComponents({ objects, refs })");
console.log("    -> Custom storage layer, shared storage between instances\n");
console.log("  createHistoryFromStores({ blobs, trees, commits, tags, refs })");
console.log("    -> Fully custom store implementations (SQL, IndexedDB, etc.)\n");
console.log("  createGitFilesHistory(config)");
console.log("    -> Production Git-compatible filesystem storage\n");

console.log("Example completed successfully!");
