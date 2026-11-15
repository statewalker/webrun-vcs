# @statewalker/vcs-commands

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
- 8db23c6: **Breaking: one push client, like git's send-pack (P3.5).**
  
  `push` (smart HTTP), `pushOverDuplex` and vcs-commands' `PushCommand` now run one implementation (`push-client/`) of git's transport.c, remote.c and send-pack.c push logic, with I/O adapters for smart HTTP (`openHttpReceivePackConnection`) and duplex streams (`openDuplexReceivePackConnection`).
  
  - **Refspecs as `git push`** (`matchPushRefs`): `src:dst`, `+`, `:dst` deletes, `^src`, short names (`main`), `HEAD`, object ids, short destinations of refs the remote has, new short destinations typed from the source (a branch or a tag; otherwise git's "The destination you provided is not a full refname" error), patterns (`--all`, `--tags`), `:` (matching), `prune` (`--prune`; with `+refs/*:refs/*`, `--mirror`). Refspec errors throw `PushRefspecError` before anything is sent.
  - **Per-ref statuses as git's** (`setPushStatus`, `PushRefStatus`, `summary`): `up-to-date`, `[new branch]`/`[new tag]`, fast-forward, `rejected-fetch-first`, `rejected-nonfastforward`, `rejected-needs-force`, `rejected-already-exists` (tags), `rejected-stale` (`forceWithLease`), `rejected-nodelete`, `atomic-push-failed`, `remote-rejected` (`ng`), `remote-failure`. Refused refs are not sent; `atomic` sends nothing when one is refused.
  - **The request:** only advertised capabilities are asked for (`report-status`, `side-band-64k`, `quiet`, `atomic`, `push-options`, `object-format`, `agent`; `ofs-delta` is used, not asked, as git); `atomic`/`pushOptions` the server does not advertise throw. The pack is thin against every advertised tip that is here (and `.have` lines), unless `no-thin` or `thin: false`; deletes only send no pack; nothing to update sends no request. Over smart HTTP the body streams (`streamRequestBody: false` collects it, with a `Content-Length`), `timeout` is an idle timeout, the report is read as it arrives (keep-alives, progress), 401/403 are `AuthenticationError`s.
  - **API changes:** `push(options)` takes `repository` and `refStore` (was `getLocalRef` and `exportPack`) and returns `PushClientResult` (`updates: PushRefUpdate[]`, `unpack`, `packObjects`, `packBytes`, `bytesSent`, `capabilities`; was `HttpPushResult` with `updates: Map`, `unpackStatus`, `objectCount`); new options `forceWithLease`, `trackingValue`, `pushOptions`, `prune`, `thin`, `dryRun`, `quiet`, `onProgress` (was `onProgressMessage`). `pushOverDuplex` takes the same options plus `duplex`/`closeDuplex` (no `delete`); `RefPushStatus` gains `status`, `PushResult` gains `report`. Removed: `httpPush` (use `push`), `clientPushTransitions`/`clientPushHandlers` (the client push FSM), `HttpPushResult`, `RefUpdateResult`, `BasePushOptions`, `BaseDuplexOptions`, `ProcessConfiguration.pushRefspecs`. `readServerGreeting`, `ServerGreeting` and `withTimeout` are exported from the fetch client for the push connections.
  - **vcs-commands `PushCommand`:** runs the push client; `setForceWithLease(ref?, expect?)`, `setPrune`; `setPushAll`/`setPushTags` push `refs/heads/*`/`refs/tags/*`; without refspecs the remote's `push` refspecs, else the current branch; accepted refs move their remote-tracking refs (`refs/remotes/<remote>/…`). `PushStatus.REJECTED_REMOTE_CHANGED` (stale lease) and `RemoteRefUpdate.summary` are new; "fetch first" maps to `REJECTED_NONFASTFORWARD` (as JGit), `forceUpdate` is whether the update was allowed to force, `messages` holds the server's progress.
  - **vcs-transport-httpeers:** `meshGitPush` returns the push client's `PushClientResult` and takes `repository`/`refStore` (was `getLocalRef`/`exportPack`).
  - **Review fixes:** revision sources and lease values (`resolveRevision`, `RepositoryFacade.resolvePrefix` for abbreviated ids); `ForceWithLease.ref` optional (covers the rest); `--prune` with patterns without a colon and with `:`; a pattern wins over `:`; git's messages for duplicate destinations and detached HEADs; a missing or unreadable report keeps refs as `remote-failure`; shallow lines; the idle timeout times the server only, `pushOverDuplex` takes `timeout`/`signal`, an aborted signal sends nothing. `PushCommand`: `callOrThrow` throws on a stale lease, `setStreamRequestBody`, `push.default` (`simple` by default: without refspecs a branch without an upstream on its own remote, or with one of another name, is refused; a detached HEAD is refused), remote-tracking refs follow up-to-date refs too. `RemoteConfigStore` gains `value`/`setValue`.
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
- b758bc0: **Breaking: one streaming pack writer, `writePack`, and `listObjects` to feed it.**
  
  - **New in vcs-core:** `listObjects(objects, { wants, haves, excludes, shallow, onBoundary })` is `git rev-list --objects`: commits by committer time with git's SLOP for clock skew, the trees under the boundary excluded, tags peeled, paths for trees and blobs, shallow commits as boundaries (no deepening). `writePack(objects, ids, options)` is `git pack-objects`, an `AsyncIterable<Uint8Array>` of a v2 pack whose SHA-1 is computed while it streams. It reuses stored entries from a `PackSet` without inflating them (`reuseObjects`, `reuseDeltas`), rewrites OFS offsets, writes a reused delta whole when its base is neither in the pack nor a have, runs git's windowed delta search when asked (`deltaSearch`: window 10, depth 50, bounded window memory), keeps reused delta chains within the depth too (a deeper stored chain is broken by writing an object whole, as git's `break_delta_chains`, and the base of reused deltas never becomes a delta that would push them past it), never searches blobs over `bigFileThreshold` (50 MiB), writes thin packs (`thin`, `haves`), defaults to OFS deltas (`ofsDelta`), and reports each entry (`onEntry`) for an idx. Also new: `MissingObjectError`, `DEFAULT_BIG_FILE_THRESHOLD`, `SerializationApi.exportPack(wants, haves, { thinPack, shallow, useDelta, ofsDelta })`.
  - **Removed from vcs-core:** the old whole-pack `writePack(objects)` and `PackWriterStream` (`pack-writer`), `StreamingPackWriter`, `PackWriterObject`, `PackWriterResult`, `SerializationApi.createPackBuilder`, `PackBuilder`, `PackBuildStats`, `PackOptions.thinPack`/`onProgress`, `SerializationApiConfig.deltaCompressor`, and `VcsCore.repack()` (a round trip that rewrote nothing). `SerializationApi.createPack` streams through `writePack` (deltas searched unless `useDelta: false`), `serializeLooseObject` deflates the raw object as it streams, `VcsCore.writePack(ids)` is `writePack`, and `PendingPack` flushes through it. vcs-testing's `CraftPackWriter` and `craftPackFile` lay out packs with chosen deltas for tests.
  - **Removed from vcs-transport:** `PushObject` and `PushOptions.getObjectsToPush`. `push` needs `exportPack(wants, exclude, { ofsDelta })` when it sends objects (`ofsDelta` is whether the remote advertised `ofs-delta`; the push state machine and `httpPush` follow it too). Outside browsers it streams the POST body (`ReadableStream`, `duplex: "half"`); browsers collect it unless `streamRequestBody: true`, since Chromium refuses streamed bodies over HTTP/1.1, and a streamed request rejected with a `TypeError` before any response is retried once with a collected body (the pack exported again). `httpPush` sends the same way. New: `requestBody`, `supportsRequestStreams`, `shouldStreamRequestBody`, `isBrowserContext`, `fetchWithRequestBody`, `toReadableStream`, `PushOptions.streamRequestBody`, `HttpPushOptions.streamRequestBody`, `ExportPackOptions.ofsDelta`.
  - **Streaming serve (vcs-transport):** `handleUploadPack` returns a `ReadableStream` body pulled by the client, so `HttpResponse.body` is `Uint8Array | ReadableStream<Uint8Array>`. `Duplex.write` may return a Promise and every writer awaits it (backpressure; `createGitSocketClient` passes its socket's). The upload-pack server writes a thin pack, OFS deltas and side-band only when the client's first `want` line asks for `thin-pack`, `ofs-delta` and `side-band-64k` (the advertised capabilities used to count as requested, also for a want line without any); later want lines' capabilities are ignored, and the advertised set is kept in `ProtocolState.advertisedCapabilities`. An error after the first pack byte goes out as `ERR` on sideband 3 (v0/v1 and v2); without side-band the response stream is aborted (`HandlerOutput.streamBroken`). While the pack is prepared, side-band sessions get git's keep-alive (`0005\x01`) every `keepAliveMs` (default 5 s) until the first pack byte; new `sendPackStream`, `HttpServerOptions.keepAliveMs`, `ProcessConfiguration.keepAliveMs`.
  - **Callers:** `RepositoryFacade.exportPack` (both facades), the `PushCommand` and the demos go through `exportPack`; `repack()` in vcs-store-files writes with `writePack`.

### Patch Changes

- 44b3105: **Breaking: one ref interface, `Refs`.**
  
  - **vcs-core removals:** the legacy `RefStore` interface, its `RefStoreLocation` alias (use `RefStorage`), `RefsAdapter` and `createRefsAdapter`.
  - **`createHistoryFromComponents`:** `refs` is now `{ type: "memory" }` or any `Refs` implementation, used as is. It replaces `{ type: "adapter", refStore }`. Anything else, including a stale `{ type: "adapter", … }` from untyped JavaScript, throws at runtime.
  - **vcs-store-files:** `FileRefStore` implements `Refs` directly. `delete(name)` is now `remove(name)`.
  - **vcs-commands:** `CheckoutCommandOptions.refs` is a `Refs`.
  - **Ref updates through `Refs`, on every backend:**
    - **Creates and updates** behave as before: one atomic command, `oldId` null meaning "must not exist".
    - **Deletes** are now one atomic command too. They remove the named ref itself (for a symbolic ref, not its target), check `oldId` when it is given, and return `false` for a missing ref.
    - **Names** outside `refs/` and `HEAD` are refused.
- 358b946: **`Git.init().setFilesApi(files)` writes the repository to those files.** It used to build an in-memory history whatever FilesApi was given, so nothing reached `.git`: a repository initialized on the browser filesystem (or any FilesApi) vanished on reload and native git could not read it. With a FilesApi, init now creates `gitDir` in git's layout (HEAD, config, objects, refs) through `createGitFilesHistoryFromFiles`; as `git init` does on an existing repository, a second init keeps its HEAD, config and objects (a config without a HEAD counts as existing). The index is kept in `<gitDir>/index` unless a staging store is given, so a reopened repository's next commit keeps the files already committed; a bare repository gets `core.bare = true`. Without a FilesApi the repository stays in memory, as before.
- 08309ab: **Large blobs in one pass.** A blob stored with its size streams from its source to `FilesApi.write` holding about one chunk (a FilesApi whose `write` streams keeps it so to the disk). The loose-ref reader skips dot-names, as git does. both add commands (`git.add()` and the core `AddCommand`) pass the worktree size of regular files (and collect a file that changed while being read; symlinks are collected), and merge, pack import, transport and conflict resolution pass the sizes of the buffers they already hold. `gc()` removes `tmp_obj_*` temporaries older than two weeks (`tmpExpiryMs`, `removedTemporaries`), as `git prune` does. A benchmark (`pnpm --filter @statewalker/vcs-store-files test:bench`, with a streaming FilesApi of its own) stores 200 MB with live memory under 64 MB and checks it with `git fsck`.
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
- c767140: **Checkout never writes into the repository's own `.git`** (git's `verify_path`, CVE-2014-9390). Tree and index paths come from other people's repositories, and a crafted tree with an entry named `.git` used to write its files into the worktree's `.git` (config, hooks, refs).
  
  - **vcs-core:** new `isValidWorktreePath(path)` and `assertValidWorktreePath(path)`. They refuse empty, `.` and `..` components, and `.git` under any spelling a filesystem folds to it: any letter case; NTFS trailing dots and spaces, the 8.3 name `git~1`, alternate data streams (`.git::$INDEX_ALLOCATION`) and `\` as a separator; and HFS+-ignored code points (`‌.git`). `.gitignore`, `.github/` and other dotfiles stay valid.
  - **vcs-store-files:** `FileWorktree.writeContent`, `mkdir`, `remove` and `rename` refuse such paths. `checkoutTree` and `checkoutPaths` report them under `failed` and check out the rest. `GitResolutionStore` refuses them when it writes conflict resolutions to the worktree.
  - **vcs-commands:** the core `CheckoutCommand` refuses such paths when it writes or removes worktree files, and reports them as conflicts. `clean` leaves an untracked file with such a name (`git~1`, `.GIT/`) in place rather than aborting on it.
- Updated dependencies [03b17ed]
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
- Updated dependencies [8b5e375]
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
- Updated dependencies [484a4fc]
- Updated dependencies [ee92812]
- Updated dependencies [8db23c6]
- Updated dependencies [c2c944f]
- Updated dependencies [c9bfe06]
- Updated dependencies [d04f62d]
- Updated dependencies [8c6e99c]
- Updated dependencies [060fcd0]
- Updated dependencies [6a3a31d]
- Updated dependencies [33612d4]
- Updated dependencies [6964023]
- Updated dependencies [6343211]
- Updated dependencies [5684650]
- Updated dependencies [e77be2f]
- Updated dependencies [bb70139]
- Updated dependencies [0a580e3]
- Updated dependencies [3a69a0f]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [60dd7da]
- Updated dependencies [081386c]
- Updated dependencies [c767140]
- Updated dependencies [46f2a01]
- Updated dependencies [b124917]
- Updated dependencies [b758bc0]
  - @statewalker/vcs-transport@0.4.0
  - @statewalker/vcs-utils@0.4.0
  - @statewalker/vcs-core@0.4.0
  - @statewalker/vcs-working-tree@0.4.0
  - @statewalker/vcs-store-files@0.4.0
  - @statewalker/vcs-store-mem@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core ^0.3.1 -> ^0.3.2
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-store-files@0.3.2
  - @statewalker/vcs-store-mem@0.3.2
  - @statewalker/vcs-transport@0.3.2
  - @statewalker/vcs-utils@0.3.2
  - @statewalker/vcs-working-tree@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/vcs-store-files@0.1.1
  - @statewalker/vcs-store-mem@0.1.1
  - @statewalker/vcs-transport@0.1.1
  - @statewalker/vcs-utils@0.1.1
  - @statewalker/vcs-working-tree@0.1.1
