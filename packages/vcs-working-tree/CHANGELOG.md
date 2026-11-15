# @statewalker/vcs-working-tree

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
- 7392d8e: **Breaking: worktree hashing and checkout writes stream.** No worktree file or blob is read whole just to hash it or to write it.
  
  - **vcs-working-tree:** new `hashWorktreeFile(path, { size, read }, newHasher?)` hashes a file as it streams, with its size from stat. When the file changes size while it is read it re-stats and retries once, then returns `unknownContentId()`, a non-hex value unique to each call that never equals an index id, so it compares as modified (`isUnknownContentId` recognises it). `add -N` now records the empty blob's id flagged `intentToAdd`, as git does, instead of an empty id. Checkout writes are as atomic as `FilesApi.write`. `MemoryWorktree` uses it. The `hashFunction` option is removed; pass `newHasher` (an incremental `Hasher` factory, default `createSha1`). New type `NewHasher`.
  - **vcs-store-files:** `FileWorktree.computeHash` and `FileTreeIterator.computeHash` stream through `hashWorktreeFile`; their `hashFunction` option is replaced by `newHasher`. `FileWorktree.checkoutTree` streams each blob into `FilesApi.write`. `GitResolutionStore` streams blobs into the worktree (`acceptOurs`, `acceptTheirs`), stores resolved files as streams of known size (`markAllResolved`), and scans for conflict markers chunk by chunk.
  - **vcs-commands:** the core `CheckoutCommand`, `Git.checkout()`, `reset --hard` and `stash apply` hand the blob stream to the worktree instead of collecting it.
  - **vcs-utils:** `computeObjectIdFromStream(type, size, content, newHasher?)` takes an optional hasher factory.

### Patch Changes

- e509d97: **Lock files use `FilesApi.createExclusive` when the FilesApi has it.** `atomicFilesOver(files, root).createExclusive` now delegates to the FilesApi's own exclusive create (webrun-files: `open "wx"` on Node, Web Locks in the browser, a transaction in sqlite) when it is present, detected at run time. Every git lock goes through it (`<ref>.lock` and `packed-refs.lock` in ref batches, `index.lock`, `gc.pid` and `gc.pid.takeover`), so the exclusion becomes cross-process: native git, other tabs and other FilesApi instances over the same directory are excluded. A delegated create that fails with ENOENT (another process, such as native git, pruned the empty directory between webrun-files-node's `mkdir` and its `open`) is retried, as git's `raceproof_create_file` does. Without it, locks behave as before: check-then-write, exclusive only among writers sharing one FilesApi instance.
  
  **webrun-files 0.11.** The catalog moves `@statewalker/webrun-files`, `-node`, `-mem` and `-browser` to `^0.11.0`. Every one of them now has `createExclusive`, so on Node locks hold across processes: two processes with their own `createNodeFilesApi` over one repository never both take `<ref>.lock` or `index.lock`, and native `git` sees our locks (and we see its). `createNodeFilesApi().write` streams to a temporary file and renames it over the target, and a `createNodeFilesApi({ rootDir: "/" })` accepts absolute paths. The vcs `FilesApi` interface declares the optional `createExclusive`, as webrun-files does.
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

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core ^0.3.1 -> ^0.3.2
  - files changed: README.md
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/vcs-utils@0.1.1
