/**
 * Test helpers for @statewalker/vcs-commands
 *
 * Provides utilities for testing Git commands with multiple storage backends.
 *
 * For multi-backend testing, use `createInitializedGitFromFactory()` with
 * different backend factories.
 */

import type { History, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";

import { Git } from "../src/index.js";
import {
  backends,
  defaultFactory,
  memoryFactory,
  sqlFactory,
  type WorkingCopyFactory,
  type WorkingCopyTestContext,
} from "./backend-factories.js";
import { createMockWorktree } from "./mock-worktree-store.js";
import { createSimpleHistory } from "./simple-history-store.js";

// Re-export factory types and functions for convenience
export type { WorkingCopyFactory, WorkingCopyTestContext };
export { backends, defaultFactory, memoryFactory, sqlFactory };

/**
 * Create an in-memory WorkingCopy for testing (synchronous).
 * Uses the memory backend (fastest, no cleanup needed).
 *
 * For multi-backend testing, use `createInitializedGitFromFactory()` instead.
 */
export function createTestWorkingCopy(): { workingCopy: WorkingCopy; repository: History } {
  const stores = createMemoryObjectStores();
  const refs = new MemoryRefStore();
  const staging = new MemoryStagingStore();

  // Create History wrapper using new store interfaces
  const repository = createSimpleHistory({
    blobs: stores.blobs,
    trees: stores.trees,
    commits: stores.commits,
    tags: stores.tags,
    refs,
  });

  // Create mock Worktree
  const worktree = createMockWorktree();

  // Create Checkout with staging
  const checkout = new MemoryCheckout({ staging });

  // Create WorkingCopy
  const workingCopy = new MemoryWorkingCopy({
    history: repository,
    checkout,
    worktree,
  });

  return { workingCopy, repository };
}

/**
 * Create a WorkingCopy from a factory function.
 * Use this for multi-backend testing.
 *
 * @param factory The factory function to use (defaults to memory)
 * @returns Test context with workingCopy, repository, and optional cleanup
 */
export async function createTestWorkingCopyFromFactory(
  factory: WorkingCopyFactory = defaultFactory,
): Promise<WorkingCopyTestContext> {
  return factory();
}

/**
 * Result of creating an initialized Git instance
 */
export interface InitializedGitResult {
  git: Git;
  /** The WorkingCopy instance */
  workingCopy: WorkingCopy;
  /** Direct access to the repository (History) for test setup/verification */
  repository: History;
  initialCommitId: ObjectId;
  cleanup?: () => Promise<void>;
}

/**
 * Create an initialized Git instance with an initial commit.
 *
 * Sets up:
 * - HEAD -> refs/heads/main
 * - Initial empty commit on main
 *
 * Uses the default memory backend. For multi-backend testing,
 * use `createInitializedGitFromFactory()` instead.
 */
export async function createInitializedGit(): Promise<InitializedGitResult> {
  return createInitializedGitFromFactory(defaultFactory);
}

/**
 * Create an initialized Git instance from a factory.
 *
 * Sets up:
 * - HEAD -> refs/heads/main
 * - Initial empty commit on main
 *
 * @param factory The factory function to use
 * @returns Initialized Git with workingCopy, repository, and cleanup function
 */
export async function createInitializedGitFromFactory(
  factory: WorkingCopyFactory,
): Promise<InitializedGitResult> {
  const ctx = await factory();
  const { workingCopy, repository } = ctx;
  // Use Git.fromWorkingCopy for the new architecture
  const git = Git.fromWorkingCopy(workingCopy);

  // Create and store empty tree (store returns the well-known empty tree ID)
  const emptyTreeId = await repository.trees.store([]);

  // Create initial commit
  const initialCommit = {
    tree: emptyTreeId,
    parents: [],
    author: testAuthor(),
    committer: testAuthor(),
    message: "Initial commit",
  };

  const initialCommitId = await repository.commits.store(initialCommit);

  // Set up refs
  await repository.refs.set("refs/heads/main", initialCommitId);
  await repository.refs.setSymbolic("HEAD", "refs/heads/main");

  // Initialize staging with empty tree
  await workingCopy.checkout.staging.readTree(repository.trees, emptyTreeId);

  return { git, workingCopy, repository, initialCommitId, cleanup: ctx.cleanup };
}

/**
 * Create a test author identity.
 */
export function testAuthor(name = "Test Author", email = "test@example.com"): PersonIdent {
  return {
    name,
    email,
    timestamp: Math.floor(Date.now() / 1000),
    tzOffset: "+0000",
  };
}

/**
 * Add a file to the staging area and return its object ID.
 *
 * @param wc WorkingCopy to use
 * @param path File path
 * @param content File content
 */
export async function addFile(wc: WorkingCopy, path: string, content: string): Promise<ObjectId> {
  // Store the content as a blob
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const objectId = await wc.history.blobs.store([data]);

  // Add to staging
  const editor = wc.checkout.staging.createEditor();
  editor.add({
    path,
    apply: () => ({
      path,
      mode: FileMode.REGULAR_FILE,
      objectId,
      stage: 0,
      size: data.length,
      mtime: Date.now(),
    }),
  });
  await editor.finish();

  return objectId;
}

/**
 * Create a commit with the given message and files.
 *
 * @param wc WorkingCopy to use
 * @param message Commit message
 * @param files Optional files to add (path -> content)
 * @param parentIds Optional parent commit IDs (defaults to HEAD)
 */
export async function createCommit(
  wc: WorkingCopy,
  message: string,
  files: Record<string, string> = {},
  parentIds?: ObjectId[],
): Promise<ObjectId> {
  const { history, checkout } = wc;
  const staging = checkout.staging;

  // Add files to staging
  for (const [path, content] of Object.entries(files)) {
    await addFile(wc, path, content);
  }

  // Write tree from staging
  const treeId = await staging.writeTree(history.trees);

  // Get parent(s)
  let parents: ObjectId[];
  if (parentIds !== undefined) {
    parents = parentIds;
  } else {
    try {
      const headRef = await history.refs.resolve("HEAD");
      parents = headRef?.objectId ? [headRef.objectId] : [];
    } catch {
      parents = [];
    }
  }

  // Create commit
  const commit = {
    tree: treeId,
    parents,
    author: testAuthor(),
    committer: testAuthor(),
    message,
  };

  const commitId = await history.commits.store(commit);

  // Update HEAD
  const head = await history.refs.get("HEAD");
  if (head && "target" in head) {
    await history.refs.set(head.target, commitId);
  } else {
    await history.refs.set("HEAD", commitId);
  }

  // Update staging to match new tree
  await staging.readTree(history.trees, treeId);

  return commitId;
}

/**
 * Remove a file from the staging area.
 *
 * @param wc WorkingCopy to use
 * @param path File path to remove
 */
export async function removeFile(wc: WorkingCopy, path: string): Promise<void> {
  const builder = wc.checkout.staging.createBuilder();
  // Add all entries except the one we want to remove
  for await (const entry of wc.checkout.staging.entries()) {
    if (entry.path !== path) {
      builder.add(entry);
    }
  }
  await builder.finish();
}

/**
 * Collect async iterable to array.
 */
export async function toArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}
