/**
 * Test repository factory for transport integration tests
 *
 * Creates in-memory Git repositories for testing transport operations
 * (fetch, push) with real pack generation and ref updates.
 */

import type { TreeEntry } from "@statewalker/vcs-core";
import type { SimpleHistory } from "../../helpers/simple-history.js";
import { memoryFactory, testAuthor } from "../../test-helper.js";

/**
 * Context for a test repository
 *
 * Provides access to the repository and its components for testing
 * transport operations with real Git objects.
 */
export interface TestRepositoryContext {
  /** Full history store with all object stores */
  repository: SimpleHistory;
  /** Cleanup function to release resources */
  cleanup: () => Promise<void>;
}

/**
 * Creates a test repository with in-memory storage
 *
 * The repository is initialized with:
 * - Empty initial state (no commits)
 * - HEAD pointing to refs/heads/main (symbolic ref)
 *
 * @returns Test repository context with cleanup function
 *
 * @example
 * ```typescript
 * const ctx = await createTestRepository();
 * const { repository } = ctx;
 *
 * // Create commits using the repository
 * await createTestCommit(repository, "Initial commit", {
 *   "README.md": "# Hello World"
 * });
 *
 * // Clean up when done
 * await ctx.cleanup();
 * ```
 */
export async function createTestRepository(): Promise<TestRepositoryContext> {
  const ctx = await memoryFactory();
  const { repository } = ctx;

  // Set up initial HEAD (symbolic ref to main)
  await repository.refs.setSymbolic("HEAD", "refs/heads/main");

  return {
    repository,
    cleanup: ctx.cleanup ?? (async () => {}),
  };
}

/**
 * Creates a test repository with an initial commit
 *
 * Convenient for tests that need a non-empty repository.
 *
 * @param files Optional files to include in the initial commit
 * @returns Test repository context with initial commit ID
 *
 * @example
 * ```typescript
 * const { repository, initialCommitId } = await createInitializedTestRepository({
 *   "src/index.ts": "export {};",
 * });
 * ```
 */
export async function createInitializedTestRepository(
  files: Record<string, string> = {},
): Promise<TestRepositoryContext & { initialCommitId: string }> {
  const ctx = await createTestRepository();
  const { repository } = ctx;

  // Create empty tree for initial commit
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

  // If files provided, create a second commit with them
  if (Object.keys(files).length > 0) {
    const fileCommitId = await createTestCommit(repository, "Add files", files);
    return { ...ctx, initialCommitId: fileCommitId };
  }

  return { ...ctx, initialCommitId };
}

/**
 * Creates a commit in the repository with the given files
 *
 * Utility for creating test commits with specific content.
 *
 * @param repository Repository to create commit in
 * @param message Commit message
 * @param files Files to include (path -> content)
 * @returns Commit object ID
 */
export async function createTestCommit(
  repository: SimpleHistory,
  message: string,
  files: Record<string, string>,
): Promise<string> {
  const encoder = new TextEncoder();
  const entries: TreeEntry[] = [];

  // Store blobs for each file
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    const blobId = await repository.blobs.store([data]);
    entries.push({
      name: path,
      mode: 0o100644, // Regular file
      id: blobId,
    });
  }

  // Sort entries by name (Git requirement)
  entries.sort((a, b) => a.name.localeCompare(b.name));

  // Create tree
  const treeId = await repository.trees.store(entries);

  // Get parent commit
  const headRef = await repository.refs.resolve("HEAD");
  const parents = headRef?.objectId ? [headRef.objectId] : [];

  // Create commit
  const commit = {
    tree: treeId,
    parents,
    author: testAuthor(),
    committer: testAuthor(),
    message,
  };

  const commitId = await repository.commits.store(commit);

  // Update HEAD
  const head = await repository.refs.get("HEAD");
  if (head && "target" in head) {
    await repository.refs.set(head.target, commitId);
  } else {
    await repository.refs.set("HEAD", commitId);
  }

  return commitId;
}
