/**
 * Backend factory functions for integration tests
 *
 * Provides factory functions to create WorkingCopy instances with multiple backends.
 * Used for testing Git operations across Memory and SQL storage implementations.
 *
 * @see WorkingCopy for the primary architecture
 */

import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import {
  createSqlObjectStores,
  initializeSchema,
  SQLRefStore,
  SQLStaging,
} from "@statewalker/vcs-store-sql";
import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";

import { createMockWorktree } from "./helpers/mock-worktree.js";
import { createSimpleHistory, type SimpleHistory } from "./helpers/simple-history.js";

// Enable Node.js compression for SQL backend
setCompressionUtils(createNodeCompression());

/**
 * Test context for WorkingCopy tests
 *
 * Provides access to WorkingCopy and its underlying repository for testing.
 */
export interface WorkingCopyTestContext {
  /** The WorkingCopy instance (primary interface) */
  workingCopy: WorkingCopy;
  /** Direct access to the repository for test setup/verification */
  repository: SimpleHistory;
  /** Cleanup function to call after test */
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create WorkingCopy instances for testing
 */
export type WorkingCopyFactory = () => Promise<WorkingCopyTestContext>;

/**
 * Memory backend factory (default, fastest)
 *
 * Creates a WorkingCopy with in-memory storage.
 */
export const memoryFactory: WorkingCopyFactory = async () => {
  const stores = createMemoryObjectStores();
  const refs = new MemoryRefStore();
  const staging = new MemoryStagingStore();

  // Create History wrapper
  const repository = createSimpleHistory({
    objects: stores.objects,
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

  // Create WorkingCopy (SimpleHistory is duck-type compatible with History)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workingCopy = new MemoryWorkingCopy({
    history: repository as any,
    checkout,
    worktree,
  });

  return { workingCopy, repository };
};

/**
 * SQL backend factory (persistent, uses sql.js in-memory)
 *
 * Creates a WorkingCopy with SQL-backed storage.
 */
export const sqlFactory: WorkingCopyFactory = async () => {
  const db = await SqlJsAdapter.create();
  await initializeSchema(db);
  const stores = createSqlObjectStores({ db });
  const refs = new SQLRefStore(db);
  const staging = new SQLStaging(db);

  // Create History wrapper
  const repository = createSimpleHistory({
    objects: stores.objects,
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

  // Create WorkingCopy (SimpleHistory is duck-type compatible with History)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workingCopy = new MemoryWorkingCopy({
    history: repository as any,
    checkout,
    worktree,
  });

  return {
    workingCopy,
    repository,
    cleanup: async () => {
      await db.close();
    },
  };
};

/**
 * All available backends for cross-backend testing
 */
export const backends: Array<{ name: string; factory: WorkingCopyFactory }> = [
  { name: "Memory", factory: memoryFactory },
  { name: "SQL", factory: sqlFactory },
];

/**
 * Default backend for single-backend tests
 */
export const defaultFactory = memoryFactory;
