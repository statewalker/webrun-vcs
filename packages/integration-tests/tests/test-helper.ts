/**
 * Test helpers for integration tests
 *
 * Provides utilities for testing Git operations across multiple storage backends.
 *
 * For multi-backend testing, use `createInitializedGitFromFactory()` with
 * different backend factories.
 */

import { Git } from "@statewalker/vcs-commands";
import type {
  Blobs,
  Commits,
  GitObjectStore,
  ObjectId,
  PersonIdent,
  Refs,
  Tags,
  Trees,
} from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { Staging, WorkingCopy } from "@statewalker/vcs-working-tree";

import {
  backends,
  defaultFactory,
  memoryFactory,
  sqlFactory,
  type WorkingCopyFactory,
  type WorkingCopyTestContext,
} from "./backend-factories.js";
import type { SimpleHistory } from "./helpers/simple-history.js";

// Re-export factory types and functions for convenience
export type { WorkingCopyFactory, WorkingCopyTestContext };
export { backends, defaultFactory, memoryFactory, sqlFactory };

/**
 * Combined store for test convenience
 *
 * Provides unified access to history stores and staging area
 * without needing to navigate the WorkingCopy architecture.
 */
export interface TestStore {
  /** Object store for raw Git objects */
  objects: GitObjectStore;
  /** Blob storage */
  blobs: Blobs;
  /** Tree storage */
  trees: Trees;
  /** Commit storage */
  commits: Commits;
  /** Tag storage */
  tags: Tags;
  /** Reference storage */
  refs: Refs;
  /** Staging area from checkout */
  staging: Staging;
}

/**
 * Result of creating an initialized Git instance
 */
export interface InitializedGitResult {
  git: Git;
  /** The WorkingCopy instance */
  workingCopy: WorkingCopy;
  /** Direct access to the repository for test setup/verification */
  repository: SimpleHistory;
  /**
   * Combined store for test convenience
   * Contains history stores (blobs, trees, commits, tags, refs) + staging
   */
  store: TestStore;
  initialCommitId: ObjectId;
  cleanup?: () => Promise<void>;
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

  // Create and store empty tree
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
  const staging = workingCopy.checkout.staging;
  await staging.readTree(repository.trees, emptyTreeId);

  // Create combined store for test convenience
  const store: TestStore = {
    objects: repository.objects,
    blobs: repository.blobs,
    trees: repository.trees,
    commits: repository.commits,
    tags: repository.tags,
    refs: repository.refs,
    staging,
  };

  return { git, workingCopy, repository, store, initialCommitId, cleanup: ctx.cleanup };
}

/**
 * Create an initialized Git instance (default memory backend).
 */
export async function createInitializedGit(): Promise<InitializedGitResult> {
  return createInitializedGitFromFactory(defaultFactory);
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
 * @param store TestStore to use (provides blobs and staging)
 * @param path File path
 * @param content File content
 */
export async function addFile(store: TestStore, path: string, content: string): Promise<ObjectId> {
  // Store the content as a blob
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const objectId = await store.blobs.store([data]);

  // Add to staging
  const editor = store.staging.createEditor();
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
 * Minimal blob store interface for addFile
 * Compatible with both BlobStore and History.blobs
 */
interface BlobStoreForAddFile {
  store(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<ObjectId>;
}

/**
 * Minimal store interface for addFile function
 */
interface StoreForAddFile {
  blobs: BlobStoreForAddFile;
  staging: Staging;
}

/**
 * Add a file using a minimal store interface.
 * Works with both TestStore and WorkingCopy-derived stores.
 */
async function addFileInternal(
  store: StoreForAddFile,
  path: string,
  content: string,
): Promise<ObjectId> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const objectId = await store.blobs.store([data]);

  const editor = store.staging.createEditor();
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

  // Create a store interface compatible with addFileInternal
  const store: StoreForAddFile = {
    blobs: history.blobs,
    staging,
  };

  // Add files to staging
  for (const [path, content] of Object.entries(files)) {
    await addFileInternal(store, path, content);
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

  // Store commit using new Commits interface
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
 * Also accepts a Promise that resolves to an AsyncIterable (for convenience with async load() methods).
 */
export async function toArray<T>(
  iterable: AsyncIterable<T> | Promise<AsyncIterable<T> | undefined>,
): Promise<T[]> {
  const resolved = await iterable;
  if (!resolved) throw new Error("Expected iterable but got undefined");
  const result: T[] = [];
  for await (const item of resolved) {
    result.push(item);
  }
  return result;
}

/**
 * Truncate object ID for display.
 */
export function shortId(id: string): string {
  return id.slice(0, 7);
}
