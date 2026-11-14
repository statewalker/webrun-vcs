/**
 * Mock History helpers for testing VcsRepositoryFacade.
 *
 * Uses createMemoryHistory() from @statewalker/vcs-core for a proper
 * History interface implementation.
 */

import type { History, ObjectId, PackImportResult, SerializationApi } from "@statewalker/vcs-core";
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
 * Empty tree ID (well-known SHA-1)
 */
export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

    exportPack(_wants, _haves, _options) {
      return (async function* () {
        // an empty pack: header and checksum
        const header = new Uint8Array(12);
        header.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
        header[7] = 0x02; // Version 2
        yield header;
        yield new Uint8Array(20);
      })();
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
 * Populates a blob, a tree, a commit, refs/heads/main and HEAD, and returns a
 * mock SerializationApi for VcsRepositoryFacade testing.
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
