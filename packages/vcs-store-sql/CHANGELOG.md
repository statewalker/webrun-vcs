# @statewalker/vcs-store-sql

## 0.4.0

### Minor Changes

- 658066d: **Breaking: one fetch client, as git's fetch-pack and remote-curl.**
  
  The transport had three fetch paths (HTTP `fetch`, `httpFetch`, `fetchV2OverDuplex`, plus the v1 client FSM behind `fetchOverDuplex`); each sent every ref as a `have` and `done` in one round, and the v2 one walked only `localHead`. They are now one client (`fetch-client/`) with two I/O adapters:
  
  - **`fetch(options)`** (smart HTTP) asks for protocol v2 (`Git-Protocol: version=2`, `ls-refs` with `ref-prefix`/`symrefs`/`peel`/`unborn`, stateless `fetch` rounds) and falls back to v0 when the server answers the v0 advertisement (`protocolVersion: 0` forces v0). It now writes into a repository: `repository` (`importPack`, streamed) and `refStore` are required, and it returns a `FetchClientResult` (`protocolVersion`, `remoteRefs`, `defaultBranch`, `isEmpty`, `refUpdates`, `followedTags`, `shallow`, `imports`, `packObjects`, `packBytes`, `stats`). `onPack`, `packData`, `localHas`, `localCommits`, `onProgressMessage` and `bytesReceived` are gone (`onProgress` receives the server's messages).
  - **`fetchOverDuplex(options)`** runs the same client over a stateful duplex and speaks v2 or v0 as the server's first line says; it returns `FetchResult` with `report` (the `FetchClientResult`). A fetch with nothing to fetch ends the v0 session with a flush (git's fetch-pack), and a v2 session always ends with one, so the server is done before the caller reuses the channel. `localHead`, `maxHaves` and `filter`-only FSM options are gone; `messagePortFetch` takes the same options.
  - **Negotiation** is git's default negotiator (`Negotiator`): local ref tips walked by commit date, haves in batches of 16 then doubling (stateful v0: +32 past 32; stateless: ×1.1 past 16384), acknowledged commits and their ancestors common and never offered, remote tips already here offered once, `done` when exhausted or `ready` or after 256 haves without a new common commit (`MAX_IN_VAIN`), common commits re-sent in every stateless request. An incremental fetch downloads only the new objects.
  - **Shallow:** the shallow file is kept through new optional `RefStore.getShallow`/`setShallow` (and `Refs.getShallow`/`setShallow` in vcs-core: `MemoryRefs`, `FileRefStore` writes git's `shallow` file under `shallow.lock`, `SQLRefStore` a new `vcs_shallow` table, migration 7). Options `depth`, `deepenRelative`, `deepenSince`, `deepenNot`, `unshallow`.
  - **Tags:** `tags: "auto" | "all" | "none"`. `auto` sends `include-tag` and creates the tags whose objects are here; annotated tags of fetched objects whose tag objects did not come are fetched in a second request (git's backfill).
  - **Refs:** per-ref fast-forward checks; a non-fast-forward is `rejected` unless the refspec has `+` or `force` is set; tags never move unless forced; each ref in its own `refStore.batch` with its old value checked (`atomic`: one batch). Statuses and git's summaries (`[new branch]`, `a..b`, `+ a...b`, `[rejected]`) in `refUpdates`. Negative refspecs exclude refs now.
  - **Removed:** `httpFetch`/`HttpFetchOptions`, `fetchV2OverDuplex`/`FetchV2OverDuplexOptions`, `clone`/`CloneOptions`/`CloneResult` (a clone is a fetch into an empty repository), `RawFetchResult`, `HttpFetchResult`, `BaseFetchOptions`, and the client FSMs `clientFetchTransitions`/`clientFetchHandlers`, `clientV2Transitions`/`clientV2Handlers`.
  - **New exports:** `openHttpConnection`, `openDuplexConnection`, `UploadPackConnection`, `RemoteRef`, `fetchFromConnection`, `FetchClientOptions`, `FetchClientResult`, `fetchPack`, `Negotiator`, `lsRefs`, `mapRefs`, `refPrefixes`, `planRefUpdates`, `applyRefUpdates`, `isFastForward`, `FetchRefUpdate`, `PktStream`, `readSidebandPack`, `nextFlush` and git's flush constants, `ChunkQueue`, `peelFully`.
  - **Server:** the v0 advertisement (HTTP and duplex) lists the peeled line (`<oid> <tag>^{}`) of each annotated tag, as git's, so clients can follow tags. `createRepositoryFacade({ history })` accepts a plain `History` (a `DefaultSerializationApi` over it when it has none).
  
  **vcs-commands:** `FetchCommand` and `CloneCommand` run on the client: haves from the local refs, `setDepth`/`setShallowSince`/`addShallowExclude`/`setUnshallow` reach the server and the shallow file, `setTagOpt` is honoured, `setForceUpdate` and `+` refspecs allow non-fast-forwards (others are `REJECTED`, `LOCK_FAILURE` for a ref-store refusal), `--prune` deletes the refspec destinations whose source is gone. `TrackingRefUpdate` gains `summary` and `reason`. A fetch without refspecs fetches the remote HEAD (objects only), as git. `CloneCommand` writes `refs/remotes/<remote>/*` (bare: `refs/heads/*`, mirror: `refs/*`), all tags unless one branch is cloned (then tags follow), the local default branch and HEAD. The internal `importPackIntoHistory` is gone.
  
  **Review fixes:** wants and known-common tips are decided by completeness (reachable from the local refs, git's mark_complete), not object presence, so a fetch after an interrupted one transfers what is missing instead of writing a ref to a broken history (`Completeness`). Tags follow only when a refspec has a destination (git's autotags). A refspec source the remote lacks fails with `couldn't find remote ref <src>` (`missingRefsOk` for configured refspecs; `FetchCommand` passes it for `remote.<name>.fetch`). `refspecs` may be a `RefspecResolver`. v2 resets the in-vain count on every ACK, as git. `isFastForward` is exact under clock skew. `setShallow(commits, expected)` refuses when the shallow commits changed meanwhile (all three stores). `tagsNotFollowed` reports tags a stateful v0 fetch could not backfill. vcs-commands: `--prune` keeps refs a negative refspec excludes; `CloneCommand.setBranch` of a missing branch fails (`Remote branch X not found in upstream origin`) and of a tag checks out a detached HEAD; a shallow clone is single-branch (the remote HEAD's branch, tags following).
- 07ace72: **Breaking: one pack importer, byte for byte and streamed.**
  
  - **New in vcs-core:** `unpackObjects(objects, pack, options?)` is git's `unpack-objects`. It reads the stream once, writes every object as a loose object exactly as git frames it, resolves OFS and REF deltas (thin packs from the objects the store has), bounds memory (`baseCacheBytes`, `bigObjectThreshold`), refuses corrupt packs with `PackError` and an object stored under the same id with other bytes with the new `ObjectCollisionError`. `importPack(objects, pack, { packs, unpackLimit })` keeps a pack of at least `unpackLimit` objects (default 100, git's `transfer.unpackLimit`) through `packs.install` and unpacks smaller ones, deciding from the pack header only. Also new: `DEFAULT_UNPACK_LIMIT`, `UnpackTarget`, `UnpackObjectsOptions`, `UnpackResult`, `ImportPackOptions`, `ImportPackResult`, and `InstalledPack.types`.
  - **History:** `History.objects` (the object kernel) and `History.packs` (the files backend's `PackSet`), both optional; `createHistoryFromStores`, `createHistoryFromComponents`, `createGitFilesHistory` and `createGitFilesBackend` set them.
  - **Everything delegates:** `SerializationApi.importPack`, `VcsCore.readPack`, the commands' clone and fetch, and the transport's receive paths go through `importPack`, over the history's object kernel. Commits and tags keep headers the parsers do not model; `SerializationApi.importPack` used to drop them and store the object under another id. The server receive path (`createStorageRepositoryFacade` in vcs-transport-adapters, and the HTTP server demo) now passes its kernel as `objects`, so a pushed commit with a `mergetag` header is stored byte for byte. A history with typed stores only (the SQL native stores) is written through them: an object they would re-encode is refused with `ObjectIdMismatchError` before anything is stored. `PackImportResult.blobsWithDelta` is always 0 and `packId` names a kept pack.
  - **Removed:** `SerializationApi.parseLooseObject` (inflate and `objects.putRaw` instead), `SerializationApi.createPackReader`, `PackReaderApi`, `PackEntry`, `PackHeader`, `ParsedObjectMeta`, `SerializationApiConfig.blobDeltaApi`/`treeDeltaApi`/`commitDeltaApi`, `parsePackEntries`, `parsePackEntriesStream`, `parsePackEntriesFromStream`, `indexPackFromStream`; in vcs-utils `PackObjectCache` and `MemoryPackObjectCache`; in vcs-transport `BufferWriter` and `createHttpClientDuplex`.
  - **Streaming fetch (vcs-transport):** `fetch` and `clone` take `onPack(pack)`, which receives the pack demultiplexed from the response body as it arrives (`packData` is then empty). The new `sidebandPackStream(body, { onProgress })` is that demultiplexer (an `ERR` line or channel 3 throws `ServerError`); `httpFetch` and the fetch state machine stream the pack into `importPack` the same way instead of collecting it. A fetch that sent wants and received no pack now fails instead of reporting success, so no refs are written to missing objects; a failed import cancels the response body (`readableStreamToAsyncIterable` cancels a stream it stops reading early). `fetch`'s `timeout` now bounds each wait for the server rather than the whole fetch, so a slow store does not abort a large clone.
  - **vcs-commands:** `importPackIntoHistory` takes a stream; clone and fetch import the pack while it downloads.
- 8c6e99c: **Breaking: receive-pack quarantines a pushed pack until the push is accepted (git's `tmp_objdir`).**
  
  A refused push (unpack error, missing objects, authorize, pre-receive or update refusal of every ref, an atomic push with a refused ref, an internal error, a client gone mid-pack) now leaves no object in the store; an accepted push publishes its objects before the refs move.
  
  - **vcs-core:**
    - `GitObjects.beginQuarantine?()` returns an `ObjectQuarantine` `{ objects, packs?, commit(), discard() }`: writes through `objects` stay invisible to the store until `commit()`, reads see the quarantine then the store, `discard()` removes everything. `createGitObjects` provides it when its `StagingBlobStore` has the new optional `beginQuarantine()` (`StagingQuarantine`).
    - `rawStorageStaging` quarantines under `incoming-<timestampedId>/` keys of the same raw store (memory, KV, SQL) and publishes with `RawStorage.moveAll` (new, optional, all or none) or `move`. `sweepStaleRawStaging` (gc) removes quarantines left by a crash. New export `RAW_QUARANTINE_PREFIX`.
    - `overlayObjects(top, base)`: the quarantine's view.
    - `importPack(objects, pack, { quarantine: true })` imports into a quarantine when `objects` can open one and returns it as `result.quarantine` (a failed import discards it); `SerializationApi.importPack(pack, { quarantine })` and `PackImportResult.quarantine` likewise. Stores without `beginQuarantine` (the SQL native stores) import directly and return no quarantine.
  - **vcs-store-files:** `createGitFilesBackend`'s objects quarantine in `objects/tmp_objdir-incoming-<id>/` (loose objects, kept packs in `pack/`); `commit` moves loose objects, then pack files (`.keep`, `.pack`, `.rev`, `.idx` last) and rescans the packs. `gc` removes stale quarantine directories (`GcResult.removedQuarantines`, new). New exports `beginFilesQuarantine`, `sweepQuarantines`, `QUARANTINE_DIR_PREFIX`.
  - **vcs-store-sql:** `SqlRawStore.moveAll` publishes a quarantine in one transaction.
  - **vcs-transport:**
    - `RepositoryFacade.importPack(stream, { quarantine })` returns `PackImportResult.quarantine: RepositoryQuarantine` `{ repository, commit(), discard() }`; transport's `PackImportResult` is now its own type (the core one without the core quarantine). New `repositoryQuarantine(quarantine, history)`.
    - receive-pack imports with `quarantine: true`, runs connectivity, git's `update()` checks and the hooks against the quarantine's view, commits before applying ref updates and discards otherwise. Hooks get `ctx.repository` (the push's view of the repository). Drivers call the new `releaseReceivePack(ctx)` once the FSM stops (done by `serveOverDuplex` and the HTTP handler).
  - **vcs-transport-adapters:** `VcsRepositoryFacade.importPack` passes the quarantine through.
  - **Freshening:** an object a push sends that the repository already has is written again through the store (`putRaw`), so an old loose object or pack is renewed as git's freshen does (a concurrent gc does not prune what the new ref names); the files quarantine's commit replaces a stale existing loose object or pack file by its quarantined copy.
  - **Abandoned quarantines:** an open quarantine unused for `QUARANTINE_MAX_IDLE_MS` (one hour, new export) or the sweep's expiry, if longer, is swept like a crash leftover.
  - **Bounded runs:** `writeTimeoutMs` (default `DEFAULT_RECEIVE_PACK_WRITE_TIMEOUT_MS`, 10 min) for `serveOverDuplex` receive-pack and the HTTP receive-pack: a client that stops reading ends the run (no ref is updated once a side-band write failed); `hookTimeoutMs` refuses the commands of a hook that does not answer (`HookTimeoutError`). New `withWriteTimeout` / `WriteTimeoutError`.
  - **No silent fallback:** `PackImportResult.quarantined` says whether a `quarantine: true` import was quarantined; receive-pack warns once per facade (`ReceivePackLogger.warn`, new, optional) when it cannot quarantine.
  - `MemoryGcStrategy.getStats` counts objects only (not temporaries or quarantines); the quarantine view of `createRepositoryFacade` keeps its `isBare`; the files quarantine refuses writes once closed.
  - **vcs-testing:** `createObjectQuarantineTests` and `rawQuarantineHelpers`.
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

- c60d922: **Breaking (vcs-utils):** incremental SHA-1 goes through one `Hasher` interface (`update` / `digest` / `clone`) from `createSha1()`, on `@noble/hashes`. The vendored `Sha1` class, `newSha1` and `sha1Sync` are removed.
  
  Migration: `new Sha1().update(data).finalize()` becomes `createSha1().update(data).digest()`, and `sha1Sync(data)` becomes `createSha1().update(data).digest()`. Unlike `finalize()`, `digest()` can be read only once: the hasher is spent after it, so `clone()` first to keep the state.
  
  New: `computeObjectIdFromStream(type, size, chunks)` hashes a git object in one pass from a declared size, and rejects with `SizeMismatchError` on a short or long stream. `computeObjectId` hashes objects of 64 KiB and more with Web Crypto, and smaller ones with the portable hasher. vcs-core and vcs-store-sql now hash through `createSha1`.
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
