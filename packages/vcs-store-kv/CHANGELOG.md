# @statewalker/vcs-store-kv

## 0.5.0

### Minor Changes

- 875db86: **Clone and fetch leave what git leaves: remote and upstream configuration, `refs/remotes/<name>/HEAD`, `FETCH_HEAD`; shallow clones on the KV store. Breaking: `CloneCommand.setBranch` no longer implies `--single-branch`.**
  
  - **vcs-commands, `CloneCommand`:** writes the configuration `git clone` writes: `remote.<name>.url`, `remote.<name>.tagOpt = --no-tags` for `setNoTags()` and for a mirror (as git 2.49+, whose `--mirror` implies `--no-tags`), the `remote.<name>.fetch` refspec of the clone (`+refs/heads/*:refs/remotes/<name>/*`; one branch or tag for a single-branch clone; none for a bare clone; `+refs/*:refs/*` with `remote.<name>.mirror = true` for a mirror), and `branch.<b>.remote` / `branch.<b>.merge` for the checked-out branch (an empty remote's unborn branch included). `refs/remotes/<name>/HEAD` becomes a symbolic ref to the tracking ref of the remote's default branch when the clone took it. `setRemote(name)` (`--origin`) names the remote in all of it. The configuration is saved through the working copy's config (`.git/config` for the files backend), and native git reads it: `git status` shows the upstream and `git pull` works in our clone.
  - **vcs-commands, breaking:** `CloneCommand.setBranch(b)` is git's `--branch`: every branch is still cloned and `b` (or a tag `b`, checked out detached) is set up. New `setSingleBranch(true)` (`--single-branch`) restricts the clone to it, as before; a shallow clone and `setBranchesToClone` (with `setCloneAllBranches(false)`) stay single-branch unless `setSingleBranch(false)`.
  - **vcs-commands, `FetchCommand`:** writes `FETCH_HEAD` in git's format through the checkout (`<oid>\t[not-for-merge]\t<description>`, `branch 'main' of <url>`, `tag 'v1' of <url>`, the URL without credentials or `.git`), the refs to merge first: every ref of explicit refspecs, or with configured refspecs the current branch's `branch.<b>.merge` refs (fetched for this alone when no refspec takes them), or, when the current branch has no upstream at all, the first ref of an exact first refspec; a ref named twice without destination is listed twice; tags (auto-followed ones by name) and the rest are `not-for-merge`. Byte-identical to native `git fetch` for the same fetch. New `setAppend(true)` (`--append`) and `setWriteFetchHead(false)` (`--no-write-fetch-head`); FETCH_HEAD is truncated when the fetch starts (a failed fetch leaves it empty); a dry run writes nothing. Without `setTagOpt`, a configured remote's `remote.<name>.tagOpt` decides; a configured remote without `fetch` lines fetches the current branch's merge refs when it is that branch's upstream, else its HEAD only, as git (the default refspec is no longer filled in).
  - **vcs-commands:** new `git.remoteSetHead()` (`RemoteSetHeadCommand`, `git remote set-head <name> <branch>` / `-d`). `fetch --prune` keeps `refs/remotes/<name>/HEAD` (a symbolic ref), as git.
  - **vcs-transport:** `FetchClientResult.fetched` lists every remote ref a fetch took, with or without a local ref, in git's FETCH_HEAD order (refspec matches, then auto-followed tags: those of fetched or present objects first, then those found in the fetched history), each with the index of the refspec that selected it (`PlannedRef.refspec`). New `formatFetchHead`, `parseFetchHead`, `fetchHeadUrl` and `anonymizeUrl` (git's transport_anonymize_url).
  - **vcs-working-tree:** `Checkout` has optional `readFetchHead()` / `writeFetchHead(content, { append })`; `MemoryCheckout` keeps it in memory.
  - **vcs-store-files:** `GitCheckout` reads and writes `.git/FETCH_HEAD`.
  - **vcs-store-kv:** `KVRefStore.getShallow()` / `setShallow(commits, expected)`, with the `expected` check of the other stores (one compare-and-swap of a `shallow:root` key), so shallow fetches and clones work on the KV store.
- 01d2219: **Every ref and reflog write goes through git's locks; the unlocked writers are gone (breaking).** `vcs-store-files` no longer exports `writeRef`, `writeObjectRef`, `writeSymbolicRef`, `deleteRef`, `updateRef` (`refs/ref-writer.ts`) or `appendReflog`, `deleteReflog` (`refs/reflog-writer.ts`, removed; `hasReflog` moved to `reflog-reader.ts`). They wrote loose refs and reflogs with plain writes. Use `FileRefStore` instead: `set`, `setSymbolic`, `remove`, `batch`, `compareAndSwap` and the new `deleteReflogEntry` all take `<ref>.lock` (and `packed-refs.lock` where git does), and a reflog line is appended while the ref's lock is held, as git does. A batch now also locks every symbolic ref that logs the update (not only HEAD), the updated ref first. As in git, a reflog line that cannot be written now fails the update before its commit (the ref keeps its value) instead of being skipped.
  
  **Stash as git keeps it.** `GitStashStore` (the files `WorkingCopy.stash`) writes `refs/stash` through the history's ref store: a push is a one-ref batch under `refs/stash.lock` that creates the reflog (git's REF_FORCE_CREATE_REFLOG) with the stash commit's message, a drop is `git reflog delete --rewrite --updateref refs/stash@{n}` under `refs/stash.lock` and `logs/refs/stash.lock`, and the last drop deletes the ref and its log. Messages follow git ("WIP on main: abc1234 subject", "On main: message", "index on main: …"), commit timestamps are seconds (they were milliseconds), and `list()` returns the reflog message. Native `git stash list` / `show` / `drop` work on our stashes and we read and drop git's. `GitStashStoreOptions` loses `files` and `gitDir` (and `StashFilesApi` is gone): the store needs only `history`. In `vcs-commands`, `stashCreate` logs every stash (a custom message becomes "On <branch>: <message>", a detached HEAD "(no branch)", as in git), `stashList` lists every `stash@{n}` from the reflog, `stashApply` resolves `stash@{n}`, and `stashDrop` drops any `stash@{n}` (stores without reflogs keep the old `stash@{0}`-only behaviour).
  
  **Pseudo refs and HEAD.** ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD are written and removed through the ref store (under `<name>.lock` on git files) by the merge, cherry-pick and revert state stores and by `GitCheckout`, which also reads them from its `refs`. `createGitFilesBackend({ create: true })` writes HEAD with `setSymbolic` (under `HEAD.lock`).
  
  **New core API.** `BatchOptions.createReflog` creates the updated refs' reflogs whatever their names. `Refs.deleteReflogEntry(name, index, { rewrite, updateRef })` (optional) deletes `name@{index}`; it is implemented by the memory, KV, SQL and git-files stores. `deleteReflogLine` and `ReflogEntryNotFoundError` are exported from `vcs-core`.

### Patch Changes

- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [875db86]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [01d2219]
- Updated dependencies [3818fee]
- Updated dependencies [3292f46]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [7d77bf8]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-working-tree@0.5.0
  - @statewalker/vcs-utils@0.5.0
  - @statewalker/vcs-core@0.5.0

## 0.4.0

### Minor Changes

- 6a3a31d: **Atomic ref batches in `KVRefStore` and `SQLRefStore`.** They now pass the full `createRefBatchTests` contract, including 20 concurrent two-ref batches.
  
  **`KVRefStore`:**
  - Every ref lives in one root value (`ref:root`, JSON in git's name order).
  - Every write, whole batches included, is one `compareAndSwap` of that value. A lost race re-reads and re-checks; after 100 lost races a batch reports `locked`, and `set` / `setSymbolic` / `remove` throw.
  - The decoded root is cached while its bytes are unchanged.
  - **Breaking:** the persisted layout changed. A store holding the earlier one-key-per-ref layout now throws a clear error instead of reading as empty.
  - **New:** `CorruptRefRootError`, thrown when the root is not a JSON object of strings. A corrupt root is never overwritten.
  
  **`SQLRefStore`:**
  - A batch is planned and written in one `DatabaseClient.transaction`.
  - `list(prefix)` now matches the prefix exactly: case-sensitive, with no `LIKE` wildcards.
  - `set` and batch writes clear a stale peeled id and mark the ref `loose`.
  
  **Both stores, `compareAndSwap`:** it is now a one-command batch, as in `MemoryRefs`, and atomic.
  - It follows symbolic refs: CAS on a symbolic `HEAD` writes its branch.
  - It refuses names other than `HEAD` and those under `refs/` (e.g. `ORIG_HEAD`), and directory/file conflicts.
  - On failure, `errorMessage` names the reason (`mismatch`, …).
  
  **Fixed (vcs-store-sql), `SqlJsAdapter`:**
  - **Concurrent transactions were merged.** A concurrent `transaction` ran inside the one in flight, so a rollback of either undid both. Transactions are now queued.
  - **Plain statements ran inside open transactions.** A `query` or `execute` issued while a transaction was open ran inside it: dirty reads, and writes undone by someone else's rollback. They now wait for the transaction to finish.
  - **Nesting:** a nested transaction joins only through the client handed to `fn`. The `DatabaseClient` docs now state these rules.
  - **Failing `BEGIN`:** a `BEGIN` that fails no longer rolls back a transaction it did not start.
  
  **`kvStoreRefs` (vcs-core)** keeps one key per ref, the layout shared with webrun-storage's `refStore` facade. It stays on the single-command batch, now documented.
- 33612d4: Ref batches write reflogs in every store, as git does with `core.logAllRefUpdates=true`: `MemoryRefs`, `KVRefStore` (`reflog:<name>` keys) and `SQLRefStore` (table `vcs_reflog`, migration 5) now keep them like `FileRefStore`, and expose `getReflog`. New in vcs-core: `planReflog` and `createReflogReaderOf`. The shared ref-batch suite gains reflog cases (`{ reflog: true }`).
  
  `KVRefStore` adds a `:seq` entry (the root's write count) to `ref:root`, so its reflog lines keep commit order. Roots written before it are read as `:seq` 0 and keep working.
- 6964023: **New (vcs-core):** `Refs.batch(commands, options?)` applies ref updates atomically: all of them or none. It follows `git update-ref --stdin`'s rules:
  - names must be `HEAD` or valid names under `refs/`;
  - no duplicates;
  - no directory/file conflicts;
  - each `old` must match (`undefined` means no check, `null` means the ref must not exist);
  - commands follow symbolic refs unless `noDeref` is set. With `noDeref`, `old` is still compared with the resolved value, as git does.
  
  It returns `{ ok, rejected: [{ name, reason }] }`.
  
  Two rules are project policy rather than git's:
  - a detached HEAD cannot join a multi-ref batch (`not-atomic`);
  - symbolic-ref chains are followed for at most 5 refs.
  
  A symbolic ref pointing outside `refs/` is refused as `invalid-name`.
  
  **Also new:**
  - `planRefBatch`, the backend-independent planner, with its view and result types `RefBatchView`, `PlannedRefUpdate` and `RefBatchPlan`. A planned update carries the raw value it read and the refs whose reflogs also record it (HEAD included, as git logs it).
  - `isUpdatableRefName`, plus the types `RefCommand`, `RefRejectReason`, `RefRejection`, `BatchResult` and `BatchOptions`.
  
  **Breaking:**
  - `batch` is required on every `Refs` implementation.
  - `MemoryRefStore` is removed. It duplicated `MemoryRefs`; use `MemoryRefs` (vcs-store-mem re-exports it).
  - `MemoryRefs.compareAndSwap` is now a one-command batch:
    - it refuses names outside `HEAD` / `refs/` (e.g. `ORIG_HEAD`), D/F conflicts, and symbolic-ref chains longer than 5;
    - on a symbolic `HEAD` it updates the target instead of detaching HEAD;
    - on failure, `errorMessage` names the reason.
  - `MemoryRefs.set`, `setSymbolic` and `remove` apply in order with batches, under one write lock: await them before reading.
  - `MemoryRefs.list` snapshots the refs when iteration starts.
  
  **Interim (deprecated, will be removed):** `batchBySingleRef` / `SingleRefWriter`. The SQL, KV and git-files stores run one command through `compareAndSwap`, so a batch is only as atomic as that is. They refuse multi-command batches, and `noDeref` on a symbolic ref, as `unsupported` until their atomic batches land.
  
  **Fixed (vcs-store-files):**
  - `compareAndSwap` now works on refs that exist only in packed-refs, and writes through a symbolic ref to its target.
  - `delete` removes a ref from packed-refs too.
  
  **New (vcs-testing):** `createRefBatchTests(name, factory, { multiRef?, symbolicRefs? })`, the batch contract suite.
- 5684650: **Breaking: every store uses git's SHA-1 object ids; the FNV-1a ids are gone.**
  
  Removed: `computeCommitHash`, `computeTreeHash` and `computeTagHash` (vcs-core), `MemoryCommitStore` / `MemoryTreeStore` / `MemoryTagStore` (vcs-store-mem), `KVCommitStore` / `KVTreeStore` / `KVTagStore` with their scan queries (vcs-store-kv), and `SQLCommitStore` / `SQLTreeStore` / `SQLTagStore` (vcs-store-sql). Use `createMemoryObjectStores()`, `createKvObjectStores({ kv })`, and `createSqlNativeStores(db)` or `createSqlObjectStores({ db })`.
  
  `SQLHistoryFactory` (`createHistory("sql", …)`) now wires the native SQL stores, so its trees, commits and tags get git ids. Persisted ids change: databases it wrote before hold FNV ids in `tree`, `tree_entry`, `vcs_commit`, `commit_parent`, `vcs_tag`, `vcs_ref`, `vcs_reflog`, `tree_delta` and `tree_delta_entry`, and KV stores in `commit:`, `tree:` and `tag:` keys. There is no migration; re-import from a git remote.
  
  The shared tree, commit and tag suites check ids against ones git computes.
- 0a580e3: **Breaking: no store holds a whole large object in memory.** A git id hashes `"blob <size>\0"` first, so every write now either knows the size and streams once, or spools to temporary storage.
  
  - **vcs-core:** `GitObjects.putUnsized(type, content)` (new, required for `GitObjects` implementations) keeps content up to `spoolThreshold` (`createGitObjects(store, { spoolThreshold })`, 1 MiB by default) in memory and spools longer content through the optional `StagingBlobStore.spool(content)` (`SpooledContent`) before `put`; `blobs.store` without a size and the tree, commit and tag stores use it. `RawStorage.move?(from, to)` is new and optional; `rawStorageStaging` streams into a `tmp_obj_*` key and renames it when the raw store has `move` (`MemoryRawStorage` does), and spools to such a key. `VcsCore.writeBlob(bytes, { size })` and `SerializationApi.importObject(type, content, size?)` take sizes; `TypedStoreAccess.importObject` now receives the size. Content up to `STAGING_INLINE_THRESHOLD` (256 KiB, `rawStorageStaging(raw, { inlineThreshold })`) skips the temporary: `has` + `store`, nothing written for a duplicate; an id already stored keeps its value. `CompressedRawStorage.size()` streams and counts; with the new `{ gitObjects: true }` option it reads only a git object's header. `RawStorage.sweepStale?`, `StagingBlobStore.sweepStale?`, `GitObjects.sweepStale?` and `GcStrategy.sweepStale?` remove leftovers of interrupted writes; `GcOrchestrator.run({ staleExpiryMs })` (default `DEFAULT_STALE_EXPIRY_MS`, two weeks) calls them and reports `removedTemporaries`. New: `fixedSizeChunks`, `RAW_STAGING_TMP_PREFIX`, `DEFAULT_SPOOL_THRESHOLD`, `sweepStaleRawStaging`.
  - **vcs-store-kv / vcs-store-sql:** `KvRawStore` and `SqlRawStore` cut values over 256 KiB (`{ chunkSize }`) into chunks written as they stream in and read one at a time, and implement `move`. Values written in the old single-entry / single-row format keep reading. SQL migration 6 (`raw_store_chunks`) upgrades existing `raw_objects` / `raw_store` tables; `SqlRawStore` upgrades any table on first use (`upgradeRawStoreTable`). `Migration.upgrade` runs programmatic steps. `SqlNativeBlobStoreImpl.store` streams: with a size it hashes while writing chunks, without one it writes chunks first and reads them back to hash. `importToNative` / `exportToGit` pass blob sizes. `KvRawStore.sweepStale`, `SqlRawStore.sweepStale` and `SqlNativeBlobStoreImpl.sweepStale` remove orphaned chunks and `tmp:*` placeholder rows (chunk tokens record their creation time); `SqlGcStrategy.sweepStale` calls the native one. Raw-store overwrites are last writer wins; a reader concurrent with an overwrite may fail with `Missing chunk`. Rolling back migration 6 deletes rows of chunked values (data loss; `Migration.downgrade`).
  - **vcs-store-files:** `filesStagingStore` spools to `tmp_obj_*` files. The stash stores worktree files with their sizes.
  - **vcs-working-tree:** `storeWorktreeFile` moved here from vcs-commands (still re-exported there); after a `SizeMismatchError` it re-stats the file and retries once with the new size. It now returns `{ id, entry }`, the stat that matched the stored content, which the add commands record in the index.
  - **vcs-testing:** `createRawStorageTests` covers chunked values, failed writes, `move` (`supportsMove`) and streaming writes (`persistedBytes`); `createGitObjectsTests` covers `putUnsized` and, with `persistedBytes`, a 50 MiB blob written and read back with the producer never more than a few MiB ahead of the store.
  - **vcs-utils:** `randomHexId`, `timestampedId` and `timestampOfId` build ids from `crypto.getRandomValues`; no package source uses `crypto.randomUUID` any more (missing on non-secure browser origins).
- 60dd7da: **Breaking: every store reads and writes objects through the object kernel (`GitObjects`).**
  
  Removed: `GitObjectStore`, `GitObjectStoreOptions`, `createGitObjectStore`, `GitObjectHeader`, `loadWithHeader`, `VolatileStore`, `VolatileContent`, `MemoryVolatileStore` (vcs-core); `FileVolatileStore` / `createFileVolatileStore` (vcs-store-files); `createGitObjectStoreTests` and `createVolatileStoreTests` (vcs-testing). Replace `createGitObjectStore(raw)` with `createGitObjects(rawStorageStaging(raw))`, and for a `.git/objects` directory use `createGitObjects(filesStagingStore(files, objectsDir))`.
  
  - `createBlobs`, `createTrees`, `createCommits`, `createTags` and `createHistoryFromComponents({ objects })` take a `GitObjects`; `createMemoryObjectStores`, `createKvObjectStores` and `createSqlObjectStores` return one as `objects`.
  - `Blobs.store(content, size?)`: with a size, the blob is written in one pass without being buffered.
  - `createGitFilesBackend` builds its objects as `withPacks(createGitObjects(skipPacked(filesStagingStore(...), packs)), packs)`: reads try loose objects, then packs, and an object already packed is not written again (as git and JGit). gc and repack ignore anything in `objects/` that is not an object file, such as git's `objects/ab/tmp_obj_*` in flight.
  - The typed stores' `remove` still returns false for a string that is not an object id; `GitObjects.remove` throws `InvalidObjectIdError` for one.
  - Stored bytes: the memory, KV and SQL object stores (and the `BlobStore` behind `createVcsCore` and `createStorageRepositoryFacade`) now hold zlib loose objects, as `.git/objects` does. Data those stores persisted before is not readable; re-import from a git remote.

### Patch Changes

- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [44b3105]
- Updated dependencies [e509d97]
- Updated dependencies [658066d]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [f440ae3]
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [8c6e99c]
- Updated dependencies [060fcd0]
- Updated dependencies [6a3a31d]
- Updated dependencies [33612d4]
- Updated dependencies [6964023]
- Updated dependencies [6343211]
- Updated dependencies [5684650]
- Updated dependencies [bb70139]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [60dd7da]
- Updated dependencies [c767140]
- Updated dependencies [46f2a01]
- Updated dependencies [b758bc0]
  - @statewalker/vcs-utils@0.4.0
  - @statewalker/vcs-core@0.4.0
  - @statewalker/vcs-working-tree@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core ^0.3.1 -> ^0.3.2
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-utils@0.3.2
  - @statewalker/vcs-working-tree@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/vcs-utils@0.1.1
  - @statewalker/vcs-working-tree@0.1.1
