/**
 * SQL schema migrations
 *
 * Manages database schema versioning and upgrades following
 * Fossil's proven patterns.
 */

import type { DatabaseClient } from "../database-client.js";

/**
 * Migration definition
 */
export interface Migration {
  /** Migration version number (must be sequential) */
  version: number;
  /** Human-readable name */
  name: string;
  /** SQL statements to apply migration (semicolon-separated) */
  up: string;
  /** SQL statements to revert migration (semicolon-separated) */
  down: string;
}

/**
 * All migrations in order
 *
 * New migrations should be added at the end with incrementing version numbers.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS object (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id TEXT UNIQUE NOT NULL,
        size INTEGER NOT NULL,
        content BLOB,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS object_accessed_idx ON object(accessed_at);

      CREATE TABLE IF NOT EXISTS delta (
        record_id INTEGER PRIMARY KEY REFERENCES object(record_id) ON DELETE CASCADE,
        base_record_id INTEGER NOT NULL REFERENCES object(record_id),
        delta_size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delta_base_idx ON delta(base_record_id);

      CREATE TABLE IF NOT EXISTS metadata (
        object_id TEXT PRIMARY KEY,
        access_count INTEGER NOT NULL DEFAULT 0,
        is_hot INTEGER NOT NULL DEFAULT 0,
        total_size INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      CREATE VIEW IF NOT EXISTS artifact AS
        SELECT
          o.record_id, o.object_id, o.size, o.content,
          o.created_at, o.accessed_at,
          d.base_record_id, d.delta_size,
          CASE WHEN d.record_id IS NOT NULL THEN 1 ELSE 0 END AS is_delta
        FROM object o
        LEFT JOIN delta d ON o.record_id = d.record_id;
    `,
    down: `
      DROP VIEW IF EXISTS artifact;
      DROP TABLE IF EXISTS metadata;
      DROP TABLE IF EXISTS delta;
      DROP TABLE IF EXISTS object;
    `,
  },
  {
    version: 2,
    name: "delta_content_table",
    up: `
      CREATE TABLE IF NOT EXISTS delta_content (
        object_id TEXT PRIMARY KEY,
        base_object_id TEXT NOT NULL,
        delta_data BLOB NOT NULL,
        delta_format TEXT NOT NULL CHECK(delta_format IN ('git', 'fossil')),
        original_size INTEGER NOT NULL,
        delta_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delta_content_base_idx ON delta_content(base_object_id);
    `,
    down: `
      DROP INDEX IF EXISTS delta_content_base_idx;
      DROP TABLE IF EXISTS delta_content;
    `,
  },
  {
    version: 3,
    name: "high_level_stores",
    up: `
      -- Trees (normalized with entries in separate table)
      CREATE TABLE IF NOT EXISTS tree (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tree_entry (
        tree_fk INTEGER NOT NULL REFERENCES tree(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        name TEXT NOT NULL,
        object_id TEXT NOT NULL,
        PRIMARY KEY (tree_fk, position)
      );
      CREATE INDEX IF NOT EXISTS tree_entry_name_idx ON tree_entry(tree_fk, name);

      -- Commits
      CREATE TABLE IF NOT EXISTS vcs_commit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_id TEXT UNIQUE NOT NULL,
        tree_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        author_timestamp INTEGER NOT NULL,
        author_tz TEXT NOT NULL,
        committer_name TEXT NOT NULL,
        committer_email TEXT NOT NULL,
        committer_timestamp INTEGER NOT NULL,
        committer_tz TEXT NOT NULL,
        message TEXT NOT NULL,
        encoding TEXT,
        gpg_signature TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commit_parent (
        commit_fk INTEGER NOT NULL REFERENCES vcs_commit(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        parent_id TEXT NOT NULL,
        PRIMARY KEY (commit_fk, position)
      );
      CREATE INDEX IF NOT EXISTS commit_parent_parent_idx ON commit_parent(parent_id);

      -- Annotated Tags
      CREATE TABLE IF NOT EXISTS vcs_tag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id TEXT UNIQUE NOT NULL,
        object_id TEXT NOT NULL,
        object_type INTEGER NOT NULL,
        tag_name TEXT NOT NULL,
        tagger_name TEXT,
        tagger_email TEXT,
        tagger_timestamp INTEGER,
        tagger_tz TEXT,
        message TEXT NOT NULL,
        encoding TEXT,
        gpg_signature TEXT,
        created_at INTEGER NOT NULL
      );

      -- References (both direct and symbolic)
      CREATE TABLE IF NOT EXISTS vcs_ref (
        name TEXT PRIMARY KEY,
        object_id TEXT,
        target TEXT,
        peeled_object_id TEXT,
        storage TEXT NOT NULL DEFAULT 'primary',
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      -- Staging entries
      CREATE TABLE IF NOT EXISTS staging_entry (
        path TEXT NOT NULL,
        stage INTEGER NOT NULL DEFAULT 0,
        mode INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        ctime INTEGER,
        dev INTEGER,
        ino INTEGER,
        assume_valid INTEGER DEFAULT 0,
        intent_to_add INTEGER DEFAULT 0,
        skip_worktree INTEGER DEFAULT 0,
        PRIMARY KEY (path, stage)
      ) WITHOUT ROWID;
    `,
    down: `
      DROP TABLE IF EXISTS staging_entry;
      DROP TABLE IF EXISTS vcs_ref;
      DROP TABLE IF EXISTS vcs_tag;
      DROP INDEX IF EXISTS commit_parent_parent_idx;
      DROP TABLE IF EXISTS commit_parent;
      DROP TABLE IF EXISTS vcs_commit;
      DROP INDEX IF EXISTS tree_entry_name_idx;
      DROP TABLE IF EXISTS tree_entry;
      DROP TABLE IF EXISTS tree;
    `,
  },
  {
    version: 4,
    name: "extended_query_indexes",
    up: `
      -- Commit indexes for extended queries
      CREATE INDEX IF NOT EXISTS commit_author_email_idx ON vcs_commit(author_email);
      CREATE INDEX IF NOT EXISTS commit_author_timestamp_idx ON vcs_commit(author_timestamp);
      CREATE INDEX IF NOT EXISTS commit_committer_email_idx ON vcs_commit(committer_email);
      CREATE INDEX IF NOT EXISTS commit_committer_timestamp_idx ON vcs_commit(committer_timestamp);
      CREATE INDEX IF NOT EXISTS commit_message_idx ON vcs_commit(message);

      -- Tag indexes for extended queries
      CREATE INDEX IF NOT EXISTS tag_name_idx ON vcs_tag(tag_name);
      CREATE INDEX IF NOT EXISTS tag_tagger_email_idx ON vcs_tag(tagger_email);
      CREATE INDEX IF NOT EXISTS tag_object_type_idx ON vcs_tag(object_type);
      CREATE INDEX IF NOT EXISTS tag_tagger_timestamp_idx ON vcs_tag(tagger_timestamp);

      -- Tree entry indexes for extended queries
      CREATE INDEX IF NOT EXISTS tree_entry_object_id_idx ON tree_entry(object_id);
    `,
    down: `
      DROP INDEX IF EXISTS tree_entry_object_id_idx;
      DROP INDEX IF EXISTS tag_tagger_timestamp_idx;
      DROP INDEX IF EXISTS tag_object_type_idx;
      DROP INDEX IF EXISTS tag_tagger_email_idx;
      DROP INDEX IF EXISTS tag_name_idx;
      DROP INDEX IF EXISTS commit_message_idx;
      DROP INDEX IF EXISTS commit_committer_timestamp_idx;
      DROP INDEX IF EXISTS commit_committer_email_idx;
      DROP INDEX IF EXISTS commit_author_timestamp_idx;
      DROP INDEX IF EXISTS commit_author_email_idx;
    `,
  },
];

/**
 * Initialize database schema and run pending migrations
 *
 * Creates the schema_version table if it doesn't exist and applies
 * any migrations that haven't been run yet.
 *
 * @param db Database client
 */
export async function initializeSchema(db: DatabaseClient): Promise<void> {
  // Ensure schema_version table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get current version
  const rows = await db.query<{ version: number | null }>(
    "SELECT MAX(version) as version FROM schema_version",
  );
  const currentVersion = rows[0]?.version ?? 0;

  // Apply pending migrations in order
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      await db.transaction(async (tx) => {
        // Split and run migration statements
        const statements = splitStatements(migration.up);
        for (const stmt of statements) {
          await tx.execute(stmt);
        }

        // Record migration
        await tx.execute("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [
          migration.version,
          Date.now(),
        ]);
      });
    }
  }
}

/**
 * Rollback migrations to a specific version
 *
 * @param db Database client
 * @param targetVersion Version to rollback to (migrations above this will be reverted)
 */
export async function rollbackMigration(db: DatabaseClient, targetVersion: number): Promise<void> {
  const rows = await db.query<{ version: number | null }>(
    "SELECT MAX(version) as version FROM schema_version",
  );
  const currentVersion = rows[0]?.version ?? 0;

  // Get migrations to rollback in reverse order
  const toRollback = migrations
    .filter((m) => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of toRollback) {
    await db.transaction(async (tx) => {
      // Split and run rollback statements
      const statements = splitStatements(migration.down);
      for (const stmt of statements) {
        await tx.execute(stmt);
      }

      // Remove migration record
      await tx.execute("DELETE FROM schema_version WHERE version = ?", [migration.version]);
    });
  }
}

/**
 * Get current schema version
 *
 * @param db Database client
 * @returns Current version number, or 0 if no migrations have been applied
 */
export async function getSchemaVersion(db: DatabaseClient): Promise<number> {
  try {
    const rows = await db.query<{ version: number | null }>(
      "SELECT MAX(version) as version FROM schema_version",
    );
    return rows[0]?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Split SQL string into individual statements
 *
 * Handles semicolon-separated statements while preserving
 * content within string literals.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
