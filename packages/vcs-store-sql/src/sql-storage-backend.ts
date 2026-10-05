/**
 * SQL History Factory
 *
 * Factory for creating SQL-backed HistoryWithOperations instances.
 * Uses SQL database for persistent storage with:
 * - Atomic transactions for batch operations
 * - Native delta tracking with depth management
 * - Rich query capabilities via SQL
 */

import {
  type BackendCapabilities,
  type BaseBackendConfig,
  DefaultSerializationApi,
  type HistoryBackendFactory,
  HistoryImpl,
  type HistoryWithOperations,
  HistoryWithOperationsImpl,
  type StorageOperations,
} from "@statewalker/vcs-core";

import { SQLCommitStore } from "./commit-store.js";
import type { DatabaseClient } from "./database-client.js";
import { initializeSchema } from "./migrations/index.js";
import { SqlNativeBlobStoreImpl } from "./native/sql-native-blob-store.js";
import { SQLRefStore } from "./ref-store.js";
import { SqlDeltaApi } from "./sql-delta-api.js";
import { SQLTagStore } from "./tag-store.js";
import { SQLTreeStore } from "./tree-store.js";

/**
 * Configuration for SQL history storage
 */
export interface SQLStorageBackendConfig extends BaseBackendConfig {
  /** Database client for SQL operations */
  db: DatabaseClient;
  /** Run migrations on initialization (default: true) */
  autoMigrate?: boolean;
}

/** SQL backend capabilities */
const SQL_CAPABILITIES: BackendCapabilities = {
  nativeBlobDeltas: true,
  nativeTreeDeltas: true,
  nativeCommitDeltas: false,
  randomAccess: true,
  atomicBatch: true,
  nativeGitFormat: false,
};

/**
 * SQLHistoryFactory - Factory for creating SQL-backed HistoryWithOperations
 *
 * Implements the HistoryBackendFactory interface to create HistoryWithOperations
 * instances directly from SQL storage configuration.
 *
 * @example
 * ```typescript
 * import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
 *
 * const factory = new SQLHistoryFactory();
 * const db = await SqlJsAdapter.create();
 * const history = await factory.createHistory({ db });
 * await history.initialize();
 *
 * // Use history for normal operations
 * const commit = await history.commits.load(commitId);
 *
 * // Use delta API for storage optimization
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, delta);
 * await history.delta.endBatch();
 *
 * await history.close();
 * ```
 */
export class SQLHistoryFactory implements HistoryBackendFactory<SQLStorageBackendConfig> {
  /**
   * Create a full HistoryWithOperations instance
   *
   * Returns an uninitialized instance. Call initialize() before use.
   *
   * @param config SQL storage backend configuration with database client
   * @returns HistoryWithOperations instance (not yet initialized)
   */
  async createHistory(config: SQLStorageBackendConfig): Promise<HistoryWithOperations> {
    const { db, autoMigrate, blobs, trees, commits, tags, refs, delta, serialization } =
      createSQLStores(config);

    let initialized = false;

    return new HistoryWithOperationsImpl(
      blobs,
      trees,
      commits,
      tags,
      refs,
      delta,
      serialization,
      SQL_CAPABILITIES,
      async () => {
        if (initialized) return;
        if (autoMigrate) {
          await initializeSchema(db);
        }
        initialized = true;
      },
      async () => {
        if (!initialized) return;
        await db.close();
        initialized = false;
      },
    );
  }

  /**
   * Create only storage operations (delta and serialization APIs)
   *
   * Use this when you only need delta compression or SQL query operations
   * without the full History interface.
   *
   * @param config SQL storage backend configuration
   * @returns StorageOperations instance (not yet initialized)
   */
  async createOperations(config: SQLStorageBackendConfig): Promise<StorageOperations> {
    const { db, autoMigrate, delta, serialization } = createSQLStores(config);

    let initialized = false;

    return {
      delta,
      serialization,
      capabilities: SQL_CAPABILITIES,
      async initialize() {
        if (initialized) return;
        if (autoMigrate) {
          await initializeSchema(db);
        }
        initialized = true;
      },
      async close() {
        if (!initialized) return;
        await db.close();
        initialized = false;
      },
    };
  }
}

/**
 * Create all SQL store instances from configuration
 */
function createSQLStores(config: SQLStorageBackendConfig) {
  const db = config.db;
  const autoMigrate = config.autoMigrate ?? true;

  const blobs = new SqlNativeBlobStoreImpl(db);
  const trees = new SQLTreeStore(db);
  const commits = new SQLCommitStore(db);
  const tags = new SQLTagStore(db);
  const refs = new SQLRefStore(db);
  const delta = new SqlDeltaApi(db);

  const history = new HistoryImpl(blobs, trees, commits, tags, refs);
  const serialization = new DefaultSerializationApi({
    history,
    blobDeltaApi: delta.blobs,
    treeDeltaApi: delta.trees,
  });

  return { db, autoMigrate, blobs, trees, commits, tags, refs, delta, serialization };
}
