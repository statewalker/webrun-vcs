/**
 * SQL Backend Factory Registration
 *
 * Registers the SQL storage backend with the core factory.
 *
 * ## Usage
 *
 * Use `registerSqlHistoryFactory()` to register the SQL backend factory.
 * It registers a factory that returns HistoryWithOperations directly.
 *
 * @example
 * ```typescript
 * import { registerSqlHistoryFactory } from "@statewalker/vcs-store-sql";
 * import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
 * import { createHistory } from "@statewalker/vcs-core";
 *
 * // Register the SQL history factory
 * registerSqlHistoryFactory();
 *
 * // Create history with operations
 * const db = await SqlJsAdapter.create();
 * const history = await createHistory("sql", { db });
 * await history.initialize();
 * ```
 */

import { registerHistoryBackendFactory } from "@statewalker/vcs-core";
import { SQLHistoryFactory, type SQLStorageBackendConfig } from "./sql-storage-backend.js";

/**
 * Register the SQL backend with the HistoryBackendFactory pattern
 *
 * Call this function to enable creating SQL-backed HistoryWithOperations
 * via createHistory("sql", config).
 *
 * @example
 * ```typescript
 * import { registerSqlHistoryFactory } from "@statewalker/vcs-store-sql";
 * import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";
 * import { createHistory } from "@statewalker/vcs-core";
 *
 * // Register the SQL history factory
 * registerSqlHistoryFactory();
 *
 * // Create history with operations
 * const db = await SqlJsAdapter.create();
 * const history = await createHistory("sql", { db });
 * await history.initialize();
 *
 * // Use history for normal operations
 * const commit = await history.commits.load(commitId);
 *
 * await history.close();
 * ```
 */
export function registerSqlHistoryFactory(): void {
  const factory = new SQLHistoryFactory();

  registerHistoryBackendFactory("sql", async (config) => {
    const sqlConfig = config as SQLStorageBackendConfig;

    if (!sqlConfig.db) {
      throw new Error(
        "SQL backend requires a database client. " +
          "Provide 'db' in config, e.g., { db: await SqlJsAdapter.create() }",
      );
    }

    return factory.createHistory({
      db: sqlConfig.db,
      autoMigrate: true,
    });
  });
}
