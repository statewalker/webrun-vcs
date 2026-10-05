/**
 * T3.6: Clone Simulation Integration Tests
 *
 * Tests the complete clone workflow at the data layer:
 * - Protocol negotiation (ref advertisement → wants/haves → pack transfer)
 * - Pack reception and import
 * - Remote tracking branch setup
 * - HEAD and default branch configuration
 * - Worktree checkout simulation (tree → blob content extraction)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryWithOperations, PersonIdent } from "../../src/history/index.js";
import { createMemoryHistoryWithOperations } from "../../src/history/index.js";
import { ObjectType } from "../../src/history/objects/object-types.js";

describe("Clone Simulation Integration", () => {
  let remote: HistoryWithOperations;
  let local: HistoryWithOperations;

  beforeEach(async () => {
    remote = createMemoryHistoryWithOperations();
    local = createMemoryHistoryWithOperations();
    await remote.initialize();
    await local.initialize();
  });

  afterEach(async () => {
    await remote.close();
    await local.close();
  });

  describe("protocol negotiation", () => {
    it("advertises remote refs for clone negotiation", async () => {
      const commit1 = await createSimpleCommit(remote, "First", []);
      const commit2 = await createSimpleCommit(remote, "Second", [commit1]);

      await remote.refs.set("refs/heads/main", commit2);
      await remote.refs.set("refs/heads/develop", commit1);
      await remote.refs.setSymbolic("HEAD", "refs/heads/main");

      // Simulate ref advertisement (what server sends in response to ls-refs)
      const advertisedRefs = await collectRemoteRefs(remote);

      expect(advertisedRefs.size).toBeGreaterThanOrEqual(2);
      expect(advertisedRefs.get("refs/heads/main")).toBe(commit2);
      expect(advertisedRefs.get("refs/heads/develop")).toBe(commit1);
    });

    it("computes wants for initial clone (no haves)", async () => {
      const commit = await createSimpleCommit(remote, "Initial", []);
      await remote.refs.set("refs/heads/main", commit);

      const advertisedRefs = await collectRemoteRefs(remote);

      // Initial clone: wants = all advertised ref tips, haves = empty
      const wants = new Set(advertisedRefs.values());
      const haves = new Set<string>();

      expect(wants.size).toBeGreaterThan(0);
      expect(haves.size).toBe(0);

      // Server should enumerate all reachable objects
      const objectIds: string[] = [];
      for await (const id of remote.collectReachableObjects(wants, haves)) {
        objectIds.push(id);
      }
      expect(objectIds.length).toBeGreaterThanOrEqual(3); // blob + tree + commit
    });
  });

  describe("pack reception and import", () => {
    it("receives and imports full repository pack", async () => {
      // Build a remote repository
      const c1 = await createFileCommit(remote, "First", { "readme.md": "# Hello" }, []);
      const c2 = await createFileCommit(remote, "Second", { "src/index.ts": 'console.log("hi")' }, [
        c1,
      ]);
      const c3 = await createFileCommit(remote, "Third", { "src/utils.ts": "export {}" }, [c2]);

      await remote.refs.set("refs/heads/main", c3);
      await remote.refs.setSymbolic("HEAD", "refs/heads/main");

      // Clone: advertise → pack → import
      const advertisedRefs = await collectRemoteRefs(remote);
      const wants = new Set(advertisedRefs.values());

      const objects = remote.collectReachableObjects(wants, new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      const result = await local.serialization.importPack(toAsyncIterable(packBytes));

      expect(result.commitsImported).toBe(3);
      expect(result.objectsImported).toBeGreaterThanOrEqual(9); // 3 commits + 3 trees + 3 blobs

      // All commits accessible
      expect(await local.commits.load(c1)).toBeDefined();
      expect(await local.commits.load(c2)).toBeDefined();
      expect(await local.commits.load(c3)).toBeDefined();
    });

    it("handles clone of empty repository", async () => {
      // Remote has no commits, just initialized
      const advertisedRefs = await collectRemoteRefs(remote);

      // Empty repo: no refs to fetch
      expect(advertisedRefs.size).toBe(0);
    });

    it("handles clone of repository with only one commit", async () => {
      const commitId = await createFileCommit(remote, "Initial", { "file.txt": "content" }, []);
      await remote.refs.set("refs/heads/main", commitId);

      const objects = remote.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      const result = await local.serialization.importPack(toAsyncIterable(packBytes));

      expect(result.commitsImported).toBe(1);
      expect(result.treesImported).toBe(1);
    });
  });

  describe("ref setup after clone", () => {
    it("creates remote tracking branches", async () => {
      const commit = await createSimpleCommit(remote, "Initial", []);
      await remote.refs.set("refs/heads/main", commit);
      await remote.refs.set("refs/heads/develop", commit);

      // Clone pack
      const advertisedRefs = await collectRemoteRefs(remote);
      const objects = remote.collectReachableObjects(new Set(advertisedRefs.values()), new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      await local.serialization.importPack(toAsyncIterable(packBytes));

      // Set up remote tracking refs (what git clone does)
      for (const [refName, objectId] of advertisedRefs) {
        if (refName.startsWith("refs/heads/")) {
          const trackingRef = refName.replace("refs/heads/", "refs/remotes/origin/");
          await local.refs.set(trackingRef, objectId);
        }
      }

      // Verify tracking refs
      const mainTracking = await local.refs.resolve("refs/remotes/origin/main");
      expect(mainTracking?.objectId).toBe(commit);

      const developTracking = await local.refs.resolve("refs/remotes/origin/develop");
      expect(developTracking?.objectId).toBe(commit);
    });

    it("sets up HEAD and default branch", async () => {
      const commit = await createSimpleCommit(remote, "Initial", []);
      await remote.refs.set("refs/heads/main", commit);
      await remote.refs.setSymbolic("HEAD", "refs/heads/main");

      // Clone
      const advertisedRefs = await collectRemoteRefs(remote);
      const objects = remote.collectReachableObjects(new Set(advertisedRefs.values()), new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      await local.serialization.importPack(toAsyncIterable(packBytes));

      // Detect default branch from remote HEAD symref
      const remoteHeadTarget = await getSymrefTarget(remote, "HEAD");
      expect(remoteHeadTarget).toBe("refs/heads/main");

      // Set up local branch matching remote default
      const defaultBranch = remoteHeadTarget as string;
      const refTip = advertisedRefs.get(defaultBranch);
      expect(refTip).toBeDefined();
      const tip = refTip as string;

      await local.refs.set(defaultBranch, tip);
      await local.refs.setSymbolic("HEAD", defaultBranch);
      await local.refs.set(defaultBranch.replace("refs/heads/", "refs/remotes/origin/"), tip);

      // Verify local HEAD resolves correctly
      const localHead = await local.refs.resolve("HEAD");
      expect(localHead?.objectId).toBe(commit);
    });

    it("handles remote with tags", async () => {
      const commit = await createSimpleCommit(remote, "Release", []);
      const tagId = await remote.tags.store({
        object: commit,
        objectType: ObjectType.COMMIT,
        tag: "v1.0.0",
        tagger: createTestPerson(),
        message: "Release v1.0.0",
      });

      await remote.refs.set("refs/heads/main", commit);
      await remote.refs.set("refs/tags/v1.0.0", tagId);

      // Clone with tags
      const advertisedRefs = await collectRemoteRefs(remote);

      // Collect all objects including tag objects
      const wants = new Set(advertisedRefs.values());
      const objects = remote.collectReachableObjects(wants, new Set());

      // Include tag objects explicitly (they may not be reachable from commits)
      const allObjects = async function* () {
        for (const [refName, objectId] of advertisedRefs) {
          if (refName.startsWith("refs/tags/")) {
            yield objectId;
          }
        }
        yield* objects;
      };

      const packBytes = await collectPackBytes(remote.serialization.createPack(allObjects()));
      await local.serialization.importPack(toAsyncIterable(packBytes));

      // Set up tag refs
      for (const [refName, objectId] of advertisedRefs) {
        if (refName.startsWith("refs/tags/")) {
          await local.refs.set(refName, objectId);
        }
      }

      // Verify tag accessible in local
      const localTag = await local.tags.load(tagId);
      expect(localTag).toBeDefined();
      expect(localTag?.tag).toBe("v1.0.0");

      const tagRef = await local.refs.resolve("refs/tags/v1.0.0");
      expect(tagRef?.objectId).toBe(tagId);
    });
  });

  describe("worktree checkout simulation", () => {
    it("extracts file contents from tree at HEAD", async () => {
      const files = {
        "readme.md": "# My Project",
        "src/index.ts": 'export const VERSION = "1.0"',
        "src/utils.ts": "export function helper() {}",
      };

      // Create remote with files
      const commitId = await createFileCommit(remote, "Initial", files, []);
      await remote.refs.set("refs/heads/main", commitId);

      // Clone
      const objects = remote.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      await local.serialization.importPack(toAsyncIterable(packBytes));
      await local.refs.set("refs/heads/main", commitId);

      // Simulate checkout: resolve HEAD → commit → tree → entries
      const commit = await local.commits.load(commitId);
      expect(commit).toBeDefined();

      const tree = await local.trees.load(commit?.tree);
      expect(tree).toBeDefined();

      const entries = await collectAsyncIterable(
        tree as AsyncIterable<{ mode: number; name: string; id: string }>,
      );

      // Root tree should have "readme.md" and "src" subtree
      const readmeEntry = entries.find((e) => e.name === "readme.md");
      expect(readmeEntry).toBeDefined();

      // Extract readme content
      const readmeBlob = await local.blobs.load(readmeEntry?.id);
      expect(readmeBlob).toBeDefined();
      const readmeContent = await collectAsyncIterableBytes(
        readmeBlob as AsyncIterable<Uint8Array>,
      );
      expect(new TextDecoder().decode(readmeContent)).toBe("# My Project");

      // Navigate into src subtree
      const srcEntry = entries.find((e) => e.name === "src");
      expect(srcEntry).toBeDefined();
      expect(srcEntry?.mode).toBe(0o40000);

      const srcTree = await local.trees.load(srcEntry?.id);
      expect(srcTree).toBeDefined();
      const srcEntries = await collectAsyncIterable(
        srcTree as AsyncIterable<{ mode: number; name: string; id: string }>,
      );
      expect(srcEntries).toHaveLength(2);

      // Extract src/index.ts content
      const indexEntry = srcEntries.find((e) => e.name === "index.ts");
      expect(indexEntry).toBeDefined();
      const indexBlob = await local.blobs.load(indexEntry?.id);
      const indexContent = await collectAsyncIterableBytes(indexBlob as AsyncIterable<Uint8Array>);
      expect(new TextDecoder().decode(indexContent)).toBe('export const VERSION = "1.0"');
    });

    it("restores correct file modes", async () => {
      const blobId = await remote.blobs.store([new TextEncoder().encode("#!/bin/sh\necho hi")]);
      const treeId = await remote.trees.store([
        { mode: 0o100644, name: "readme.txt", id: blobId },
        { mode: 0o100755, name: "run.sh", id: blobId },
      ]);
      const commitId = await remote.commits.store({
        tree: treeId,
        parents: [],
        author: createTestPerson(),
        committer: createTestPerson(),
        message: "Modes test",
      });

      // Clone
      const objects = remote.collectReachableObjects(new Set([commitId]), new Set());
      const packBytes = await collectPackBytes(remote.serialization.createPack(objects));
      await local.serialization.importPack(toAsyncIterable(packBytes));

      // Verify modes preserved
      const tree = await local.trees.load(treeId);
      const entries = await collectAsyncIterable(
        tree as AsyncIterable<{ mode: number; name: string; id: string }>,
      );

      const readmeEntry = entries.find((e) => e.name === "readme.txt");
      expect(readmeEntry?.mode).toBe(0o100644);

      const scriptEntry = entries.find((e) => e.name === "run.sh");
      expect(scriptEntry?.mode).toBe(0o100755);
    });
  });

  describe("clone with history", () => {
    it("clones repository with linear history", async () => {
      const c1 = await createFileCommit(remote, "Initial", { "v.txt": "1" }, []);
      const c2 = await createFileCommit(remote, "Update", { "v.txt": "2" }, [c1]);
      const c3 = await createFileCommit(remote, "Latest", { "v.txt": "3" }, [c2]);

      await remote.refs.set("refs/heads/main", c3);

      // Full clone
      await simulateClone(remote, local);

      // Verify entire history is accessible
      const head = await local.refs.resolve("refs/heads/main");
      expect(head?.objectId).toBe(c3);

      // Walk history
      const history: string[] = [];
      let current: string | undefined = c3;
      while (current) {
        const commit = await local.commits.load(current);
        expect(commit).toBeDefined();
        history.push(commit?.message);
        current = commit?.parents[0];
      }

      expect(history).toEqual(["Latest", "Update", "Initial"]);
    });

    it("clones repository with merge history", async () => {
      const base = await createFileCommit(remote, "Base", { "base.txt": "base" }, []);
      const feat = await createFileCommit(remote, "Feature", { "feat.txt": "feat" }, [base]);
      const main = await createFileCommit(remote, "Main fix", { "fix.txt": "fix" }, [base]);
      const merge = await createSimpleCommit(remote, "Merge", [main, feat]);

      await remote.refs.set("refs/heads/main", merge);

      await simulateClone(remote, local);

      // Verify merge commit
      const mergeCommit = await local.commits.load(merge);
      expect(mergeCommit?.parents).toHaveLength(2);
      expect(mergeCommit?.parents).toContain(main);
      expect(mergeCommit?.parents).toContain(feat);

      // All four commits accessible
      expect(await local.commits.load(base)).toBeDefined();
      expect(await local.commits.load(feat)).toBeDefined();
      expect(await local.commits.load(main)).toBeDefined();
      expect(await local.commits.load(merge)).toBeDefined();
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

async function createFileCommit(
  history: HistoryWithOperations,
  message: string,
  files: Record<string, string>,
  parents: string[],
): Promise<string> {
  const encoder = new TextEncoder();
  const rootEntries: Array<{ mode: number; name: string; id: string }> = [];
  const subtrees = new Map<string, Array<{ mode: number; name: string; id: string }>>();

  for (const [path, content] of Object.entries(files)) {
    const blobId = await history.blobs.store([encoder.encode(content)]);
    const parts = path.split("/");

    if (parts.length === 1) {
      rootEntries.push({ mode: 0o100644, name: parts[0], id: blobId });
    } else {
      const dir = parts[0];
      const fileName = parts.slice(1).join("/");
      if (!subtrees.has(dir)) subtrees.set(dir, []);
      subtrees.get(dir)?.push({ mode: 0o100644, name: fileName, id: blobId });
    }
  }

  // Create subtrees
  for (const [dir, entries] of subtrees) {
    const subTreeId = await history.trees.store(entries);
    rootEntries.push({ mode: 0o40000, name: dir, id: subTreeId });
  }

  const treeId = await history.trees.store(rootEntries);
  return history.commits.store({
    tree: treeId,
    parents,
    author: createTestPerson(),
    committer: createTestPerson(),
    message,
  });
}

async function _createCommitChain(
  history: HistoryWithOperations,
  count: number,
  parent?: string,
): Promise<string> {
  let current = parent;
  for (let i = 0; i < count; i++) {
    current = await createSimpleCommit(history, `Commit ${i}`, current ? [current] : []);
  }
  return current as string;
}

async function collectRemoteRefs(history: HistoryWithOperations): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for await (const ref of history.refs.list()) {
    if ("objectId" in ref && ref.objectId) {
      refs.set(ref.name, ref.objectId);
    }
  }
  return refs;
}

async function getSymrefTarget(
  history: HistoryWithOperations,
  name: string,
): Promise<string | undefined> {
  const ref = await history.refs.get(name);
  if (ref && "target" in ref) {
    return ref.target;
  }
  return undefined;
}

async function simulateClone(
  remoteHistory: HistoryWithOperations,
  localHistory: HistoryWithOperations,
): Promise<void> {
  // Step 1: Get remote refs
  const advertisedRefs = await collectRemoteRefs(remoteHistory);
  if (advertisedRefs.size === 0) return;

  // Step 2: Create and transfer pack
  const wants = new Set(advertisedRefs.values());
  const objects = remoteHistory.collectReachableObjects(wants, new Set());
  const packBytes = await collectPackBytes(remoteHistory.serialization.createPack(objects));
  await localHistory.serialization.importPack(toAsyncIterable(packBytes));

  // Step 3: Set up remote tracking refs
  for (const [refName, objectId] of advertisedRefs) {
    if (refName.startsWith("refs/heads/")) {
      const trackingRef = refName.replace("refs/heads/", "refs/remotes/origin/");
      await localHistory.refs.set(trackingRef, objectId);
    }
  }

  // Step 4: Set up local default branch
  const remoteHead = await getSymrefTarget(remoteHistory, "HEAD");
  const defaultBranch = remoteHead ?? "refs/heads/main";
  const tip = advertisedRefs.get(defaultBranch);

  if (tip) {
    await localHistory.refs.set(defaultBranch, tip);
    await localHistory.refs.setSymbolic("HEAD", defaultBranch);
  }
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

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function collectAsyncIterableBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
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
