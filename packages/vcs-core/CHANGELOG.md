# @statewalker/vcs-core

## 0.4.0

### Minor Changes

- 3b82e8b: **Breaking: big-file guards in diff, merge and blame; streamed index writes; smaller utilities that never read without limit.**
  
  - **vcs-core:** new `probeBlob(blobs, id, { bigFileThreshold })` returns `{ size, binary, big }`: the size from `Blobs.size`, and binary as git decides it (over the threshold, or a NUL byte in the first 8000 bytes), reading at most that prefix. `DEFAULT_BIG_FILE_THRESHOLD` (50 MiB, git's `core.bigFileThreshold`) moves from the pack writer to `history/blobs` and is still exported from the package root.
  - **vcs-commands:**
    - `DiffFormatter` takes a `bigFileThreshold` option. A side over it, or binary, makes the entry binary, and then neither side is loaded; `oldContent` and `newContent` are set for text files only. The binary line now reads as git's: `Binary files a/<path> and b/<path> differ`, with `/dev/null` for an added or deleted side.
    - `MergeCommand.setBigFileThreshold(n)`. A big or binary file is never content-merged: `ContentMergeStrategy.OURS` and `THEIRS` take that side's file whole (as `git merge -X ours`), `UNION` reports a conflict.
    - `BlameCommand.setBigFileThreshold(n)`. Blaming a file over it rejects; a parent version over it is not compared (its lines stay with the child commit) and is never a rename candidate.
  - **vcs-utils:**
    - `readHeader` and `readAhead` take a required `maxLength` (a positive integer; anything else throws `RangeError`), so a stream with no header end is never read without limit.
    - New `readPrefix(stream, maxBytes)` reads at most `maxBytes` and closes the source.
    - `RawText.isBinary` looks at the first 8000 bytes only (`RawText.BINARY_PROBE_LENGTH`), as git does.
    - `createPakoCompression()`'s `deflate` and `inflate` are push-based: each chunk goes through pako's `Deflate` / `Inflate` and the output is yielded as it comes. Before, they collected the whole input and produced one output buffer.
    - **Removed:** `IntermediateCache` (unused).
  - **vcs-working-tree:** new `encodeIndexFile(entries, version)` yields the index in chunks of about 64 KiB, the trailing SHA-1 computed as it goes, and validates paths before the first chunk. `GitStaging.write()` streams it into `FilesApi.write`. `serializeIndexFile` returns the same bytes joined.
  - **vcs-store-files:** the files staging store writes `.git/index` through `encodeIndexFile`.
  - **vcs-transport:** `pktLineReader` keeps received chunks in a queue and parses from the front, so many small packets, or a large packet in small chunks, decode in linear time (it re-copied its buffer on every packet). `parsePacket` returns `remaining` as a view of its input instead of a copy.
- 44b3105: **Breaking: one ref interface, `Refs`.**
  
  - **vcs-core removals:** the legacy `RefStore` interface, its `RefStoreLocation` alias (use `RefStorage`), `RefsAdapter` and `createRefsAdapter`.
  - **`createHistoryFromComponents`:** `refs` is now `{ type: "memory" }` or any `Refs` implementation, used as is. It replaces `{ type: "adapter", refStore }`. Anything else, including a stale `{ type: "adapter", … }` from untyped JavaScript, throws at runtime.
  - **vcs-store-files:** `FileRefStore` implements `Refs` directly. `delete(name)` is now `remove(name)`.
  - **vcs-commands:** `CheckoutCommandOptions.refs` is a `Refs`.
  - **Ref updates through `Refs`, on every backend:**
    - **Creates and updates** behave as before: one atomic command, `oldId` null meaning "must not exist".
    - **Deletes** are now one atomic command too. They remove the named ref itself (for a symbolic ref, not its target), check `oldId` when it is given, and return `false` for a missing ref.
    - **Names** outside `refs/` and `HEAD` are refused.
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
- bc7c6e2: **Breaking: the index is written through `index.lock` and keeps git's extensions; strict hex and object ids; `0002` is a `response-end` packet; linear pkt-line readers; text blobs read once.**
  
  - **vcs-working-tree:**
    - `GitStaging.write()` follows git's lock-file protocol: it creates `<index>.lock` (check-then-write: exclusive among writers sharing one FilesApi and against an existing lock file, not against a process racing the same instant), streams the index into it and renames it over the index. An existing lock fails the write with the new `IndexLockedError` (`Unable to create '.git/index.lock': File exists.`) and leaves both files alone; a failed write removes its lock. `createGitStaging(files, path, { lockTimeoutMs })` retries for a while instead of failing at once. New `writeIndexFile(files, path, entries, options)` does the same for direct writes. Once it holds the lock, `write()` checks that the index is still the one it last read (trailing checksum) and otherwise fails with the new `IndexChangedError` (`index changed on disk since it was read; re-read and retry`), removing the lock and leaving the index alone; `writeIndexFile` takes this check as `expectedChecksum` and returns the checksum it wrote. New `breakIndexLock(files, gitDir)` removes a lock left by a crashed writer (for OPFS and in-memory repositories). Known limitation: where `FilesApi.move` falls back to copy then delete (webrun-files-browser), a failed delete after the copy makes `write()` throw although the index was replaced.
    - Index extensions survive a rewrite (`carryIndexExtensions`): `TREE`, `UNTR` and `FSMN` are kept while the entries are unchanged and dropped otherwise; `REUC` (resolve-undo) is kept with every record, as git does (a corrupt one is dropped), and a full `readTree` clears it, as git's read-tree and reset do; `EOIE`, `IEOT` and unknown optional (uppercase) extensions are dropped, as git drops extensions it does not know. An index with a required (lowercase) extension we do not support, such as `link` (split index), is refused by `read()` and `write()` with `UnsupportedIndexExtensionError`. Before, every extension was dropped.
    - `ParsedIndex` gains `extensionData` (each extension's signature and payload); `encodeIndexFile` and `serializeIndexFile` take the extensions to write as a third argument. Entry paths of an index with a required extension are no longer validated by `parseIndexFile` (a split index has entries with empty paths).
    - `encodeIndexFile` throws `InvalidObjectIdError` for an entry whose object id is not exactly 40 lowercase hex characters, before writing anything.
  - **vcs-store-files:** `FileStagingStore` writes the index the same way (lock, changed-index check, extensions, resolve-undo cleared by `readTree`), and takes the same `{ lockTimeoutMs }` option.
  - **vcs-utils:** `hexToBytes` throws on odd length and on non-hex characters. Before, they became zero bytes.
  - **vcs-core:**
    - New `objectIdToBytes(id)`: the 20 bytes of an id, or `InvalidObjectIdError` unless it is exactly 40 lowercase hex characters. Tree encoding (`encodeTreeEntries`, `collectTreeBytes`, `serializeTree`) uses it, so a malformed entry id throws `InvalidObjectIdError` instead of a plain `Error` (or, for 40 non-hex characters, being written as zeros).
    - `probeBlob(blobs, id, { loadText: true })` reads a text blob once and returns it as `content`; a binary blob is still read only to its first 8000 bytes, and only those 8000 bytes are allocated.
  - **vcs-commands:** `DiffFormatter` and `MergeCommand` use the single read: a text blob is read once (one delta resolution for a packed blob), not once to probe and again to load.
  - **vcs-transport:**
    - `pktLineReader` and `parsePacket` return `0002` as `{ type: "response-end" }` (they threw). The packet type `"end"` is renamed `"response-end"` (`PacketType`, `endPacket()`, `pktLineWriter`). `demuxSideband` and `parseReportStatus` stop at it as at a flush; `TransportApi.readPktLine` rejects it with a clear `PacketLineError`.
    - An `ACK` with an object id that is not hex fails with `PackProtocolError`, as before.
    - `TransportApi.readPktLine` and `readGitProtocolRequest` keep received bytes in a chunk queue and copy each byte once; they copied the whole buffer for every chunk.
- 07ace72: **Breaking: one pack importer, byte for byte and streamed.**
  
  - **New in vcs-core:** `unpackObjects(objects, pack, options?)` is git's `unpack-objects`. It reads the stream once, writes every object as a loose object exactly as git frames it, resolves OFS and REF deltas (thin packs from the objects the store has), bounds memory (`baseCacheBytes`, `bigObjectThreshold`), refuses corrupt packs with `PackError` and an object stored under the same id with other bytes with the new `ObjectCollisionError`. `importPack(objects, pack, { packs, unpackLimit })` keeps a pack of at least `unpackLimit` objects (default 100, git's `transfer.unpackLimit`) through `packs.install` and unpacks smaller ones, deciding from the pack header only. Also new: `DEFAULT_UNPACK_LIMIT`, `UnpackTarget`, `UnpackObjectsOptions`, `UnpackResult`, `ImportPackOptions`, `ImportPackResult`, and `InstalledPack.types`.
  - **History:** `History.objects` (the object kernel) and `History.packs` (the files backend's `PackSet`), both optional; `createHistoryFromStores`, `createHistoryFromComponents`, `createGitFilesHistory` and `createGitFilesBackend` set them.
  - **Everything delegates:** `SerializationApi.importPack`, `VcsCore.readPack`, the commands' clone and fetch, and the transport's receive paths go through `importPack`, over the history's object kernel. Commits and tags keep headers the parsers do not model; `SerializationApi.importPack` used to drop them and store the object under another id. The server receive path (`createStorageRepositoryFacade` in vcs-transport-adapters, and the HTTP server demo) now passes its kernel as `objects`, so a pushed commit with a `mergetag` header is stored byte for byte. A history with typed stores only (the SQL native stores) is written through them: an object they would re-encode is refused with `ObjectIdMismatchError` before anything is stored. `PackImportResult.blobsWithDelta` is always 0 and `packId` names a kept pack.
  - **Removed:** `SerializationApi.parseLooseObject` (inflate and `objects.putRaw` instead), `SerializationApi.createPackReader`, `PackReaderApi`, `PackEntry`, `PackHeader`, `ParsedObjectMeta`, `SerializationApiConfig.blobDeltaApi`/`treeDeltaApi`/`commitDeltaApi`, `parsePackEntries`, `parsePackEntriesStream`, `parsePackEntriesFromStream`, `indexPackFromStream`; in vcs-utils `PackObjectCache` and `MemoryPackObjectCache`; in vcs-transport `BufferWriter` and `createHttpClientDuplex`.
  - **Streaming fetch (vcs-transport):** `fetch` and `clone` take `onPack(pack)`, which receives the pack demultiplexed from the response body as it arrives (`packData` is then empty). The new `sidebandPackStream(body, { onProgress })` is that demultiplexer (an `ERR` line or channel 3 throws `ServerError`); `httpFetch` and the fetch state machine stream the pack into `importPack` the same way instead of collecting it. A fetch that sent wants and received no pack now fails instead of reporting success, so no refs are written to missing objects; a failed import cancels the response body (`readableStreamToAsyncIterable` cancels a stream it stops reading early). `fetch`'s `timeout` now bounds each wait for the server rather than the whole fetch, so a slow store does not abort a large clone.
  - **vcs-commands:** `importPackIntoHistory` takes a stream; clone and fetch import the pack while it downloads.
- f440ae3: **New: `installPack(files, packDir, stream, options?)`**, git's `index-pack --stdin --fix-thin` over a `FilesApi`. The pack is stored as `tmp_pack_*`, read once, its deltas resolved through a bounded base cache and a bounded read window, and installed as `pack-<id>.pack` then `pack-<id>.idx`; the `.idx` is byte-identical to `git index-pack`'s. Thin packs are completed through `externalBase` (each missing base looked up once, verified against its id, appended; the pack gets a new count and trailer). Corrupt or hostile packs (bad trailer, truncation, trailing bytes, inflate bombs, delta cycles, missing bases, objects over `maxObjectSize`, streams over `maxPackSize`) are refused with the new `PackError` (a `CorruptObjectError`) and leave nothing behind. Also new: `sweepPackTemporaries(files, packDir, olderThanMs, now?)` removes stale `tmp_*` files as `git prune` does, and `writePackIdx(entries, packChecksum)` writes an `.idx` v2 as git does. Types: `ExternalBase`, `InstallPackOptions`, `InstalledPack`, `PackIdxEntry`.
- b6a5d9c: **The object kernel, `createGitObjects`.** Git objects stored as zlib loose objects over a `StagingBlobStore`, written in one pass (`put(type, size, content)`), received with their id (`putRaw`), and read back checked (`get`, `getRaw`, `has`, `list`, `remove`). New in vcs-core: `GitObjects`, `GitObject`, `CorruptObjectError`, `ObjectIdMismatchError`, `InvalidObjectIdError`, `StagingBlobStore`, `rawStorageStaging`, and a re-export of `SizeMismatchError`. New in vcs-store-files: `filesStagingStore` and `FilesStagingStore` (git's `objects/` layout, `sweepStaged`). New in vcs-testing: `createGitObjectsTests` and `gitObjectSamples` (objects written by git). Additive: the typed stores move to it in a later change.
  
  `deflate` (Web streams): input is pulled with backpressure, a consumer that stops early closes the source without waiting for a stalled one, the source's own errors come out unchanged and compressor errors as `CompressionError`.
- accab85: **New: `openPackSet(files, packDir, options?)`**, reading installed packs as git's object database does. Every `pack-<id>.idx` is validated on open (version 2 or 1, fan-out, length, its own SHA-1, sort order, the 64-bit table, and the pack trailer it names); a corrupt pack is skipped and listed in `skipped`, and opened again only if its files change size or mtime (an idx seen half-written). Lookups use the fan-out table and a binary search; whole objects stream from the inflater; deltas resolve through one byte-bounded base cache for the set (checkpoints along each chain), and callers always get copies. A miss, and every `list()` or `packs()` call, rescans the directory at most once per `rescanIntervalMs` (default 1 s), so packs written by native git after open are found; `refresh()` rescans now. `get` reads the first chunk before returning, so a copy broken from its start fails there and the next copy is tried; a copy found corrupt is marked bad and counts as absent for `has` and `freshen(id)` (the check before skipping a write, which also drops a pack whose file is gone; a pack seen within the rescan interval, at most 1 s, is trusted, and writes in that window are not retried). Returning the content without reading it closes the pack read. REF_DELTA bases in other packs, or outside the set through `externalBase`, are resolved with cycle detection (`PackError`). `entry(id)` returns an entry as stored (kind, size, base id, CRC-32 and its compressed bytes; `raw()` checks the CRC before it yields a byte, reading the entry twice) for pack reuse. `install()` delegates to `installPack` and adds the pack; `remove()` deletes `.idx` first, then `.pack`, `.keep`, `.rev`. Also new: `openPack(files, packPath, idxPath, options?)` for one pack, `DeltaBaseCache`, and the types `Pack`, `PackSet`, `PackFile`, `PackedEntry`, `OpenPackOptions`, `OpenPackSetOptions`.
  
  **Changed in vcs-store-files:** `withPacks(loose, packs)` and `skipPacked(store, packs)` take a `PackSet` instead of a `PackDirectory`. Reads go to the packs first, then loose objects; a packed copy failing before `get` returns gives way to a loose copy, one failing later is marked bad so the next read goes loose. Pack misses rescan at most once per second. Packed objects stream instead of being buffered, and `getRaw` is built from `get`. Writes skip an object only if a pack still on storage holds a sound copy of it. `PackDirectory` takes an `onChange` callback (its failures are ignored), which the backend uses to refresh `packs` after `addPack` and `removePack`. `createGitFilesBackend` returns the set as `packs` (and still `packDirectory`, for repack and gc).
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
- 060fcd0: **Atomic ref batches on git's files layout (vcs-store-files).** `FileRefStore.batch` implements git's lock-file protocol:
  - **One ref:** lock `<ref>.lock` exclusively, re-check under the lock, then commit by rename.
  - **Several refs:** lock every ref, then `packed-refs.lock`, then a two-phase `packed-refs` commit, as in JGit's `PackedBatchRefUpdate`.
  - **Crashes:** a crash at any file operation leaves every ref at its old or its new value.
  - **Interop:** native git reads the result and honours the locks, in both directions.
  - **Reflog:** lines are written in git's format, as git with `core.logAllRefUpdates=true`: logs are created for HEAD, branches, remotes and notes (not tags); HEAD records no-op updates and deletes of its branch.
  - **Readers (fixed):** `readAllRefs`, `list` and `packRefs` / `optimize` no longer treat `*.lock` files as refs (they could pack and delete another writer's live lock). Loose refs are re-read around `packed-refs`, so a listing never combines old and new states.
  - **Reflog reader (fixed):** lines without a message, as git writes them, are read.
  - **Limit:** a multi-ref batch that replaces a symbolic ref (`noDeref`) is refused as `unsupported`.
  - **`compareAndSwap`** is now a one-command batch, so it works on packed-only refs.
  - **`createFilesRefBatch(atomicFiles, options)`** exposes the batch on its own.
  - **Options:** `FileRefStore` / `createFileRefStore` / `createGitFilesBackend` accept `atomicFiles`, `refLockTimeoutMs` and `packedLockTimeoutMs`.
  - **Format:** `packed-refs` written by a batch carries git's `sorted` trait.
  
  **New (vcs-utils):**
  - `AtomicFiles`: exclusive create, replace by rename, append, remove-if-empty, plus read, write and list.
  - `atomicFilesOver(files, root)`: an implementation over any FilesApi. It is atomic only among users of the same FilesApi instance (not across instances or processes).
  
  Lock files go through `AtomicFiles`; the portable `atomicFilesOver(files, gitDir)` excludes writers sharing one FilesApi.
  
  **vcs-core:** `RefStore` gains an optional `batch`; `RefsAdapter` uses it when present.
  
  **New (vcs-testing):** `createAtomicFilesTests`, the `AtomicFiles` contract suite.
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
- 6343211: **Breaking (vcs-core):** `isValidRefName(name, { allowOneLevel? })` now gives exactly the verdict of `git check-ref-format`. One-level names such as `HEAD` or `main` now return `false` unless `allowOneLevel` is set. It also refuses names the old check accepted:
  - a component that starts with `.` or ends with `.lock`;
  - a name that ends with `.`;
  - `@`;
  - `a/./b`;
  - lone UTF-16 surrogates.
  
  **New (vcs-core):**
  - `isValidBranchName` and `isValidTagName`: git's extra rules (no leading `-`, not `HEAD`) applied to the full `refs/heads/…` or `refs/tags/…` name.
  - `compareRefNames`: git's order (the byte order of the UTF-8 names).
  
  **Changed (vcs-commands):** branch create, branch rename, tag, and both `checkout -b` paths validate names as git does.
  - Newly refused: `a/.hidden`, `x.lock/y`, `trailing.`, `a/./b`, `a//b`, the branch `HEAD` and the tag `HEAD` (git 2.48+).
  - Newly accepted: `@`.
  - `checkout -b` validates names for the first time.
  - Branch and tag lists are in git's order (uppercase first).
  
  **Changed (vcs-store-files):** `packed-refs` is written in git's byte order, as git writes it. git re-sorts a file without the `sorted` trait on read, so this changes only the file's order, not how it reads.
- 5684650: **Breaking: every store uses git's SHA-1 object ids; the FNV-1a ids are gone.**
  
  Removed: `computeCommitHash`, `computeTreeHash` and `computeTagHash` (vcs-core), `MemoryCommitStore` / `MemoryTreeStore` / `MemoryTagStore` (vcs-store-mem), `KVCommitStore` / `KVTreeStore` / `KVTagStore` with their scan queries (vcs-store-kv), and `SQLCommitStore` / `SQLTreeStore` / `SQLTagStore` (vcs-store-sql). Use `createMemoryObjectStores()`, `createKvObjectStores({ kv })`, and `createSqlNativeStores(db)` or `createSqlObjectStores({ db })`.
  
  `SQLHistoryFactory` (`createHistory("sql", …)`) now wires the native SQL stores, so its trees, commits and tags get git ids. Persisted ids change: databases it wrote before hold FNV ids in `tree`, `tree_entry`, `vcs_commit`, `commit_parent`, `vcs_tag`, `vcs_ref`, `vcs_reflog`, `tree_delta` and `tree_delta_entry`, and KV stores in `commit:`, `tree:` and `tag:` keys. There is no migration; re-import from a git remote.
  
  The shared tree, commit and tag suites check ids against ones git computes.
- bb70139: **Changed: `repack()` is `git repack -a -d` over the pack set, streamed end to end.** `repack(backend)` lists every object reachable from the refs, HEAD, the reflogs and the index (`listObjects`), streams them through `writePack` (reusing stored whole objects and deltas, searching deltas for the rest) straight into `PackSet.install`, and only then removes the packs the new one replaces and the loose objects a pack now holds (`prunePacked`, git's `prune-packed`). No pack is held in memory. Packs with a `.keep` file stay, and their objects are not copied (git's `--honor-pack-keep`). `repack({ ...backend, all: false })` is `git repack -d`: the reachable loose objects go into a new pack, existing packs are untouched. Unreachable loose objects are never packed. Only packs present before the reachability walk are replaced: the pack set is snapshotted first, so a pack installed during the walk (a push whose ref is not updated yet) is never removed, nor is a snapshot pack modified after the walk started. `unpackUnreachable: true` is `git repack -A -d`: unreachable objects of the replaced packs are streamed into loose objects before the packs are removed, unless the pack is older than `unpackUnreachableExpireMs` (two weeks; a pack whose mtime is unknown is loosened), and an object already loose whose file is older than an hour is rewritten so its mtime is renewed (an old loose copy must not expire with its young pack gone); the default stays `git repack -a -d`, which drops them. The options are `all`, `unpackUnreachable`, `unpackUnreachableExpireMs`, `deltaSearch`, `reuseDeltas`, `reuseObjects`, `bigFileThreshold` and `dryRun`; the result adds `packsRemoved`, `keptPacks` and `unpackedObjects`. `repack({ looseStorage, packDirectory })` no longer exists.
  
  **Changed: `gc()` is `git gc`.** It takes `.git/gc.pid` with an exclusive create, holding a random token (a second gc returns `skipped: true`; a lock older than 12 hours is taken over by one gc at a time, under `gc.pid.takeover`, and never when the FilesApi gives no `lastModified`; gc releases the lock only while it holds its token), lists what is reachable, packs refs (`packRefs`, default true), repacks what is reachable into one pack (`repack`, default true) with `git repack -A -d` semantics, prunes unreachable loose objects last modified more than `pruneExpireMs` ago (default two weeks, git's `gc.pruneExpire`; `0` is `--prune=now`) and sweeps loose and pack temporaries once older than `tmpExpiryMs`, and `.pack` files whose `.idx` is gone once older than `orphanPackExpiryMs` (default `tmpExpiryMs`, but never under an hour: a pack being installed arrives before its `.idx`; git never removes them). The loose prune skips the unreachable objects the repack has just left loose. Objects reachable only from a reflog, the index, or a linked worktree's HEAD, index or reflogs are kept. Unreachable objects of a replaced pack younger than `pruneExpireMs` are written loose, so a branch deleted with its reflog keeps its packed commits for the grace period; FilesApi cannot set mtimes, so those loose copies get the current time and live up to `pruneExpireMs` longer than under git. A ref that cannot be read or is malformed makes gc and repack throw before anything is deleted, as `git gc` does. The result adds `keptRecentObjects`, `refsPacked`, `repack`, `removedOrphanPacks` and `skipped`. The trees of the index's cache-tree (TREE) extension and the blobs of its resolve-undo (REUC) extension are not roots (the index parser does not parse extensions). A split index (`link` extension) makes gc and repack throw before anything is changed, since the blobs staged in its shared index would otherwise stop being roots. Breaking: unreachable loose objects younger than two weeks are no longer removed by default.
  
  **New in vcs-store-files:** `listReachableObjects` and `collectReachabilityRoots` (refs, HEAD, reflogs, index, linked worktrees), `readAllRefs(files, gitDir, prefix, { strict: true })` and the `ReadRefsOptions` it takes (also on `readLooseRef` and `readPackedRefs`), `prunePacked`, `RepackTarget`, `DEFAULT_PRUNE_EXPIRE_MS`. `createGitFilesBackend` takes `freshenMaxAgeMs` (passed to `openPackSet` and `filesStagingStore`) and returns `files` and `gitDir`, so its result can be passed to `repack()` and `FileGcStrategy` as is. `FileGcStrategy(backend)` compacts with `repack({ all: false })` and reads its stats from the pack set.
  
  **Fixed in vcs-core:** a `PackSet` whose pack file disappeared (removed by a repack in another backend or by native git) rescans the directory at once, whatever the rate limit, so a concurrent reader finds the replacement pack instead of reporting the object missing.
  
  **Changed in vcs-core: `PackSet.freshen` and old packs.** `openPackSet` takes `freshenMaxAgeMs` (default one hour, git's freshen window): `freshen(id)` is false when the pack holding the object was last modified longer ago, so the object kernel writes it loose again. git would touch the pack's mtime to keep a concurrent gc from expiring the object; FilesApi cannot set mtimes, and the fresh loose copy does that job. A pack whose mtime is unknown is trusted.
  
  **Removed (legacy pack code):** in vcs-core, `indexPack` / `verifyPackChecksum` (`pack-indexer`; use `installPack`), `PendingPack`, the `GitPackStore` interface, `CombinedRawStorage`, `GitFilesBlobDeltaApi`, `GitFilesDeltaApi`, `GitFilesTreeDeltaApi`, `GitFilesCommitDeltaApi` and `DeltaStore.loadObject`; in vcs-store-files, `PackDirectory`, `PackReader`, `PackDeltaStore`, `PackConsolidator`, `GitPackStoreImpl` / `createGitPackStore`, `RandomAccessDeltaReader`, `DirectPackObjectReader`, `PackDirectoryAdapter`, and `packDirectory` from the backend result. `createGitFilesHistory(config)` takes `packs` instead of `packDeltaStore`; its `delta` is the new read-only `PackSetDeltaApi` (which packed objects are deltas, their chains; `deltifyBlob` throws, as git writes deltas only through `repack()`). `GitFilesHistoryOptions.enableDeltas` is gone.
  
  **Changed: `GCController` gets a size cap.** `maxDeltaBlobSize` (default 16 MiB) keeps blobs larger than that out of deltification in `quickPack` and `runGC`, and a delta whose base is larger than that is not stored. `DefaultDeltaEngine` skips candidate bases larger than its `maxTargetSize` (16 MiB) before loading them. The controller serves the memory, KV and SQL delta stores; Git file repositories use `repack()` and `gc()`.
  
  **Fixed in vcs-store-files: writes freshen old loose objects.** Writing an object whose loose file is older than an hour moves the new temporary over it, so the rename renews its mtime and a concurrent gc keeps it, as git's `freshen_loose_object` does. A loose file whose mtime is unknown is kept as it is, as `PackSet` trusts a pack of unknown age. `filesStagingStore(files, objectsDir, { freshenMaxAgeMs })` sets the window (default one hour) and adds `isFresh(id)`.
  
  **New in vcs-working-tree:** `parseIndexFile` returns `extensions`, the signatures of the index extensions after the entries, in file order.
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
- c767140: **Checkout never writes into the repository's own `.git`** (git's `verify_path`, CVE-2014-9390). Tree and index paths come from other people's repositories, and a crafted tree with an entry named `.git` used to write its files into the worktree's `.git` (config, hooks, refs).
  
  - **vcs-core:** new `isValidWorktreePath(path)` and `assertValidWorktreePath(path)`. They refuse empty, `.` and `..` components, and `.git` under any spelling a filesystem folds to it: any letter case; NTFS trailing dots and spaces, the 8.3 name `git~1`, alternate data streams (`.git::$INDEX_ALLOCATION`) and `\` as a separator; and HFS+-ignored code points (`‌.git`). `.gitignore`, `.github/` and other dotfiles stay valid.
  - **vcs-store-files:** `FileWorktree.writeContent`, `mkdir`, `remove` and `rename` refuse such paths. `checkoutTree` and `checkoutPaths` report them under `failed` and check out the rest. `GitResolutionStore` refuses them when it writes conflict resolutions to the worktree.
  - **vcs-commands:** the core `CheckoutCommand` refuses such paths when it writes or removes worktree files, and reports them as conflicts. `clean` leaves an untracked file with such a name (`git~1`, `.GIT/`) in place rather than aborting on it.
- 46f2a01: **Move to `@statewalker/webrun-files` 0.12 and webrun-sync 0.3.** webrun-files, -browser, -mem and -node go from ^0.11.0 to ^0.12.0. webrun-storage, -content-store, -content-transfer and -files-sync go from ^0.2.0 to ^0.3.0, which are their releases on webrun-files 0.12. Both are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. Consumers must move to webrun-files 0.12 too, so a single copy of the core is installed.
  
  - **vcs-store-files:** `GitResolutionStore` without an explicit `worktreePath` now defaults it to `dirname(gitDir)`, not the literal path `<gitDir>/..`. That literal path left the resolution to the store, and with `gitDir` at the root it now throws.
  - **vcs-core:** `decodeTreeEntries` now refuses entry names that git fsck rejects: empty, `.`, `..`, or containing `/`. Such names come only from crafted trees, for example fetched from a remote. Checkout turns entry names into worktree paths, and webrun-files 0.12 resolves `..`, so a tree `sub/` → `..` → `.git/config` would otherwise write into the repository's own `.git`.
- b758bc0: **Breaking: one streaming pack writer, `writePack`, and `listObjects` to feed it.**
  
  - **New in vcs-core:** `listObjects(objects, { wants, haves, excludes, shallow, onBoundary })` is `git rev-list --objects`: commits by committer time with git's SLOP for clock skew, the trees under the boundary excluded, tags peeled, paths for trees and blobs, shallow commits as boundaries (no deepening). `writePack(objects, ids, options)` is `git pack-objects`, an `AsyncIterable<Uint8Array>` of a v2 pack whose SHA-1 is computed while it streams. It reuses stored entries from a `PackSet` without inflating them (`reuseObjects`, `reuseDeltas`), rewrites OFS offsets, writes a reused delta whole when its base is neither in the pack nor a have, runs git's windowed delta search when asked (`deltaSearch`: window 10, depth 50, bounded window memory), keeps reused delta chains within the depth too (a deeper stored chain is broken by writing an object whole, as git's `break_delta_chains`, and the base of reused deltas never becomes a delta that would push them past it), never searches blobs over `bigFileThreshold` (50 MiB), writes thin packs (`thin`, `haves`), defaults to OFS deltas (`ofsDelta`), and reports each entry (`onEntry`) for an idx. Also new: `MissingObjectError`, `DEFAULT_BIG_FILE_THRESHOLD`, `SerializationApi.exportPack(wants, haves, { thinPack, shallow, useDelta, ofsDelta })`.
  - **Removed from vcs-core:** the old whole-pack `writePack(objects)` and `PackWriterStream` (`pack-writer`), `StreamingPackWriter`, `PackWriterObject`, `PackWriterResult`, `SerializationApi.createPackBuilder`, `PackBuilder`, `PackBuildStats`, `PackOptions.thinPack`/`onProgress`, `SerializationApiConfig.deltaCompressor`, and `VcsCore.repack()` (a round trip that rewrote nothing). `SerializationApi.createPack` streams through `writePack` (deltas searched unless `useDelta: false`), `serializeLooseObject` deflates the raw object as it streams, `VcsCore.writePack(ids)` is `writePack`, and `PendingPack` flushes through it. vcs-testing's `CraftPackWriter` and `craftPackFile` lay out packs with chosen deltas for tests.
  - **Removed from vcs-transport:** `PushObject` and `PushOptions.getObjectsToPush`. `push` needs `exportPack(wants, exclude, { ofsDelta })` when it sends objects (`ofsDelta` is whether the remote advertised `ofs-delta`; the push state machine and `httpPush` follow it too). Outside browsers it streams the POST body (`ReadableStream`, `duplex: "half"`); browsers collect it unless `streamRequestBody: true`, since Chromium refuses streamed bodies over HTTP/1.1, and a streamed request rejected with a `TypeError` before any response is retried once with a collected body (the pack exported again). `httpPush` sends the same way. New: `requestBody`, `supportsRequestStreams`, `shouldStreamRequestBody`, `isBrowserContext`, `fetchWithRequestBody`, `toReadableStream`, `PushOptions.streamRequestBody`, `HttpPushOptions.streamRequestBody`, `ExportPackOptions.ofsDelta`.
  - **Streaming serve (vcs-transport):** `handleUploadPack` returns a `ReadableStream` body pulled by the client, so `HttpResponse.body` is `Uint8Array | ReadableStream<Uint8Array>`. `Duplex.write` may return a Promise and every writer awaits it (backpressure; `createGitSocketClient` passes its socket's). The upload-pack server writes a thin pack, OFS deltas and side-band only when the client's first `want` line asks for `thin-pack`, `ofs-delta` and `side-band-64k` (the advertised capabilities used to count as requested, also for a want line without any); later want lines' capabilities are ignored, and the advertised set is kept in `ProtocolState.advertisedCapabilities`. An error after the first pack byte goes out as `ERR` on sideband 3 (v0/v1 and v2); without side-band the response stream is aborted (`HandlerOutput.streamBroken`). While the pack is prepared, side-band sessions get git's keep-alive (`0005\x01`) every `keepAliveMs` (default 5 s) until the first pack byte; new `sendPackStream`, `HttpServerOptions.keepAliveMs`, `ProcessConfiguration.keepAliveMs`.
  - **Callers:** `RepositoryFacade.exportPack` (both facades), the `PushCommand` and the demos go through `exportPack`; `repack()` in vcs-store-files writes with `writePack`.

### Patch Changes

- c60d922: **Breaking (vcs-utils):** incremental SHA-1 goes through one `Hasher` interface (`update` / `digest` / `clone`) from `createSha1()`, on `@noble/hashes`. The vendored `Sha1` class, `newSha1` and `sha1Sync` are removed.
  
  Migration: `new Sha1().update(data).finalize()` becomes `createSha1().update(data).digest()`, and `sha1Sync(data)` becomes `createSha1().update(data).digest()`. Unlike `finalize()`, `digest()` can be read only once: the hasher is spent after it, so `clone()` first to keep the state.
  
  New: `computeObjectIdFromStream(type, size, chunks)` hashes a git object in one pass from a declared size, and rejects with `SizeMismatchError` on a short or long stream. `computeObjectId` hashes objects of 64 KiB and more with Web Crypto, and smaller ones with the portable hasher. vcs-core and vcs-store-sql now hash through `createSha1`.
- 08309ab: **Large blobs in one pass.** A blob stored with its size streams from its source to `FilesApi.write` holding about one chunk (a FilesApi whose `write` streams keeps it so to the disk). The loose-ref reader skips dot-names, as git does. both add commands (`git.add()` and the core `AddCommand`) pass the worktree size of regular files (and collect a file that changed while being read; symlinks are collected), and merge, pack import, transport and conflict resolution pass the sizes of the buffers they already hold. `gc()` removes `tmp_obj_*` temporaries older than two weeks (`tmpExpiryMs`, `removedTemporaries`), as `git prune` does. A benchmark (`pnpm --filter @statewalker/vcs-store-files test:bench`, with a streaming FilesApi of its own) stores 200 MB with live memory under 64 MB and checks it with `git fsck`.
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
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [e509d97]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [b6a5d9c]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [060fcd0]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [46f2a01]
  - @statewalker/vcs-utils@0.4.0

## 0.3.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/index.js
- Updated dependencies
  - @statewalker/vcs-utils@0.3.3

## 0.3.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/storage@0.1.1
  - @statewalker/vcs-utils@0.1.1
