/**
 * Mock History helpers for testing VcsRepositoryAccess and VcsRepositoryFacade
 *
 * This module provides History-based test helpers that replace the legacy
 * store-based helpers in mock-stores.ts. Uses createMemoryHistory() from
 * @statewalker/vcs-core for proper History interface implementation.
 */

import type {
  Commit,
  History,
  ObjectId,
  PackImportResult,
  SerializationApi,
  Tag,
  TreeEntry,
} from "@statewalker/vcs-core";
import { createMemoryHistory } from "@statewalker/vcs-core";

/**
 * Sample identity for test commits and tags
 */
export const SAMPLE_IDENT = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  tzOffset: "+0000",
};

/**
 * Sample object IDs for testing
 */
export const SAMPLE_COMMIT_ID = "1234567890123456789012345678901234567890";
export const SAMPLE_TREE_ID = "abcdef1234567890abcdef1234567890abcdef12";
export const SAMPLE_BLOB_ID = "fedcba0987654321fedcba0987654321fedcba09";
export const SAMPLE_TAG_ID = "deadbeef12345678deadbeef12345678deadbeef";

/**
 * Empty tree ID (well-known SHA-1)
 */
export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Sample commit data for testing
 */
export const SAMPLE_COMMIT: Commit = {
  tree: SAMPLE_TREE_ID,
  parents: [],
  author: SAMPLE_IDENT,
  committer: SAMPLE_IDENT,
  message: "Initial commit",
};

/**
 * Sample tree entry for testing
 */
export const SAMPLE_TREE_ENTRY: TreeEntry = {
  mode: 0o100644,
  name: "test.txt",
  id: SAMPLE_BLOB_ID,
};

/**
 * Sample tag data for testing
 */
export const SAMPLE_TAG: Tag = {
  object: SAMPLE_COMMIT_ID,
  objectType: 1, // ObjectType.COMMIT
  tag: "v1.0.0",
  tagger: SAMPLE_IDENT,
  message: "Release v1.0.0",
};

/**
 * Create a mock History instance for testing
 *
 * Uses createMemoryHistory() from @statewalker/vcs-core to create
 * a proper History interface implementation with in-memory storage.
 *
 * @returns History instance ready for testing
 *
 * @example
 * ```typescript
 * const history = createMockHistory();
 *
 * // Use with VcsRepositoryAccess
 * const access = new VcsRepositoryAccess({ history });
 *
 * // Store test data directly through History interface
 * const blobId = await history.blobs.store([new TextEncoder().encode("test")]);
 * ```
 */
export function createMockHistory(): History {
  return createMemoryHistory();
}

/**
 * Create a mock SerializationApi for testing VcsRepositoryFacade
 *
 * Provides a simplified mock implementation of SerializationApi that:
 * - Creates minimal pack data for export tests
 * - Tracks imported packs for verification
 * - Works with any History instance
 *
 * @returns SerializationApi instance for testing
 *
 * @example
 * ```typescript
 * const history = createMockHistory();
 * const serialization = createMockSerializationApi();
 *
 * // Use with VcsRepositoryFacade
 * const facade = new VcsRepositoryFacade({ history, serialization });
 * ```
 */
export function createMockSerializationApi(): SerializationApi {
  return {
    serializeLooseObject(_id) {
      return (async function* () {
        yield new Uint8Array(0);
      })();
    },

    async parseLooseObject(_compressed) {
      return { id: "0".repeat(40), type: "blob" as const, size: 0 };
    },

    createPack(objects, _options) {
      return (async function* () {
        const objectIds: string[] = [];
        for await (const id of objects) {
          objectIds.push(id);
        }

        // Yield pack header
        const header = new Uint8Array(12);
        header.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
        header[7] = 0x02; // Version 2
        header[11] = objectIds.length; // Object count (simplified)
        yield header;

        // Yield dummy data for each object
        for (const _id of objectIds) {
          yield new Uint8Array([0x30, 0x00]); // Simplified object
        }

        // Pack checksum
        yield new Uint8Array(20);
      })();
    },

    async importPack(pack) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of pack) {
        chunks.push(chunk);
      }

      // Return mock result
      const result: PackImportResult = {
        objectsImported: chunks.length > 0 ? 1 : 0,
        blobsWithDelta: 0,
        treesImported: 0,
        commitsImported: 0,
        tagsImported: 0,
      };
      return result;
    },

    createPackBuilder(_options) {
      const objects: string[] = [];
      return {
        async addObject(id) {
          objects.push(id);
        },
        async addObjectWithDelta(id, _preferredBaseId) {
          objects.push(id);
        },
        finalize() {
          return (async function* () {
            yield new Uint8Array(12); // Header
            yield new Uint8Array(20); // Checksum
          })();
        },
        getStats() {
          return {
            totalObjects: objects.length,
            deltifiedObjects: 0,
            totalSize: 0,
            deltaSavings: 0,
          };
        },
      };
    },

    createPackReader(_pack) {
      return {
        entries() {
          return (async function* () {
            // Empty iterator
          })();
        },
        async getHeader() {
          return { version: 2, objectCount: 0 };
        },
      };
    },

    async exportObject(_id) {
      return {
        type: "blob" as const,
        content: (async function* () {
          yield new Uint8Array(0);
        })(),
      };
    },

    async importObject(_type, _content) {
      return "0".repeat(40);
    },
  };
}

/**
 * Result of creating mock history with sample data
 */
export interface MockHistoryWithDataResult {
  /** The History instance */
  history: History;
  /** ID of the stored commit */
  commitId: ObjectId;
  /** ID of the stored tree */
  treeId: ObjectId;
  /** ID of the stored blob */
  blobId: ObjectId;
}

/**
 * Create mock History with sample data for walk tests
 *
 * Creates a History instance and populates it with a basic commit history:
 * - A blob with "Hello, World!" content
 * - A tree containing the blob as "hello.txt"
 * - A commit pointing to the tree
 * - refs/heads/main and HEAD pointing to the commit
 *
 * @returns Object with history and IDs of created objects
 *
 * @example
 * ```typescript
 * const { history, commitId, treeId, blobId } = await createMockHistoryWithData();
 *
 * // Use for testing object traversal
 * const access = new VcsRepositoryAccess({ history });
 * expect(await access.hasObject(commitId)).toBe(true);
 * ```
 */
export async function createMockHistoryWithData(): Promise<MockHistoryWithDataResult> {
  const history = createMockHistory();

  // Store a blob
  const blobContent = new TextEncoder().encode("Hello, World!");
  const blobId = await history.blobs.store([blobContent]);

  // Store a tree with the blob
  const treeId = await history.trees.store([{ mode: 0o100644, name: "hello.txt", id: blobId }]);

  // Store a commit
  const commitId = await history.commits.store({
    tree: treeId,
    parents: [],
    author: SAMPLE_IDENT,
    committer: SAMPLE_IDENT,
    message: "Initial commit",
  });

  // Set up refs
  await history.refs.set("refs/heads/main", commitId);
  await history.refs.setSymbolic("HEAD", "refs/heads/main");

  return { history, commitId, treeId, blobId };
}

/**
 * Result of creating mock History with serialization for facade tests
 */
export interface MockHistoryWithSerializationResult {
  /** The History instance */
  history: History;
  /** The SerializationApi instance */
  serialization: SerializationApi;
  /** ID of the stored commit */
  commitId: ObjectId;
  /** ID of the stored tree */
  treeId: ObjectId;
  /** ID of the stored blob */
  blobId: ObjectId;
}

/**
 * Create mock History with serialization and sample data for facade tests
 *
 * Same as createMockHistoryWithData() but also returns a mock SerializationApi
 * for VcsRepositoryFacade testing.
 *
 * @returns Object with history, serialization, and IDs of created objects
 *
 * @example
 * ```typescript
 * const { history, serialization, commitId } = await createMockHistoryWithSerializationData();
 *
 * // Use for testing pack operations
 * const facade = new VcsRepositoryFacade({ history, serialization });
 * const pack = facade.exportPack(new Set([commitId]), new Set());
 * ```
 */
export async function createMockHistoryWithSerializationData(): Promise<MockHistoryWithSerializationResult> {
  const history = createMockHistory();
  const serialization = createMockSerializationApi();

  // Store a blob
  const blobContent = new TextEncoder().encode("Hello, World!");
  const blobId = await history.blobs.store([blobContent]);

  // Store a tree with the blob
  const treeId = await history.trees.store([{ mode: 0o100644, name: "hello.txt", id: blobId }]);

  // Store a commit
  const commitId = await history.commits.store({
    tree: treeId,
    parents: [],
    author: SAMPLE_IDENT,
    committer: SAMPLE_IDENT,
    message: "Initial commit",
  });

  // Set up refs
  await history.refs.set("refs/heads/main", commitId);
  await history.refs.setSymbolic("HEAD", "refs/heads/main");

  return { history, serialization, commitId, treeId, blobId };
}

/**
 * Helper to create a commit chain in History
 *
 * Creates a chain of commits, each pointing to the previous as its parent.
 * Useful for testing ancestry walking.
 *
 * @param history - History instance to populate
 * @param count - Number of commits to create
 * @returns Array of commit IDs from oldest to newest
 *
 * @example
 * ```typescript
 * const history = createMockHistory();
 * const [c1, c2, c3] = await createCommitChain(history, 3);
 *
 * // c3's parent is c2, c2's parent is c1
 * const commit3 = await history.commits.load(c3);
 * expect(commit3?.parents).toEqual([c2]);
 * ```
 */
export async function createCommitChain(history: History, count: number): Promise<ObjectId[]> {
  const commitIds: ObjectId[] = [];

  for (let i = 0; i < count; i++) {
    const parents = i > 0 ? [commitIds[i - 1]] : [];
    const commitId = await history.commits.store({
      tree: EMPTY_TREE_ID,
      parents,
      author: { ...SAMPLE_IDENT, timestamp: SAMPLE_IDENT.timestamp + i * 1000 },
      committer: { ...SAMPLE_IDENT, timestamp: SAMPLE_IDENT.timestamp + i * 1000 },
      message: `Commit ${i + 1}`,
    });
    commitIds.push(commitId);
  }

  return commitIds;
}

/**
 * Helper to create a tree with multiple files
 *
 * @param history - History instance to populate
 * @param files - Map of filename to content
 * @returns Object with tree ID and map of filename to blob ID
 *
 * @example
 * ```typescript
 * const history = createMockHistory();
 * const { treeId, blobIds } = await createTreeWithFiles(history, {
 *   "file1.txt": "content1",
 *   "file2.txt": "content2",
 * });
 * ```
 */
export async function createTreeWithFiles(
  history: History,
  files: Record<string, string>,
): Promise<{ treeId: ObjectId; blobIds: Map<string, ObjectId> }> {
  const blobIds = new Map<string, ObjectId>();
  const entries: TreeEntry[] = [];

  for (const [name, content] of Object.entries(files)) {
    const blobId = await history.blobs.store([new TextEncoder().encode(content)]);
    blobIds.set(name, blobId);
    entries.push({ mode: 0o100644, name, id: blobId });
  }

  const treeId = await history.trees.store(entries);
  return { treeId, blobIds };
}

/**
 * Helper to create a complete commit with tree and blob
 *
 * Creates a commit with a tree containing a single file.
 *
 * @param history - History instance to populate
 * @param message - Commit message
 * @param filename - Name of the file in the tree
 * @param content - File content
 * @param parents - Parent commit IDs
 * @returns Object with commit, tree, and blob IDs
 */
export async function createCompleteCommit(
  history: History,
  message: string,
  filename: string,
  content: string,
  parents: ObjectId[] = [],
): Promise<{ commitId: ObjectId; treeId: ObjectId; blobId: ObjectId }> {
  const blobId = await history.blobs.store([new TextEncoder().encode(content)]);
  const treeId = await history.trees.store([{ mode: 0o100644, name: filename, id: blobId }]);
  const commitId = await history.commits.store({
    tree: treeId,
    parents,
    author: SAMPLE_IDENT,
    committer: SAMPLE_IDENT,
    message,
  });

  return { commitId, treeId, blobId };
}

/**
 * Helper to create an annotated tag
 *
 * @param history - History instance to populate
 * @param tagName - Tag name (e.g., "v1.0.0")
 * @param targetId - Target object ID (usually a commit)
 * @param message - Tag message
 * @returns Tag object ID
 */
export async function createAnnotatedTag(
  history: History,
  tagName: string,
  targetId: ObjectId,
  message = `Tag ${tagName}`,
): Promise<ObjectId> {
  const tagId = await history.tags.store({
    object: targetId,
    objectType: 1, // ObjectType.COMMIT
    tag: tagName,
    tagger: SAMPLE_IDENT,
    message,
  });

  // Also create the ref
  await history.refs.set(`refs/tags/${tagName}`, tagId);

  return tagId;
}
