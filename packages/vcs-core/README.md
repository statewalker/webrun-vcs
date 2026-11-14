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

### Update several refs at once

```typescript
const r = await history.refs.batch([
  { name: "refs/heads/main", old: oldMain, new: newMain }, // must still be oldMain
  { name: "refs/tags/v1", old: null, new: tagId }, // must not exist yet
  { name: "refs/heads/tmp", new: null }, // delete, whatever it holds
]);
if (!r.ok) console.log(r.rejected); // e.g. [{ name: "refs/heads/main", reason: "mismatch" }]
```

A batch applies every command or none. It is checked as `git update-ref --stdin` checks it: names must be `HEAD` or valid names under `refs/`, a ref may appear once, a ref and a ref below it (`refs/a`, `refs/a/b`) cannot both exist, and each `old` must match. A command naming a symbolic ref (such as `HEAD`) updates its target, unless `noDeref: true` asks to update the name itself. `rejected` tells which commands failed and why (`mismatch`, `invalid-name`, `duplicate`, `df-conflict`, `invalid-command`, `not-atomic`, `locked`, `unsupported`). Two rules go beyond git, on purpose: a detached HEAD cannot join a multi-ref batch (`not-atomic`; git files could not commit it atomically with packed refs), and symbolic-ref chains are followed for at most 5 refs, git's limit for reading refs. `compareAndSwap` is a one-command batch.

```typescript
await refs.batch([{ name: "refs/heads/main", old: c1, new: c2 }], {
  ident: "Ada <ada@example.com> 1700000000 +0000",
  message: "commit: second",
});
const log = await refs.getReflog?.("HEAD");
for (const e of (await log?.getReverseEntries()) ?? []) {
  console.log(e.oldId, e.newId, e.comment);
}
```

Batches also keep reflogs, as git does with `core.logAllRefUpdates=true`: a ref that changes gets a line (`ident` and `message` from the options, the message on one line), and every symbolic ref the update goes through gets the same line, as does `HEAD` when it points at the updated branch, whether the batch names the branch or `HEAD`. A no-op update logs no line for the branch, but still one for `HEAD`. Logs start only for `HEAD`, `refs/heads/`, `refs/remotes/` and `refs/notes/`; other refs, such as tags, get lines only once they have a log, which in practice only the git-files store can have (one git wrote). Deleting a ref deletes its log, and `HEAD` records the delete. A batch that is rejected writes no lines. The SQL and memory stores write lines with the refs, and as in git a line that cannot be written fails the batch; the KV store writes them after the batch commits (see its README). `planReflog(updates, options)` decides the lines for any store, and `createReflogReaderOf(lines)` reads them back.

Every `Refs` has `batch`. The in-memory (`MemoryRefs`), SQL (`SQLRefStore`, one transaction), KV (`KVRefStore`, one compare-and-swap of a root value) and git-files (`FileRefStore`, git's lock files and a two-phase packed-refs commit) stores apply batches atomically. `kvStoreRefs` accepts only a batch of one command and refuses larger ones, and `noDeref` on a symbolic ref, as `unsupported`: its one-key-per-ref layout is shared with `@statewalker/webrun-storage`'s `refStore` facade.

`walkAncestry` accepts one id or an array, and the options `limit`, `stopAt` and `firstParentOnly`.

### Check and sort ref names as git does

```typescript
import { compareRefNames, isValidBranchName, isValidRefName } from "@statewalker/vcs-core";

isValidRefName("refs/heads/feature/x"); // true
isValidRefName("refs/heads/.hidden"); // false: a component starts with "."
isValidRefName("refs/heads/x.lock/y"); // false: a component ends with ".lock"
isValidRefName("main"); // false: one level
isValidRefName("main", { allowOneLevel: true }); // true
isValidBranchName("HEAD"); // false: git branch refuses it

["refs/heads/a", "refs/heads/B"].sort(compareRefNames); // ["refs/heads/B", "refs/heads/a"]
```

`isValidRefName` gives the same verdict as `git check-ref-format` (with `--allow-onelevel` when `allowOneLevel` is set); a test compares it with git on a fixture of over 1,500 names, regenerated by `node scripts/make-refname-fixture.mjs`. `isValidBranchName` and `isValidTagName` add `git branch`'s and `git tag`'s own rules (no leading `-`, not `HEAD`) and check the full `refs/heads/…` or `refs/tags/…` name; the branch, tag and checkout commands use them. `compareRefNames` is git's order, the byte order of the UTF-8 names, which neither `localeCompare` nor `<` gives; branch and tag lists and the packed-refs writer sort with it.

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

### Installing packs

```typescript
import { installPack, PackError, sweepPackTemporaries } from "@statewalker/vcs-core";

// `received` is the pack a fetch delivered, as an AsyncIterable<Uint8Array>
const { packId, count, appended } = await installPack(files, ".git/objects/pack", received, {
  // a thin pack's missing bases, from the objects the repository already has
  externalBase: async (id) => {
    const object = await loadObject(id); // your object lookup
    return object && { type: object.type, data: object.bytes };
  },
});
// .git/objects/pack/pack-<packId>.pack and pack-<packId>.idx are now in place

// at startup or during gc: remove temporaries a crashed install left behind
await sweepPackTemporaries(files, ".git/objects/pack", 14 * 24 * 3600 * 1000);
```

`installPack` is `git index-pack --stdin --fix-thin` over a `FilesApi`. It stores the stream as `tmp_pack_*` in the pack directory, reads it once (entry headers, every zlib stream inflated once, the CRC-32 of each entry, the trailer), resolves the deltas from each base down, writes an `.idx` v2 that is byte-identical to `git index-pack`'s, and renames the pack into place first and the idx last. Readers open packs through their `.idx`, so they never see a pack that is not complete.

A thin pack, the kind every `git fetch` receives, has REF_DELTA entries whose bases are not in the pack. With `externalBase`, each missing base is asked for once, must hash to the id it was asked for, and is appended to the pack as a whole object; the pack gets a new object count and trailer, so `packId` names the completed pack and `appended` counts the added bases. Without `externalBase` a thin pack is refused. Appended bases are compressed with pako at zlib level 6, so the completed pack is valid for git but not byte-identical to the one `git index-pack --fix-thin` writes: its id differs.

A corrupt or hostile pack is refused with `PackError` (a `CorruptObjectError`) and leaves nothing in the pack directory: a bad trailer, truncation, trailing bytes, broken zlib, an entry that inflates past its declared size (inflation stops at the first extra byte), a delta cycle, a missing base, or an object over `maxObjectSize` (default 1 GiB; delta results are checked before they are allocated). `maxPackSize` bounds the stream while it is stored, and a stream that does not start with `PACK` is refused at its first chunk.

Resolving deltas holds the delta chain being resolved, not the pack: entries are kept in typed arrays (about 80 bytes each), resolved bases are cached up to `baseCacheBytes` (default 32 MiB) and re-derived when evicted, and entries are re-read through one window of `windowBytes` (default 1 MiB) over the stored pack. Storing the incoming pack is up to the FilesApi: the Node and in-memory ones collect a file before writing it, so there the pack is held once while it is stored (set `maxPackSize` for untrusted sources). A storage failure (EIO and the like) comes through unchanged; only a malformed pack raises `PackError`. The pack is moved into place before its idx, and a leftover pack from a crash between the two is replaced by the next install of that pack (FilesApi `move` overwrites). Not yet checked: an incoming object whose id the repository already has with other bytes (git's collision check); the pack importer adds that. An install interrupted by a crash leaves `tmp_*` files; `sweepPackTemporaries(files, packDir, olderThanMs)` removes those older than the threshold, as `git prune` does, and keeps younger ones that may belong to an install in progress.

`writePackIdx(entries, packChecksum)` writes the same `.idx` v2 from a list of `{ id, offset, crc32 }`.

### Reading packs

```typescript
import { openPackSet } from "@statewalker/vcs-core";

const packs = await openPackSet(files, ".git/objects/pack", {
  externalBase: (id) => looseObjects.get(id), // REF_DELTA bases no pack holds (optional)
});
const obj = await packs.get(id, { verify: true }); // { type, size, content } or undefined
for await (const chunk of obj?.content ?? []) consume(chunk);

for (const s of packs.skipped) console.warn(`skipped ${s.pack}: ${s.error}`);

await packs.install(received); // installPack, then the pack is readable at once
await packs.remove([oldPackId]); // .idx first, then .pack, .keep, .rev…
```

`openPackSet` reads every `pack-<id>.idx` of a directory together with its `.pack`, the way git's object database does. Each idx is validated when it is opened: version (v2, and v1 for old repositories), monotonic fan-out, exact length including the 64-bit offset table, its own SHA-1, ids sorted and in their fan-out buckets, and the pack trailer must be the checksum the idx records. That last check is the one that catches an idx of another pack with the same object count. A pack that fails any of this is skipped and recorded in `skipped`, as git warns and skips; the rest of the set stays readable.

Lookups go through the fan-out table and a binary search. Whole objects stream straight out of the inflater, so a large blob is never held in memory. Deltas are walked down to a whole object (or a cached one) and patched upwards with the checked delta applier, through one byte-bounded base cache for the whole set (`baseCacheBytes`, default 16 MiB, git's `core.deltaBaseCacheLimit`). The cache keeps checkpoints spread along a chain rather than every step: on random reads of a 50-deep chain it halves the inflations, where caching every step lets the top of the last chain evict the rest. Callers always receive copies, never a cached buffer.

A miss rescans the directory, at most once per `rescanIntervalMs` (default 1 s; the first miss always rescans), so a pack native git writes after open is found; `refresh()` rescans now. A REF_DELTA whose base is in another pack of the set resolves through that pack, then through `externalBase`, carrying the ids being resolved so that a cycle across packs fails with `PackError` instead of recursing. A copy that turns out corrupt (a broken header, a bad delta, a missing base) is passed over for another pack's copy, as git's `mark_bad_packed_object` does; its error is raised only when no other copy exists. Declared sizes over `maxObjectSize` (default 1 GiB), delta results over it, and sizes zlib could not produce from the entry's compressed bytes are refused before anything is allocated. Format and zlib errors raise `PackError`; storage errors come through unchanged. With `verify`, a mismatch raises `ObjectIdMismatchError` at the end of the content, as loose objects do.

`entry(id)` returns an object's entry as stored, for reuse when writing another pack: its kind (1 to 4, or 6 and 7 for deltas), the size in its header, the base id of a delta (an OFS_DELTA's base looked up through the idx), the CRC-32 from the idx, and `raw()`, the compressed bytes, which checks the CRC of the whole entry and throws `PackError` at the end when it does not match. An idx v1 has no CRCs: the entry is then read once to compute its CRC and check its zlib stream.

`openPack(files, packPath, idxPath, options)` opens a single pack with the same checks. Not supported: `multi-pack-index`, `.rev` and bitmap files (packs are read without them), SHA-256 repositories.

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
  └─ refs                             Refs: get/resolve/set/setSymbolic/batch/compareAndSwap/list
        │
GitObjects                             "<type> <size>\0<content>", SHA-1 over the whole thing, zlib
        │
StagingBlobStore                       bytes by id: rawStorageStaging(RawStorage), filesStagingStore()
        │
RawStorage                             bytes by key: MemoryRawStorage, CompressedRawStorage,
                                       ChunkedRawStorage, blobStoreToRawStorage(BlobStore), ...
```

Every typed store delegates to one `GitObjects` kernel, which adds the Git header, computes the id, compresses the object and reads the type back. Below it, a `StagingBlobStore` stores bytes under an id known only after the last byte, and `rawStorageStaging()` adapts any `RawStorage`, which stores bytes by key and knows nothing about Git. A new backend can stop at that level: `createHistoryFromComponents({ objects: createGitObjects(rawStorageStaging(rawStorage)), refs: { type: "memory" } })` gives a full `History` (pass any `Refs`, such as a store package's ref store, for persistent refs). `HistoryWithOperations` adds `delta` (deltify objects for storage), `serialization` (loose objects and packs) and `capabilities` (what the backend does natively), which GC and transport use.

### The object kernel

`createGitObjects(store)` is the object layer under the typed stores. An object is the bytes `"<type> <size>\0" + content`, named by their SHA-1 and stored as their zlib stream, exactly a git loose object; the kernel never parses commits or trees, so any bytes git produced keep their id.

```typescript
import { createGitObjects, MemoryRawStorage, rawStorageStaging } from "@statewalker/vcs-core";

const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
const bytes = new TextEncoder().encode("hello\n");
const id = await objects.put("blob", bytes.length, [bytes]); // "ce013625…", as git hash-object
const obj = await objects.get(id, { verify: true }); // { type: "blob", size: 6, content }
```

`put(type, size, content)` reads `content` once: each chunk is hashed and deflated as it passes, and the store receives the compressed bytes before anyone knows the id. That is what a `StagingBlobStore` is for: `putStaged(bytes, idOf)` stores bytes under the id `idOf()` returns after the last byte, as git writes `objects/tmp_obj_*` and renames it. `rawStorageStaging(raw)` adapts any `RawStorage` (it collects the compressed bytes first); `filesStagingStore` in `@statewalker/vcs-store-files` writes git's own layout, streaming where the FilesApi's `write` streams (the Node and in-memory ones collect the chunks first). A size that does not match the content rejects with `SizeMismatchError` (exported here too) and stores nothing. Ids are SHA-1; SHA-256 repositories are not supported.

`putRaw(id, raw)` stores an object received with its id, refusing it (`ObjectIdMismatchError`, `CorruptObjectError`) unless the header is valid and the bytes hash to that id. Reading checks as git does: a truncated zlib stream, bytes after it, a bad header or a body of the wrong size raise `CorruptObjectError`, and `get(id, { verify: true })` re-hashes the content. A string that is not an id is simply absent for `has`, `get` and `getRaw`; `putRaw` and `remove` refuse it with `InvalidObjectIdError`.

### Why everything streams

Blob content is `AsyncIterable<Uint8Array>` on the way in and out, and trees load as async iterables of entries. A large file passes through with bounded memory when its size is known: `blobs.store(content, size)` hashes and stores in one pass, while `blobs.store(content)` collects the content first to learn the size. That matters in browsers. `VcsCore` collects trees into arrays because trees are small and arrays are easier to use.

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
