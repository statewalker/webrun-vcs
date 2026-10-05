/**
 * Shared utilities for GC tests
 *
 * Provides helper functions for creating test repositories,
 * commit chains, and verifying GC behavior.
 */

import { FileMode } from "../../src/common/files/index.js";
import type { ObjectId } from "../../src/common/id/index.js";
import type { PersonIdent } from "../../src/common/person/person-ident.js";
import type { Commit } from "../../src/history/commits/commits.js";
import { createMemoryHistoryWithOperations } from "../../src/history/create-history.js";
import type { HistoryWithOperations } from "../../src/history/history.js";
import { GCController, type GCScheduleOptions } from "../../src/storage/delta/gc-controller.js";

/**
 * Test context with repository, GC controller, and history
 */
export interface GCTestContext {
  /** GC controller */
  gc: GCController;
  /** History with operations for delta operations */
  history: HistoryWithOperations;
  /** Create a test person identity */
  createPerson: (name?: string, email?: string) => PersonIdent;
  /** Store a blob and return its ID */
  blob: (content: string) => Promise<ObjectId>;
  /** Store a tree with a single file and return its ID */
  tree: (filename: string, blobId: ObjectId) => Promise<ObjectId>;
  /** Create a commit and return its ID */
  commit: (options?: CommitOptions) => Promise<ObjectId>;
  /** Create a branch pointing to a commit */
  branch: (name: string, commitId: ObjectId) => Promise<void>;
  /** Create a lightweight tag pointing to an object */
  lightweightTag: (name: string, objectId: ObjectId) => Promise<void>;
  /** Delete a ref */
  deleteRef: (name: string) => Promise<void>;
}

/**
 * Options for creating a commit
 */
export interface CommitOptions {
  /** Parent commit IDs */
  parents?: ObjectId[];
  /** Tree ID (if not provided, creates a simple tree) */
  tree?: ObjectId;
  /** Files to add (creates tree automatically) */
  files?: Record<string, string>;
  /** Commit message */
  message?: string;
}

/**
 * Create a test repository with GC controller
 *
 * Uses in-memory HistoryWithOperations for reliable testing.
 */
export async function createTestRepository(gcOptions?: GCScheduleOptions): Promise<GCTestContext> {
  const history = createMemoryHistoryWithOperations();

  const { blobs, trees, commits, refs } = history;

  const gc = new GCController(history, gcOptions);

  let commitCounter = 0;

  const createPerson = (name = "Test User", email = "test@example.com"): PersonIdent => ({
    name,
    email,
    timestamp: Math.floor(Date.now() / 1000) + commitCounter,
    tzOffset: "+0000",
  });

  const blob = async (content: string): Promise<ObjectId> => {
    const bytes = new TextEncoder().encode(content);
    return blobs.store([bytes]);
  };

  const tree = async (filename: string, blobId: ObjectId): Promise<ObjectId> => {
    return trees.store([{ mode: FileMode.REGULAR_FILE, name: filename, id: blobId }]);
  };

  const commit = async (options: CommitOptions = {}): Promise<ObjectId> => {
    commitCounter++;

    let treeId = options.tree;

    // If files are provided, create tree from them
    if (!treeId && options.files) {
      const entries = [];
      for (const [filename, content] of Object.entries(options.files)) {
        const blobId = await blob(content);
        entries.push({ mode: FileMode.REGULAR_FILE, name: filename, id: blobId });
      }
      treeId = await trees.store(entries);
    }

    // If no tree, create empty tree
    if (!treeId) {
      treeId = trees.getEmptyTreeId();
    }

    const commitObj: Commit = {
      tree: treeId,
      parents: options.parents ?? [],
      author: createPerson(),
      committer: createPerson(),
      message: options.message ?? `Test commit ${commitCounter}`,
    };

    return commits.store(commitObj);
  };

  const branch = async (name: string, commitId: ObjectId): Promise<void> => {
    await refs.set(`refs/heads/${name}`, commitId);
  };

  const lightweightTag = async (name: string, objectId: ObjectId): Promise<void> => {
    await refs.set(`refs/tags/${name}`, objectId);
  };

  const deleteRef = async (name: string): Promise<void> => {
    await refs.delete(name);
  };

  return {
    gc,
    history,
    createPerson,
    blob,
    tree,
    commit,
    branch,
    lightweightTag,
    deleteRef,
  };
}

/**
 * Create a chain of commits of given depth
 *
 * Each commit contains one file named "a" containing the index of the
 * commit in the chain as its content.
 *
 * A chain of depth = N will create 3*N objects: commit, tree, and blob.
 *
 * @param ctx Test context
 * @param depth The depth of the commit chain
 * @returns The commit ID at the tip of the chain
 */
export async function commitChain(ctx: GCTestContext, depth: number): Promise<ObjectId> {
  if (depth <= 0) {
    throw new Error("Chain depth must be > 0");
  }

  let parentId: ObjectId | undefined;

  for (let i = depth; i > 0; i--) {
    const blobId = await ctx.blob(String(i - 1));
    const treeId = await ctx.tree("a", blobId);

    const commitId = await ctx.commit({
      tree: treeId,
      parents: parentId ? [parentId] : [],
      message: String(i - 1),
    });

    parentId = commitId;
  }

  // parentId is guaranteed to be defined since depth > 0
  if (!parentId) {
    throw new Error("Unexpected: no commits created");
  }
  return parentId;
}

/**
 * Create a chain of commits with multiple files per commit
 *
 * @param ctx Test context
 * @param depth The depth of the commit chain
 * @param width Number of files added per commit
 * @returns The commit ID at the tip of the chain
 */
export async function commitChainWithFiles(
  ctx: GCTestContext,
  depth: number,
  width: number,
): Promise<ObjectId> {
  if (depth <= 0) {
    throw new Error("Chain depth must be > 0");
  }
  if (width <= 0) {
    throw new Error("Number of files per commit must be > 0");
  }

  let parentId: ObjectId | undefined;

  for (let d = depth; d > 0; d--) {
    const files: Record<string, string> = {};
    for (let w = 0; w < width; w++) {
      const id = `${d - 1}-${w}`;
      files[`a${id}`] = id;
    }

    const commitId = await ctx.commit({
      files,
      parents: parentId ? [parentId] : [],
      message: `Commit at depth ${d}`,
    });

    parentId = commitId;
  }

  // parentId is guaranteed to be defined since depth > 0
  if (!parentId) {
    throw new Error("Unexpected: no commits created");
  }
  return parentId;
}

/**
 * Wait for filesystem tick (simulates time passing)
 * Used to ensure file timestamps differ
 */
export async function fsTick(): Promise<void> {
  // In memory filesystem, we just need a small delay
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Statistics about repository state
 */
export interface RepoStatistics {
  /** Number of loose blobs (not stored as delta) */
  numberOfLooseBlobs: number;
  /** Number of deltified blobs */
  numberOfDeltifiedBlobs: number;
}

/**
 * Get repository statistics
 */
export async function getStatistics(ctx: GCTestContext): Promise<RepoStatistics> {
  let looseCount = 0;
  let deltaCount = 0;

  for await (const id of ctx.history.blobs.keys()) {
    if (await ctx.history.delta.isDelta(id)) {
      deltaCount++;
    } else {
      looseCount++;
    }
  }

  return {
    numberOfLooseBlobs: looseCount,
    numberOfDeltifiedBlobs: deltaCount,
  };
}

/**
 * Count all blobs in the repository
 */
export async function countBlobs(ctx: GCTestContext): Promise<number> {
  let count = 0;
  for await (const _ of ctx.history.blobs.keys()) {
    count++;
  }
  return count;
}

/**
 * Check if repository has a blob
 */
export async function hasBlob(ctx: GCTestContext, blobId: ObjectId): Promise<boolean> {
  return ctx.history.blobs.has(blobId);
}

/**
 * Check if repository has any object (commit, tree, or blob)
 */
export async function hasObject(ctx: GCTestContext, objectId: ObjectId): Promise<boolean> {
  // Check commits
  const commit = await ctx.history.commits.load(objectId);
  if (commit) {
    return true;
  }

  // Check trees
  const tree = await ctx.history.trees.load(objectId);
  if (tree) {
    return true;
  }

  // Check blobs
  return ctx.history.blobs.has(objectId);
}

/**
 * Count all objects in the repository
 */
export async function countObjects(ctx: GCTestContext): Promise<number> {
  // This is an approximation - we only count blobs since that's what we can easily enumerate
  return countBlobs(ctx);
}
