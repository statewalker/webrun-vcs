import type { PersonIdent } from "../../common/person/person-ident.js";
import type { BlobContent } from "../../history/blobs/blobs.js";
import type { Commit } from "../../history/commits/commits.js";
import type { History } from "../../history/history.js";
import { ObjectType } from "../../history/objects/object-types.js";
import type { AnnotatedTag } from "../../history/tags/tags.js";
import type { TreeEntry } from "../../history/trees/tree-entry.js";

/**
 * Helper to create an async iterable from a Uint8Array.
 */
async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Create test blob content with optional customization.
 */
export function createTestBlobContent(options?: {
  content?: string | Uint8Array;
  size?: number;
}): BlobContent {
  let data: Uint8Array;
  if (options?.content) {
    data =
      typeof options.content === "string"
        ? new TextEncoder().encode(options.content)
        : options.content;
  } else if (options?.size) {
    data = new Uint8Array(options.size).fill(0x41);
  } else {
    data = new TextEncoder().encode(`Test blob ${Date.now()}`);
  }
  return toAsyncIterable(data);
}

/**
 * Create test tree entries with optional customization.
 */
export function createTestTreeEntries(options?: {
  entries?: TreeEntry[];
  fileCount?: number;
}): TreeEntry[] {
  if (options?.entries) {
    return options.entries;
  }
  if (options?.fileCount) {
    const entries: TreeEntry[] = [];
    for (let i = 0; i < options.fileCount; i++) {
      entries.push({
        mode: 0o100644,
        name: `file-${i}.txt`,
        id: "0".repeat(40),
      });
    }
    return entries;
  }
  return [{ mode: 0o100644, name: "test.txt", id: "0".repeat(40) }];
}

/**
 * Create a test person (author/committer).
 */
export function createTestPerson(options?: {
  name?: string;
  email?: string;
  timestamp?: number;
  tzOffset?: string;
}): PersonIdent {
  return {
    name: options?.name ?? "Test Author",
    email: options?.email ?? "test@example.com",
    timestamp: options?.timestamp ?? Math.floor(Date.now() / 1000),
    tzOffset: options?.tzOffset ?? "+0000",
  };
}

/**
 * Create a test commit with optional customization.
 */
export function createTestCommit(options?: {
  tree?: string;
  parents?: string[];
  author?: PersonIdent;
  committer?: PersonIdent;
  message?: string;
}): Commit {
  return {
    tree: options?.tree ?? "0".repeat(40),
    parents: options?.parents ?? [],
    author: options?.author ?? createTestPerson(),
    committer: options?.committer ?? options?.author ?? createTestPerson(),
    message: options?.message ?? "Test commit",
  };
}

/**
 * Create a test tag with optional customization.
 */
export function createTestTag(options?: {
  object?: string;
  objectType?: (typeof ObjectType)[keyof typeof ObjectType];
  tag?: string;
  tagger?: PersonIdent;
  message?: string;
}): AnnotatedTag {
  return {
    object: options?.object ?? "0".repeat(40),
    objectType: options?.objectType ?? ObjectType.COMMIT,
    tag: options?.tag ?? "v1.0.0",
    tagger: options?.tagger ?? createTestPerson(),
    message: options?.message ?? "Release",
  };
}

/**
 * Create a complete commit chain in a history store.
 */
export async function createCommitChain(
  history: History,
  length: number,
  options?: {
    startingParent?: string;
    fileChanges?: boolean;
  },
): Promise<string[]> {
  const commits: string[] = [];
  let parent = options?.startingParent;

  for (let i = 0; i < length; i++) {
    const blobId = await history.blobs.store(createTestBlobContent({ content: `Content ${i}` }));
    const treeId = await history.trees.store([{ mode: 0o100644, name: "file.txt", id: blobId }]);
    const commitId = await history.commits.store({
      tree: treeId,
      parents: parent ? [parent] : [],
      author: createTestPerson({ timestamp: 1700000000 + i * 1000 }),
      committer: createTestPerson({ timestamp: 1700000000 + i * 1000 }),
      message: `Commit ${i}`,
    });
    commits.push(commitId);
    parent = commitId;
  }

  return commits;
}

/**
 * Create a branching history structure.
 */
export async function createBranchingHistory(
  history: History,
  spec: {
    base: number; // Commits before branch
    branches: Array<{
      name: string;
      commits: number;
    }>;
  },
): Promise<{
  base: string[];
  branches: Record<string, string[]>;
}> {
  // Create base commits
  const base = await createCommitChain(history, spec.base);

  // Create branches from last base commit
  const branches: Record<string, string[]> = {};
  const branchPoint = base[base.length - 1];

  for (const branch of spec.branches) {
    branches[branch.name] = await createCommitChain(history, branch.commits, {
      startingParent: branchPoint,
    });
  }

  return { base, branches };
}
