# @statewalker/vcs-core

## What it is

The Git object engine: types and stores for blobs, trees, commits, annotated tags and refs, ancestry walks and merge-base search, Git pack reading and writing, delta compression and garbage collection. Objects are byte-compatible with Git (same SHA-1 ids, same serialization). Storage is pluggable; the package ships in-memory storage and an adapter onto the `@statewalker/webrun-storage` byte seam.

## Why it exists

Versioning needs one engine that knows Git's object model and nothing else. This package does not touch a working directory, a staging index or a network connection, and it does not know where bytes are stored. Those concerns sit in other packages that build on it:

- `@statewalker/vcs-working-tree`: staging, checkout, worktree, status, stash
- `@statewalker/vcs-commands`: porcelain commands (`add`, `commit`, `merge`, ...)
- `@statewalker/vcs-store-*`: storage backends (Git files on disk, SQL, key-value, memory)
- `@statewalker/vcs-transport*`: Git wire protocol and large-object transfer

Because the engine only reads and writes through interfaces, the same commit, tree and ref logic runs in a browser over IndexedDB, in Node.js over a `.git` directory, or in tests over memory.

## How to use it

```bash
pnpm add @statewalker/vcs-core
```

`@statewalker/vcs-utils` (hashing, compression, deltas) and `@statewalker/webrun-storage` (the byte seam) are regular dependencies and are installed with it. No peer dependencies. Runs in browsers, workers and Node.js.

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-core` | Everything from `history`, `storage` and `backend`, plus `createVcsCore`, GC (`GcOrchestrator`, `MemoryGcStrategy`), `FileMode`, `ObjectId`, `PersonIdent` and the file helpers re-exported from `@statewalker/vcs-utils/files` |
| `@statewalker/vcs-core/history` | `History`, `HistoryWithOperations`, typed stores (`Blobs`, `Trees`, `Commits`, `Tags`, `Refs`), factories (`createMemoryHistory`, `createMemoryHistoryWithOperations`, `createGitFilesHistory`, `createHistoryFromStores`, `createHistoryFromComponents`), object/commit/tree/tag formats, ref constants (`HEAD`, `R_HEADS`, ...) |
| `@statewalker/vcs-core/storage` | Raw storage (`MemoryRawStorage`, `CompressedRawStorage`, `ChunkedRawStorage`, ...), delta engine and strategies, webrun-storage adapters (`blobStoreToRawStorage`, `kvStoreRefs`) |
| `@statewalker/vcs-core/backend` | Backend registry (`createHistory`, `registerHistoryBackendFactory`), `BackendCapabilities`, `StorageOperations`, pack files (`writePack`, `indexPack`, `readPackIndex`, `parsePackEntries`, ...) |
| `@statewalker/vcs-core/serialization` | `SerializationApi`, `DefaultSerializationApi`, `createSerializationApi(history)` (not in the root export) |

The happy path is an in-memory `History`:

```typescript
import { createMemoryHistory } from "@statewalker/vcs-core";

const history = createMemoryHistory();
await history.initialize();
// history.blobs, history.trees, history.commits, history.tags, history.refs
await history.close();
```

## Examples

### Store a blob, a tree and a commit

```typescript
import { createMemoryHistory, FileMode, type PersonIdent } from "@statewalker/vcs-core";

const history = createMemoryHistory();
await history.initialize();

const blobId = await history.blobs.store([new TextEncoder().encode("Hello, World!\n")]);

// Entries can be in any order; they are sorted the way Git sorts them
const treeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);

const me: PersonIdent = {
  name: "Developer",
  email: "dev@example.com",
  timestamp: Math.floor(Date.now() / 1000), // Unix seconds
  tzOffset: "+0000",
};
const commitId = await history.commits.store({
  tree: treeId,
  parents: [],
  author: me,
  committer: me,
  message: "Initial commit\n",
});

await history.refs.set("refs/heads/main", commitId);
await history.refs.setSymbolic("HEAD", "refs/heads/main");
```

### Read content back

```typescript
const content = await history.blobs.load(blobId); // AsyncIterable<Uint8Array> | undefined
if (content) {
  for await (const chunk of content) process(chunk);
}

const tree = await history.trees.load(treeId); // AsyncIterable<TreeEntry> | undefined
const readme = await history.trees.getEntry(treeId, "README.md");

const commit = await history.commits.load(commitId); // Commit | undefined
```

### Walk history and refs

```typescript
const head = await history.refs.resolve("HEAD"); // follows symbolic refs: { name, objectId, ... }

for await (const id of history.commits.walkAncestry(head!.objectId, { limit: 20 })) {
  const c = await history.commits.load(id);
  console.log(id.slice(0, 7), c?.message.split("\n")[0]);
}

const bases = await history.commits.findMergeBase(commitA, commitB); // ObjectId[]
const isAnc = await history.commits.isAncestor(commitA, commitB);

for await (const ref of history.refs.list("refs/heads/")) {
  console.log(ref.name);
}

// Atomic update: succeeds only if the ref still points at expectedOldId
const result = await history.refs.compareAndSwap("refs/heads/main", expectedOldId, newId);
```

`walkAncestry` accepts one id or an array, and the options `limit`, `stopAt` and `firstParentOnly`.

### Build and import a pack

```typescript
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createSerializationApi } from "@statewalker/vcs-core/serialization";

async function* wanted() {
  yield commitId;
  yield treeId;
  yield blobId;
}

// Pack from any History
const pack = createSerializationApi(history).createPack(wanted());

// HistoryWithOperations already carries a serialization API
const target = createMemoryHistoryWithOperations();
await target.initialize();
const stats = await target.serialization.importPack(pack);
// { objectsImported: 3, treesImported: 1, commitsImported: 1, ... }
```

### The `VcsCore` facade over `@statewalker/webrun-storage`

`createVcsCore()` builds the same engine over a `BlobStore` (object bytes) and a `KvStore` (refs) and returns a smaller API: arrays instead of async iterables where that is simpler, one merge base, hydrated log entries, and refs with `read` / `compareAndSet` / `list`.

```typescript
import { createVcsCore, FileMode } from "@statewalker/vcs-core";
import { memBlobStore, memKvStore } from "@statewalker/webrun-storage";

const vcs = createVcsCore({ objects: memBlobStore(), refs: memKvStore() });

const blob = await vcs.writeBlob(
  (async function* () {
    yield new TextEncoder().encode("hi\n");
  })(),
);
const tree = await vcs.writeTree([{ mode: FileMode.REGULAR_FILE, name: "a.txt", id: blob }]);
const commit = await vcs.writeCommit({ tree, parents: [], author: me, committer: me, message: "first\n" });

await vcs.refs.compareAndSet("refs/heads/main", undefined, commit);
for await (const entry of vcs.log(commit)) console.log(entry.id, entry.message);

const { pruned } = await vcs.gc();
```

`filesBlobStore()` from `@statewalker/webrun-storage` stores the same objects in any `FilesApi` instead of memory.

### Git repositories on disk

`createGitFilesHistory(config)` assembles a `HistoryWithOperations` from already-built Git-file stores (blobs, trees, commits, tags, refs and a pack delta store). The package that builds those stores from a `FilesApi` is `@statewalker/vcs-store-files` (`createGitFilesBackend({ files, gitDir })`).

## Internals

### How the layers stack

```
History / HistoryWithOperations        createMemoryHistory(), createGitFilesHistory(), createVcsCore()
  ├─ blobs, trees, commits, tags      typed, parsed objects (Blobs, Trees, Commits, Tags)
  └─ refs                             Refs: get/resolve/set/setSymbolic/compareAndSwap/list
        │
GitObjectStore                         "<type> <size>\0<content>", SHA-1 over the whole thing
        │
RawStorage                             bytes by key: MemoryRawStorage, CompressedRawStorage,
                                       ChunkedRawStorage, blobStoreToRawStorage(BlobStore), ...
```

Every typed store delegates to one `GitObjectStore`, which adds the Git header, computes the id and reads the type back. Below it, a `RawStorage` stores bytes by key and knows nothing about Git. A new backend can stop at that level: `createHistoryFromComponents({ objects: createGitObjectStore(rawStorage), refs: { type: "memory" } })` gives a full `History` (use `{ type: "adapter", refStore }` for persistent refs). `HistoryWithOperations` adds `delta` (deltify objects for storage), `serialization` (loose objects and packs) and `capabilities` (what the backend does natively), which GC and transport use.

### Why everything streams

Blob content is `AsyncIterable<Uint8Array>` on the way in and out, and trees load as async iterables of entries. A large file passes through with bounded memory, which matters in browsers. `VcsCore` collects trees into arrays because trees are small and arrays are easier to use.

### Only SHA-1 is implemented

Only SHA-1 is implemented. `createVcsCore(deps, { hash: "sha256" })` throws `sha256 not yet supported (requested hash: "sha256")` instead of silently writing SHA-1 ids.

### What breaks, and the error you see

- `blobs.load`, `trees.load`, `commits.load` and `tags.load` return `undefined` for a missing id. `trees`, `commits` and `tags` also return `undefined` when the id exists but is a different object type or does not parse. A wrong id and a corrupt object look the same; check `history.blobs.has(id)` or the object header if you need to tell them apart.
- `VcsCore.readCommit`, `readTree` and `readTag` throw `Commit not found: <id>`, `Tree not found: <id>`, `Tag not found: <id>` in the same cases.
- `createHistory(type, config)` throws `Unknown history backend type: <type>. Available types: ...` unless a backend registered that type first with `registerHistoryBackendFactory()`. This package registers none; `@statewalker/vcs-store-sql` registers `"sql"`. For memory or Git files, call `createMemoryHistoryWithOperations()` or `createGitFilesHistory()` directly.
- Refs: resolving a symbolic ref chain deeper than the limit throws `Symbolic ref chain too deep (> N)`.
- Malformed objects: `Invalid object header: ...`, `Invalid commit: missing tree|author|committer`, `Invalid tag: missing object|type|tag name`, `Tree entry name cannot be empty`.

### Where the model follows JGit

Object type codes, the commit model, reflog types and the delta index (16-byte block hash table) follow Eclipse JGit, so edge cases are decided the way JGit decides them.

### Delta compression and GC are pluggable

`storage` holds a delta engine split into three replaceable parts: a `CandidateFinder` (which objects might be good bases), a `DeltaCompressor` (compute and apply a delta) and a `DeltaDecisionStrategy` (whether a delta is worth keeping, maximum chain depth). Ready-made strategies: `createGitNativeStrategy()`, `createBlobOnlyStrategy()`, `createPackStrategy()`, `createNetworkStrategy()`. `GcOrchestrator` with a `GcStrategy` (`MemoryGcStrategy` for raw storage) prunes unreachable objects.

### Dependencies

- `@statewalker/vcs-utils`: SHA-1, zlib, delta formats, varints, the `FilesApi` type and file helpers.
- `@statewalker/webrun-storage`: `BlobStore` / `KvStore` / `RefStore` types and the `refStore` facade used by `createVcsCore` and the `blobStoreToRawStorage` / `kvStoreRefs` adapters.

Tests: `pnpm --filter @statewalker/vcs-core test`.

## License

MIT
