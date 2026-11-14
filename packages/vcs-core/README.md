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
| `@statewalker/vcs-core/backend` | Backend registry (`createHistory`, `registerHistoryBackendFactory`), `BackendCapabilities`, `StorageOperations`, pack files (`openPackSet`, `listObjects`, `writePack`, `readPackIndex`, `installPack`, `importPack`, `unpackObjects`, ...) |
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

### Sending a pack

```typescript
import { type ListedObject, listObjects, writePack } from "@statewalker/vcs-core";

// what the receiver lacks: reachable from our tip, not from theirs
const listed: ListedObject[] = [];
for await (const o of listObjects(objects, { wants: [localTip], haves: [remoteTip] })) {
  listed.push(o);
}

// a v2 pack, streamed: copied from our packs where it can, deltas searched
for await (const chunk of writePack(objects, listed, { packs, deltaSearch: true })) {
  await send(chunk);
}

// the same through a history: serialization.exportPack(wants, haves)
const pack = history.serialization.exportPack([localTip], [remoteTip]);
```

This is git's `rev-list --objects` piped into `pack-objects`. Pushes (`push`, `httpPush`, the `PushCommand`) and the upload-pack server (`RepositoryFacade.exportPack`) send their packs this way, and so does `SerializationApi.createPack(ids)` for a list of ids it is given.

`listObjects(objects, { wants, haves, shallow })` walks commits newest first by committer time. A commit reached from a have is uninteresting, and so are its ancestors; the walk stops once only uninteresting commits are queued, plus five more (git's SLOP) to absorb clock skew, and a commit found uninteresting after it was listed is dropped before anything is yielded. The trees of the uninteresting commits met on the way, and of the uninteresting parents of listed commits, are then marked with everything below them, so a blob the receiver has through another path is not sent again. Commits come out first, then wanted tags (annotated tags are peeled, and a have may be a tag), then the trees and blobs of each listed commit with their paths. `excludes` is another name for `haves`; unknown haves are ignored and a missing want throws `MissingObjectError`. `shallow` lists the receiver's shallow commits, whose parents are walked neither to list nor to exclude; deepening (`deepen`, `deepen-since`) is not done here. `onBoundary` reports each tree and blob under the boundary with its path: the bases of a thin pack. Memory grows with the number of objects, not their size: a map of flags per visited id, the parents of walked commits, the `listed` array of listed commit ids, the boundary arrays (`boundaryTrees`, and with `onBoundary` the set of reported boundary ids) and the pending trees, blobs and tags; objects are read one at a time and never held.

`writePack(objects, ids, options)` streams the 12-byte header, each entry and the SHA-1 trailer, hashed as it goes. The header carries the object count, so `ids` is an array (duplicates are dropped); an entry is either an id or `{ id, type, path }` as `listObjects` yields it. The options and their defaults:

- `packs` (none): where stored entries are reused, a `PackSet` or anything with `entry(id)`. With `reuseObjects` (true) a whole object is copied as stored, its compressed bytes untouched. With `reuseDeltas` (true) a delta is copied too when its base is written in the same pack, or is a have of a thin pack; a delta whose base is neither is written whole. Copies of the same objects in two packs that are deltas on each other are written whole once, to break the cycle.
- `ofsDelta` (true): a delta on a base in the pack is an OFS delta whose back-offset is computed for this pack (a reused REF delta becomes one); `false` writes REF deltas only, for receivers that did not ask for `ofs-delta`.
- `deltaSearch` (false; `true` or `{ window, depth, maxObjectSize, windowMemory, deltaCacheSize }`): git's windowed search. Candidates are sorted by type, git's name hash of their path, haves first and size, largest first; each is tried against the previous `window` (10) objects of its type with `encodeGitDelta`, within git's size limit, and keeps the smallest delta whose base is less than `depth` (50) deep. Only the window is held: objects over `maxObjectSize` (16 MiB) are not searched, the window drops its oldest objects past `windowMemory` (256 MiB), and computed deltas past `deltaCacheSize` (16 MiB) are computed again when they are written. Objects reused as deltas are neither targets nor bases. `depth` bounds reused chains too, as git's `break_delta_chains` does: a stored chain deeper than `depth` (50 also when the search is off) is broken by writing an object whole, and an object with reused deltas on it becomes a delta only if their chains stay within `depth`, so repeated export and repack cycles cannot grow chains toward the reader's limit.
- `bigFileThreshold` (50 MiB, git's `core.bigFileThreshold`): larger blobs are written whole and never searched; whole objects of any size stream from the store through zlib.
- `thin` (false) with `haves`: the search may pick a have as a base, and reused deltas on haves are kept; haves are never written. Only haves whose path name hash matches an object being written are searched, as git picks its preferred bases by name.
- `onEntry`: called after each entry with its id, offset, CRC-32, kind, base and whether it was reused, which is what an `.idx` needs.

A base is always written before its deltas, whatever the order of `ids`. A pack consumer that stops pulling stops the writer: memory stays at one chunk plus the delta window, which a test checks by streaming a lazily generated 60 MiB blob to a slow reader.

`DEFAULT_BIG_FILE_THRESHOLD` (from `@statewalker/vcs-core/history`) holds that default. `probeBlob(blobs, id, { bigFileThreshold })` answers what diff, merge and blame ask before they load a blob: its size (from `Blobs.size`, an object header) and whether it is binary. A blob over the threshold is binary and is not read at all; otherwise only its first 8000 bytes are read and checked for a NUL byte, as git does.

```typescript
import { probeBlob } from "@statewalker/vcs-core";

const { size, binary, big } = await probeBlob(history.blobs, id);
```

With `loadText: true`, the probe keeps reading a text blob to its end and returns it as `content`, so a caller that needs the text reads it once (one stream, and for a packed delta one delta resolution); a binary blob is still read only to its first 8000 bytes. `DiffFormatter` and `MergeCommand` use it.

```typescript
const { binary, content } = await probeBlob(history.blobs, id, { loadText: true });
if (!binary) diffText(content); // the whole blob
```

Tree entries are encoded from their ids with `objectIdToBytes(id)`, which accepts exactly 40 lowercase hex characters and throws `InvalidObjectIdError` for anything else (a short id, a non-hex character, uppercase). Before, a malformed id was silently written as zero bytes.

### Receiving a pack

```typescript
import { importPack, PackError, unpackObjects } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";

const { objects, packs } = await createGitFilesBackend({ files });

// `received` is the pack as it arrives, an AsyncIterable<Uint8Array> (a fetch response, a push)
const result = await importPack(objects, received, { packs });
// 100 objects or more: kept as a pack (result.kept), otherwise loose objects (result.unpacked)

// the memory, KV and SQL stores have no packs: everything is unpacked
const { count, written, existing } = await unpackObjects(memoryObjects, received);
```

This is what git does with a pack it receives. `importPack` reads the pack header, and only the header, to count the objects: with at least `unpackLimit` of them (default 100, git's `transfer.unpackLimit`) and a pack set to keep them in, the stream goes to `packs.install`, which is `installPack` with thin packs completed from `objects`. Any other pack goes to `unpackObjects`. An empty stream, as after a push that only deletes refs, imports nothing. `SerializationApi.importPack`, the transport's `RepositoryFacade.importPack`, `VcsCore.readPack` and the commands' clone and fetch all come here, over the history's `objects` and `packs`.

`unpackObjects` is `git unpack-objects`. It reads the stream once and never stores or collects it. Every whole object is written as a loose object through `putRaw`, framed exactly as git frames it, so a commit with a header the commit parser does not model keeps its id. Deltas are resolved as they arrive: an OFS_DELTA base is always an earlier entry, already written; a REF_DELTA base is an earlier entry, an object the store has (a thin pack, as every fetch receives), or a later entry, in which case the delta waits for it. Bases come from a byte-bounded cache of recent objects (`baseCacheBytes`, default 16 MiB) or are read back from the store. Whole objects over `bigObjectThreshold` (default 16 MiB) stream straight into the store through `put`, hashed on the way, and the id `put` returns must be that hash or the pack is refused with `ObjectIdMismatchError`; anything smaller is held while it is hashed. Memory is therefore the cache, one object or one delta with its base and result, 29 bytes of state per entry (up to about 58 allocated, since the arrays grow by doubling), and the deltas waiting for a base: REF_DELTAs whose base comes later in the pack, which `git pack-objects` never writes, and the deltas built on them. When such a base arrives, every delta waiting on it is resolved while it is held, so sibling deltas on one base are all in memory with it, as in git. A base streamed through `put` is not kept: OFS and waiting deltas against it read it back from the store, unless it fits the cache once read.

When an incoming object's id is already stored, the two are compared byte for byte, as git's `check_collision` does, and a mismatch is refused with `ObjectCollisionError` (a `PackError`). Objects streamed through `put` skip the comparison, as git's large blobs do; the store keeps the object it has, so one is never replaced. For the same reason `written` counts every streamed object, already stored or not, while `existing` counts only the smaller objects found already stored. A corrupt pack is refused with `PackError`: a bad signature or version, broken zlib, an entry that inflates past or short of its declared size, a bad delta, an object over `maxObjectSize`, a REF_DELTA base nobody has, a bad trailer, truncation, or bytes after the trailer. Objects are written before the trailer is read, as git does: each one is named by the hash of its own bytes, so a pack refused at its end leaves only sound objects behind.

A history without an object kernel (the SQL native stores, which keep parsed rows) is written through its typed stores. They re-encode what they store, so each object is first parsed and encoded again, and one whose bytes would change (a commit with a `mergetag` header, say) is refused with `ObjectIdMismatchError` before anything is stored. Wherever a kernel exists, pass it as `objects` to `createHistoryFromStores` (or `DefaultSerializationApi`) so received packs are written byte for byte; the transport's `createStorageRepositoryFacade` does.

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

Resolving deltas holds the delta chain being resolved, not the pack: entries are kept in typed arrays (about 80 bytes each), resolved bases are cached up to `baseCacheBytes` (default 32 MiB) and re-derived when evicted, and entries are re-read through one window of `windowBytes` (default 1 MiB) over the stored pack. Storing the incoming pack is up to the FilesApi: the Node and in-memory ones collect a file before writing it, so there the pack is held once while it is stored (set `maxPackSize` for untrusted sources). A storage failure (EIO and the like) comes through unchanged; only a malformed pack raises `PackError`. The pack is moved into place before its idx, and a leftover pack from a crash between the two is replaced by the next install of that pack (FilesApi `move` overwrites). An install interrupted by a crash leaves `tmp_*` files; `sweepPackTemporaries(files, packDir, olderThanMs)` removes those older than the threshold, as `git prune` does, and keeps younger ones that may belong to an install in progress.

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

`openPackSet` reads every `pack-<id>.idx` of a directory together with its `.pack`, the way git's object database does. Each idx is validated when it is opened: version (v2, and v1 for old repositories), monotonic fan-out, exact length including the 64-bit offset table, its own SHA-1, ids sorted and in their fan-out buckets, and the pack trailer must be the checksum the idx records. That last check is the one that catches an idx of another pack with the same object count. A pack that fails any of this is skipped and recorded in `skipped`, as git warns and skips; the rest of the set stays readable. A refused pack is opened again by a later scan only if its `.idx` or `.pack` changed size or mtime since the attempt (the signature is taken before the open), so a pack first seen while its idx was still being written in place is picked up once it is complete. A FilesApi that reports no `lastModified` gives a size-only signature: a corrupt file rewritten to the same size is not retried. A storage failure while opening one pack is recorded and retried by the next scan; the other packs of that scan are still added.

Lookups go through the fan-out table and a binary search. Whole objects stream straight out of the inflater, so a large blob is never held in memory. Deltas are walked down to a whole object (or a cached one) and patched upwards with the checked delta applier, through one byte-bounded base cache for the whole set (`baseCacheBytes`, default 16 MiB, git's `core.deltaBaseCacheLimit`). The cache keeps checkpoints spread along a chain rather than every step: on random reads of a 50-deep chain it halves the inflations, where caching every step lets the top of the last chain evict the rest. Callers always receive copies, never a cached buffer.

A miss in `has`, `get` or `entry` rescans the directory, and `list()` and `packs()` rescan on every call; all of these are limited to one rescan per `rescanIntervalMs` (default 1 s; the first one after open always runs), so a pack native git writes after open is found within that interval. `refresh()` rescans now, and starts a new scan when one already running began before the call. Concurrent opens of the same pack share one open. A scan does not add a pack that `remove()` is removing or removed after the scan started, whether the scan was already opening it or started while the files were being deleted. A REF_DELTA whose base is in another pack of the set resolves through that pack, then through `externalBase`, carrying the ids being resolved so that a cycle across packs fails with `PackError` instead of recursing. A copy that turns out corrupt is passed over for another pack's copy, as git's `mark_bad_packed_object` does; its error is raised only when no other copy exists. `get` reads the first chunk of the content before it returns, so a broken header, a bad delta, a missing base or a zlib stream broken from its start all fail `get` itself, where the next copy can still be chosen. A stream that breaks later fails while the caller reads it; the copy is then marked bad, so the next `get` skips it. Calling `return()` on the content, even before reading it, closes the pack read and releases the pooled inflater. A copy marked bad counts as absent for `has` and for `freshen(id)`, the check a writer makes before skipping an object that is already packed (git's `freshen_packed_object`): `freshen` also confirms the pack file still exists and drops the pack if it is gone. A pack it saw less than `rescanIntervalMs` ago (at most 1 s, even when rescans are turned off) is trusted without another check (git checks once per pack per process), so writes made in that window after the pack was deleted behind the set's back are skipped and not retried. `freshen` is also false when the pack file was last modified more than `freshenMaxAgeMs` ago (default one hour, git's freshen window), so the object is written loose again: git touches an old pack's mtime so that a concurrent gc does not expire the object with it; FilesApi cannot set mtimes, so a fresh loose copy takes that role. A pack whose mtime the FilesApi does not report is trusted. A skipped pack whose files disappear is dropped from `skipped` at the next scan. Declared sizes over `maxObjectSize` (default 1 GiB), delta results over it, and sizes zlib could not produce from the entry's compressed bytes are refused before anything is allocated. Format and zlib errors raise `PackError`; storage errors come through unchanged. With `verify`, a mismatch raises `ObjectIdMismatchError` at the end of the content, as loose objects do.

`entry(id)` returns an object's entry as stored, for reuse when writing another pack: its kind (1 to 4, or 6 and 7 for deltas), the size in its header, the base id of a delta (an OFS_DELTA's base looked up through the idx), the CRC-32 from the idx, and `raw()`, the compressed bytes. `raw()` reads the entry twice: it checks the CRC of the whole entry before it yields a byte (a mismatch throws `PackError` from the first `next()`, so a pack writer knows before it sends anything), then checks it again while streaming, in case the file changed in between. This doubles the I/O for large reused entries. An idx v1 has no CRCs: the entry is then read once to compute its CRC and check its zlib stream.

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

`createGitFilesHistory(config)` assembles a `HistoryWithOperations` from already-built Git-file stores (blobs, trees, commits, tags, refs and the `PackSet`; its `delta` is a read-only `PackSetDeltaApi` over the packs). The package that builds those stores from a `FilesApi` is `@statewalker/vcs-store-files` (`createGitFilesBackend({ files, gitDir })`).

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

`put(type, size, content)` reads `content` once: each chunk is hashed and deflated as it passes, and the store receives the compressed bytes before anyone knows the id. That is what a `StagingBlobStore` is for: `putStaged(bytes, idOf)` stores bytes under the id `idOf()` returns after the last byte, as git writes `objects/tmp_obj_*` and renames it. `rawStorageStaging(raw)` adapts any `RawStorage`: content up to 256 KiB (`STAGING_INLINE_THRESHOLD`, `{ inlineThreshold }`; nearly every tree, commit and small blob) is collected and stored under its id with one `has` and one `store`, and a duplicate writes nothing. Longer content streams into a temporary key and is renamed to the id when the raw store has `move` (the memory, KV and SQL raw stores all do); otherwise the compressed bytes are collected first. An id that is already stored keeps its value: objects are content addressed, so a second write never replaces the first; `filesStagingStore` in `@statewalker/vcs-store-files` writes git's own layout, streaming where the FilesApi's `write` streams (the Node and in-memory ones collect the chunks first). A size that does not match the content rejects with `SizeMismatchError` (exported here too) and stores nothing. Ids are SHA-1; SHA-256 repositories are not supported.

`putRaw(id, raw)` stores an object received with its id, refusing it (`ObjectIdMismatchError`, `CorruptObjectError`) unless the header is valid and the bytes hash to that id. Reading checks as git does: a truncated zlib stream, bytes after it, a bad header or a body of the wrong size raise `CorruptObjectError`, and `get(id, { verify: true })` re-hashes the content. A string that is not an id is simply absent for `has`, `get` and `getRaw`; `putRaw` and `remove` refuse it with `InvalidObjectIdError`.

### Content of unknown size is spooled

A git id hashes `"blob <size>\0"` before the content, so a write needs the size first. When the caller does not know it, the kernel reads the content twice:

```typescript
const objects = createGitObjects(rawStorageStaging(raw), { spoolThreshold: 1024 * 1024 });
const id = await objects.putUnsized("blob", download.body); // a stream of unknown length
```

`putUnsized(type, content)` keeps up to `spoolThreshold` bytes (1 MiB by default) in memory and puts them as usual. Longer content goes to the store's temporary storage, `StagingBlobStore.spool(content)`, which returns its size and a way to read it again; the kernel then `put`s it with that size and disposes the temporary. `rawStorageStaging` spools to a `tmp_obj_*` key of its raw store and `filesStagingStore` to a `tmp_obj_*` file next to the objects, so memory stays bounded wherever the store writes as it receives. A store without `spool` gets the content collected. `blobs.store(content)` without a size, `trees.store`, `commits.store` and `tags.store` all go through `putUnsized`.

### Why everything streams

Blob content is `AsyncIterable<Uint8Array>` on the way in and out, and trees load as async iterables of entries. A large file passes through with bounded memory when its size is known: `blobs.store(content, size)`, `vcs.writeBlob(bytes, { size })` and `serialization.importObject("blob", content, size)` hash and store in one pass. Without a size, the content is spooled (see above). That matters in browsers. `VcsCore` collects trees into arrays because trees are small and arrays are easier to use.

Two `RawStorage` details serve the same goal. `move(from, to)` is optional and renames a value without copying it; `rawStorageStaging` uses it to stream. `CompressedRawStorage.size(key)` returns the uncompressed size, inflating and counting the content as it streams (never collected); a truncated or corrupt stream gives -1. Constructed with `{ gitObjects: true }`, for a store that holds only git loose objects, it inflates just the start of the stream and adds the length of the header to the size the header declares, without checking the rest.

### Leftovers of interrupted writes are swept by gc

A process that dies mid-write leaves temporaries behind: `tmp_obj_*` keys of `rawStorageStaging`, and storage only the raw store knows about (the KV store's chunks with no manifest, the SQL store's chunk rows with no row). `GcOrchestrator.run()` removes those older than `staleExpiryMs` (two weeks by default, as `git gc` prunes `tmp_obj_*`) and reports `removedTemporaries`:

```typescript
const result = await new GcOrchestrator(history, strategy).run({ staleExpiryMs: 24 * 3600_000 });
result.removedTemporaries; // tmp_obj_* keys and orphaned chunks removed
```

It calls `history.objects.sweepStale({ olderThanMs })` (from `StagingBlobStore.sweepStale`, which calls the optional `RawStorage.sweepStale`) and the optional `GcStrategy.sweepStale(olderThanMs)`. Temporary keys and chunk tokens are `timestampedId`s (from `@statewalker/vcs-utils`), so a sweep judges their age from the name; one without a time, written by an older version, goes only with `staleExpiryMs: 0`. Writes running in this process are never swept. A write in another process that shares the store is protected only by its age, so keep the expiry longer than any write, and use 0 only when nothing else writes.

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
