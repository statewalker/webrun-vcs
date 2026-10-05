# @statewalker/vcs-store-sql

StateWalker VCS stores on SQLite (or any SQL database you wrap in a four-method `DatabaseClient`):
Git objects in normalized tables, refs, the staging area, blob and tree deltas, schema migrations,
and a `HistoryWithOperations` factory. A `sql.js` adapter is included, so it runs in the browser
and in Node without native modules.

## Why it exists

A repository kept in files or a key-value store can only be searched by walking every object.
Storing commits, trees and tags as rows makes questions like "commits by this author", "commits
in this date range", "trees that contain this blob" or "files named `*.ts`" indexed SQL queries.
SQLite also gives transactions and a single-file database that can be exported and reopened. The
`DatabaseClient` interface keeps the stores independent of a specific driver.

## How to use

```bash
pnpm add @statewalker/vcs-store-sql sql.js
```

`sql.js` (`>=1.14.1`) is an optional peer dependency, needed only for the bundled `SqlJsAdapter`.
With your own `DatabaseClient` you do not need it.

| Entry point | Gives |
| --- | --- |
| `@statewalker/vcs-store-sql` | Stores, schema, factory, sync helpers (below) |
| `@statewalker/vcs-store-sql/adapters/sql-js` | `SqlJsAdapter` (sql.js / SQLite in WebAssembly); browser and Node |

Typical setup:

1. Open a database: `const db = await SqlJsAdapter.create()` (empty) or `SqlJsAdapter.open(bytes)`.
2. Create the tables: `await initializeSchema(db)`.
3. Create the stores: `createSqlNativeStores(db)` for objects, plus `new SQLRefStore(db)` and
   `new SQLStaging(db)`.

| Export | What it is |
| --- | --- |
| `DatabaseClient`, `ExecuteResult` (types) | Driver contract: `query`, `execute`, `transaction`, `close`. |
| `initializeSchema(db)`, `getSchemaVersion(db)`, `rollbackMigration(db, version)`, `migrations` | Versioned schema (currently version 4). |
| `createSqlNativeStores(db)` | `{ commits, trees, blobs, tags }` in normalized tables with **Git-compatible SHA-1 ids** and query methods. |
| `SqlNativeCommitStoreImpl`, `SqlNativeTreeStoreImpl`, `SqlNativeBlobStoreImpl`, `SqlNativeTagStoreImpl` | The classes behind `createSqlNativeStores`. |
| `SQLRefStore` | `Refs` in table `vcs_ref`. |
| `SQLStaging` | `Staging` (the index) in table `staging_entry`. |
| `SQLCommitStore`, `SQLTreeStore`, `SQLTagStore` | Same tables as the native stores, but ids from FNV-1a, **not Git ids** (see Internals). |
| `createSqlObjectStores({ db, tableName? })` | `{ objects, blobs, trees, commits, tags }`: Git-format bytes in one key/value table (default `raw_objects`), Git ids, no query methods. |
| `SQLHistoryFactory`, `registerSqlHistoryFactory()` | Build a `HistoryWithOperations` directly, or register it as the `"sql"` backend for `createHistory("sql", { db })` from `@statewalker/vcs-core`. |
| `SqlDeltaApi`, `SqlTreeDeltaApi` | `DeltaApi` for blobs (table `blob_delta`) and structural tree deltas (`tree_delta`, `tree_delta_entry`). |
| `SqlRawStore`, `SqlDeltaStore`, `SqlBinStore` + `createSqlRawStore` / `createSqlDeltaStore` / `createSqlBinStore` | `RawStorage` / `DeltaStore` / `BinStore` on tables `raw_store` and `delta_store` (names configurable). |
| `importToNative`, `exportToGit`, `syncObjects` | Copy objects between any `History` and the native SQL stores. |
| `SqlGcStrategy` | `GcStrategy` for a `History`: `prune()` deletes rows; `compact()` and `deltify()` do nothing. |
| `createGitObjectStore`, `createBlobs`, `createTrees`, `createCommits`, `createTags` | Re-exported from `@statewalker/vcs-core`. |

## Examples

### A repository in SQLite

```ts
import { FileMode } from "@statewalker/vcs-core";
import {
  createSqlNativeStores,
  initializeSchema,
  SQLRefStore,
  SQLStaging,
} from "@statewalker/vcs-store-sql";
import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";

const db = await SqlJsAdapter.create();
await initializeSchema(db);

const stores = createSqlNativeStores(db);
const refs = new SQLRefStore(db);
const staging = new SQLStaging(db);

const blobId = await stores.blobs.store([new TextEncoder().encode("hello\n")]);
// "ce013625030ba8dba906f756967f9e9ca394464a", same as `git hash-object`
await staging.setEntry({ path: "README.md", mode: FileMode.REGULAR_FILE, objectId: blobId });
const treeId = await staging.writeTree(stores.trees);

const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
const commitId = await stores.commits.store({
  tree: treeId,
  parents: [],
  author: who,
  committer: who,
  message: "init\n",
});

await refs.set("refs/heads/main", commitId);
await refs.setSymbolic("HEAD", "refs/heads/main");
await refs.resolve("HEAD"); // { name: "refs/heads/main", objectId: commitId, ... }
```

### Queries

```ts
for await (const id of stores.commits.findByAuthor("ada@example.com")) console.log(id);
for await (const id of stores.commits.findByDateRange(new Date("2023-01-01"), new Date())) console.log(id);
for await (const id of stores.commits.searchMessage("init")) console.log(id);
for await (const id of stores.commits.getAncestors(commitId)) console.log(id); // excludes commitId
for await (const id of stores.trees.findTreesWithBlob(blobId)) console.log(id);
for await (const hit of stores.trees.findByNamePattern("%.md")) console.log(hit.treeId, hit.entry.name);
for await (const id of stores.tags.findByTagger("ada@example.com")) console.log(id);
await stores.commits.count();
await stores.blobs.totalSize(); // bytes
```

Name patterns (`trees.findByNamePattern`, `tags.findByNamePattern`) are SQL `LIKE` patterns: `%`
for any run of characters, `_` for one character. `*` and `?` are matched literally.

### Save the database and open it again

```ts
import { readFile, writeFile } from "node:fs/promises";
import { SQLRefStore } from "@statewalker/vcs-store-sql";
import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";

await writeFile("repo.sqlite", db.export()); // sql.js keeps the database in memory
await db.close();

const reopened = await SqlJsAdapter.open(await readFile("repo.sqlite"));
await new SQLRefStore(reopened).resolve("HEAD");
```

In the browser, pass `{ wasmUrl }` to `create`/`open` to say where `sql-wasm.wasm` is served, or
`{ sqlJs }` to reuse an already initialized sql.js module.

### As a `HistoryWithOperations`

```ts
import { createHistory } from "@statewalker/vcs-core";
import { registerSqlHistoryFactory } from "@statewalker/vcs-store-sql";
import { SqlJsAdapter } from "@statewalker/vcs-store-sql/adapters/sql-js";

registerSqlHistoryFactory();
const history = await createHistory("sql", { db: await SqlJsAdapter.create() });
await history.initialize(); // runs initializeSchema
// history.blobs / trees / commits / tags / refs / delta / serialization
await history.close(); // closes the database
```

Read "What will surprise you" below before using this path where Git ids matter.

### Copying objects in from another store

```ts
import { createMemoryHistory } from "@statewalker/vcs-core";
import { createSqlNativeStores, importToNative, syncObjects } from "@statewalker/vcs-store-sql";

const source = createMemoryHistory();
await source.initialize();
const id = await source.blobs.store([new TextEncoder().encode("x")]);

const copied = await importToNative(source, createSqlNativeStores(db), syncObjects([id], "blob"));
// 1; objects already present are skipped and not counted
```

`exportToGit(nativeStores, history, objects)` copies in the other direction.

### A custom `DatabaseClient`

```ts
import type { DatabaseClient } from "@statewalker/vcs-store-sql";

class MyClient implements DatabaseClient {
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> { /* rows as objects */ }
  async execute(sql: string, params?: unknown[]) {
    /* run statement */
    return { lastInsertRowId: 0, changes: 0 };
  }
  async transaction<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
    /* BEGIN; const r = await fn(this); COMMIT; return r  (ROLLBACK on throw) */
  }
  async close() {}
}
```

The SQL the stores issue is SQLite dialect (`INSERT OR REPLACE`, `AUTOINCREMENT`, recursive CTEs
for ancestry), so a client for another engine has to accept it.

## Internals

### Schema

`initializeSchema` creates `schema_version` and applies every migration above the stored version,
each in its own transaction:

| Version | Name | Creates |
| --- | --- | --- |
| 1 | `initial_schema` | `object`, `delta`, `metadata` |
| 2 | `delta_content_table` | `delta_content` |
| 3 | `high_level_stores` | `tree`, `tree_entry`, `vcs_commit`, `commit_parent`, `vcs_tag`, `vcs_ref`, `staging_entry` |
| 4 | `extended_query_indexes` | indexes on author/committer email and time, message, tag name/tagger/type, `tree_entry.object_id` |

No store reads or writes the version 1 and 2 tables. Other tables are created on first use by the
store that owns them: `vcs_blob` and `vcs_blob_chunk` (native blobs), `blob_delta`, `tree_delta`,
`tree_delta_entry` (`SqlDeltaApi`), `raw_store` / `raw_objects` (`SqlRawStore`), `delta_store`
(`SqlDeltaStore`). Migrations are split on `;`, so a migration body must not contain a semicolon
inside a string literal.

### Why commits, trees and tags are rows, not blobs

The native stores keep each commit field in a column, parents in `commit_parent`, and each tree
entry in `tree_entry`. That is what makes the query methods indexed lookups and lets
`getAncestors` run as one recursive SQL query instead of loading commits one by one. The Git id is
still computed by serializing the object in Git format and hashing it with SHA-1, so ids match
`git` and objects can be exchanged with other backends.

`createSqlObjectStores` is the other option: Git-format bytes under their id in one key/value
table. Use it when you only need Git-compatible storage in SQLite and no queries.

### Large blobs are chunked and compressed

Blobs up to 256 KiB are stored inline in `vcs_blob`, uncompressed. Larger blobs are split into
256 KiB chunks in `vcs_blob_chunk`, each compressed with `compressBlock` from
`@statewalker/vcs-utils`, and streamed back chunk by chunk on `load`. 256 KiB keeps each row a
reasonable BLOB for SQLite while bounding memory per chunk. The whole blob is still read once to
compute its SHA-1 before it is written.

### Two id schemes in the same tables

`SQLCommitStore`, `SQLTreeStore` and `SQLTagStore` write to the same tables as the native stores,
but take ids from `computeCommitHash` / `computeTreeHash` / `computeTagHash` in
`@statewalker/vcs-core`: a 32-bit FNV-1a hash with a type prefix, zero-padded to 40 characters
(`tree84b15896000…`, `commit63bc4c49000…`). These are not Git ids. Do not mix the two families
on one database unless you track which id came from which store.

### What will surprise you

- **`SQLHistoryFactory` (and `createHistory("sql", …)`) does not produce Git ids for trees,
  commits and tags.** It wires `SqlNativeBlobStoreImpl` (SHA-1) with `SQLTreeStore`,
  `SQLCommitStore` and `SQLTagStore` (FNV-1a). Storing `hello\n`, a one-file tree and a commit
  through it gives `ce0136…` (Git), `tree84b15896000…`, `commit63bc4c49000…`. Its capabilities
  report `nativeGitFormat: false`. If you need Git-compatible history, build it from
  `createSqlNativeStores(db)` instead.
- **`SQLRefStore.compareAndSwap` on a symbolic ref replaces the symbolic ref.** Calling it with
  `"HEAD"` compares against the branch HEAD points to, then writes the new id into `HEAD` itself.
  HEAD becomes a detached direct ref and the branch does not move. Call it with the branch name.
  It is also a read followed by a write, not one transaction.
- `SqlDeltaApi.startBatch()` / `endBatch()` only count nesting; each write commits on its own and
  `cancelBatch()` does not roll anything back. `endBatch()` without `startBatch()` throws
  `No batch in progress`. `listDeltas()` reports `ratio: 0`.
- `SqlJsAdapter.transaction()` is reentrant by an instance-wide flag. A second, unrelated
  `transaction()` started while one is awaiting joins it instead of waiting. Do not run
  independent transactions on one adapter concurrently.
- `SqlGcStrategy.getStats()` reports `totalSize: 0`; it counts objects only.
- `sql.js` keeps the whole database in memory. Nothing is on disk until you `export()` it.

### Errors

| Situation | Error |
| --- | --- |
| `createHistory("sql", {})` without `db` | `SQL backend requires a database client. Provide 'db' in config, e.g., { db: await SqlJsAdapter.create() }` |
| `staging.writeTree()` with conflict stages | `Cannot write tree with unresolved conflicts` |
| `staging.readTree()` of a missing tree | `Tree not found` |
| Index builder: missing mode / duplicate / stage 0 with stages 1-3 | `FileMode not set for path <path>` / `Duplicate entry: <path> stage <n>` / `Invalid stages for <path>: stage 0 cannot coexist with other stages` |
| `resolveConflict()` without an entry at that stage | `No entry at stage <n> for path: <path>` |
| Symbolic ref chain or nested tag chain deeper than 100 | `Symbolic ref chain too deep (> 100)` / `Tag chain too deep (> 100)` |
| `getParents()` of a missing commit | `Commit <id> not found` |
| Blob delta chain longer than 50 | `Delta chain would exceed max depth (50)` |
| `importToNative` / `exportToGit` with an id missing in the source | `Commit not found: <id>` (or `Tree` / `Blob` / `Tag`) |
| `SqlRawStore.load()` of a missing key | `Key not found: <key>` |

### Dependencies

- `@statewalker/vcs-core`: store interfaces, Git object encoding, `HistoryImpl` /
  `HistoryWithOperationsImpl`, the backend registry, ancestry algorithms.
- `@statewalker/vcs-utils`: SHA-1, block compression, the `Delta` type.
- `@statewalker/vcs-working-tree`: the `Staging` interface.
- `sql.js` (optional peer): only for `@statewalker/vcs-store-sql/adapters/sql-js`, loaded with a
  dynamic `import()` so the main entry does not pull it in.

## License

MIT
