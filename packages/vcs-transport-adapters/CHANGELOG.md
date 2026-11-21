# @statewalker/vcs-transport-adapters

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core crosses a breaking line
  - @statewalker/vcs-transport crosses a breaking line
  - @statewalker/vcs-utils crosses a breaking line

### Patch Changes

- d84c354: **Tree entry modes read as git reads them (`canon_mode`), everywhere.**
  
  A tree that stores a blob as 100664 (older git wrote it) now reads as 100644, as git's `decode_tree_entry` reads it, so a repository with such trees behaves as with native git: `status` is clean after `reset --hard`, and `merge`, `checkout`, `cherry-pick`, `revert`, `rebase` (patch-ids), `stash`, `reset`, `diff` and `log` no longer see a mode change between 100664 and 100644, or refuse with "local changes would be overwritten".
  
  - **vcs-core:** the tree store's `load`, `entries` and `getEntry` give canonical modes (`canonTreeMode`: a regular file 100644 or 100755 by its owner's execute bit, a symlink 120000, a directory 40000, anything else a gitlink); `raw` still gives the stored bytes, and serializing a stored tree (`SerializationApi`) copies them. `decodeTreeBytes(bytes, { canonicalModes: true })` reads canonical modes (without the option, modes as stored), and `treeModesRewritten(entries)` says whether such a list came from a tree written with other modes (encoding it again makes another tree). fsck keeps reading the modes as stored (`badFilemode` for 100664 under `--strict`).
  - **vcs-working-tree:** the files and git stagings' `writeTree` reuses the directories the index's cache-tree has valid, as git's write-tree does (a tree primed by a reset keeps its stored 100664 modes). `updateCacheTree` computes a directory as the canonical tree its entries make: where the stored tree holds other modes, that tree is valid only if stored (git's `WRITE_TREE_REPAIR`), else invalid.
  - **vcs-commands:** `reset --hard` primes the cache-tree with the target tree (`prime_cache_tree`) and `reset --mixed` keeps it with the changed paths invalid; `stash apply` invalidates the paths it merges. A combined diff's `-U0` hunk header prints a count below zero as git's `%lu` does (`+1,18446744073709551615`), in `diff` and `log --cc`.
  - **vcs-store-sql**, **vcs-transport-adapters:** syncing a tree to the SQL store and an object's size read the stored bytes; the native SQL tree store reads canonical modes.
- 1777896: **Commit-graph walks give a full walk's answers on graphs whose generations cannot be trusted.**
  
  - **vcs-core:** `CommitGraph.generationsTrusted` checks the whole graph once, on first use: generations cut and order walks only when the graph has generation numbers (`generationNumbersEnabled`), every record decodes, none is 0 and each is above its parents'. Otherwise every generation is Infinity (git reads a stored 0 as GENERATION_NUMBER_INFINITY), so `isAncestor`, `findMergeBase` and merge-ort's merge bases are right on graphs with zero levels (git before 2.18), a corrupt record, or corrected dates git 2.43 truncated past 2^32. `getHeader(id, { checkExists: true })` also looks the commit up in the object store (git's GIT_COMMIT_GRAPH_PARANOIA). A graph that fails to load is not loaded again until `invalidate()`. `listObjects` reads its wants, so a missing one throws even when a stale graph lists it. A split write gives the layers it merged away a new mtime, as git's `mark_commit_graphs`, and expires them with one clock read (the default expire time is that same now), so they are always expired as in git. `isAncestor` and `findMergeBase` read one graph for the whole walk: a graph written and loaded while they run is not mixed in (commits outside the walk's graph are read from the object store). `Commits.headerReader()` gives a header reader bound to the graph loaded now. `createGitFilesHistory` takes and exposes the `commitGraph` provider.
  - **vcs-store-files:** `gc` reports a failed commit-graph write in `commitGraphError` and keeps what it did before, as `git gc`. The backend, `gc` and `writeCommitGraph` take an `environment`: the commit-graph settings are then read from the system and global config too. `createGitFilesHistoryFromFiles` passes the backend's commit-graph on (`History.commitGraph`); `FileWorktree` takes an `environment` for the submodules `openGitlink` opens. The backend reloads the graph after its ref store changes the `shallow` file or a replace ref.
  - **vcs-commands:** the merge-base queue is ordered by generation only when the graph trusts them, and one merge-base computation reads one graph (`commitsBaseSource` takes a `headerReader` once). `InitCommand.setEnvironment` passes the host's environment to the repository it opens, so a global `core.commitGraph` is honoured.
  - **vcs-transport-adapters:** `getCommitInfo(oid, { checkExists: true })` does not report a commit that only a stale commit-graph lists; without it (upload-pack's walks) the graph is read unchecked, as git does by default.
  - **vcs-transport:** `RepositoryFacade.getCommitInfo` takes `{ checkExists }`; receive-pack asks for it for the type of a new tip and in its connectivity check.
- 1777896: **Commit-graphs: read, written and verified as git does, and used by history walks.**
  
  On a 5000-commit repository with a graph, a walk of every commit takes 3.5 ms instead of 49 ms, a merge base of distant commits 3 to 5 ms instead of 41 to 48 ms, and an ancestor check about 2 ms instead of 40 ms, level with `git rev-list` and `git merge-base` over the same graph.
  
  - **vcs-core (`history/commit-graph`):** `readCommitGraph` loads `objects/info/commit-graph` or the split chain in `info/commit-graphs/` as git's `commit-graph.c` does (header, chunk table, OIDF, OIDL, CDAT, EDGE, GDA2/GDO2, BIDX/BDAT, BASE; git's checks and messages on load; a broken chain kept up to its last good layer). `CommitGraph` gives each commit's parents, tree, date, topological level and generation (corrected commit date with GDA2) without reading the commit; `bloomMayContainPath` queries its changed-path filters. `writeCommitGraphFile` writes files byte-identical to `git commit-graph write` (`--append`, `--split[=no-merge|replace]`, `--size-multiple`, `--max-commits`, `--expire-time`, `--[no-]changed-paths` with murmur3 hash versions 1 and 2, `--max-new-filters`; GDA2 unless `commitGraph.generationVersion=1`; the filters of an existing graph kept). `verifyCommitGraph` is `git commit-graph verify`. `loadRepositoryCommitGraph` and `commitGraphCompatible` follow git's `prepare_commit_graph`: no graph with `core.commitGraph=false`, replace refs, grafts or a shallow repository.
  - **vcs-core (commits):** `createCommits(objects, { commitGraph })`; `Commits.getHeader` (tree, parents, commit time, generation) and `getParents`, `getTree` and `walkAncestry` read the graph for the commits it has and parse the others (a stale graph is fine). `findMergeBase` is now git 2.56's merge-base (`paint_down_to_common` over a queue ordered by generation then date, with its side-exhaustion exit in the graph; redundant bases removed), returning every merge base, best first, as `git merge-base --all` (it returned the first common ancestor of a depth-first walk). `isAncestor` and the redundancy check skip commits whose generation shows they cannot reach the commit sought. `getMergeBases` and `isAncestorOf` (`commit-reach.ts`) are exported. `History.commitGraph` is the provider; `listObjects` takes a `commitHeader` lookup.
  - **vcs-store-files:** the files backend reads the repository's graph on first use. `writeCommitGraph` is `git commit-graph write --reachable` (or from given commits) in a repository; `readCommitGraphSettings` reads the config. `gc` writes the graph at the end when `gc.writeCommitGraph` is true (the default), as `git gc`, and its reachability walk reads commits from the graph.
  - **vcs-commands:** `fsck` verifies the commit-graph as git's fsck runs `git commit-graph verify` (exit bit 16, `FSCK_ERROR_COMMIT_GRAPH`). merge, rebase, pull, octopus and merge-ort's virtual bases use the store's walks and the graph's generations (the merge-base queue ordered by generation when the graph has corrected dates, as git orders it).
  - **vcs-transport-adapters:** upload-pack and receive-pack walks read commits from the graph.
- de6af72: **Fetch and clone check what they received, as git does.**
  
  - **vcs-transport:** `fetchFromConnection` runs git's `check_connected` before it writes any ref: every new ref tip must reach only objects that are here, down to the existing refs and the alternates' refs (`connectivityErrors`, receive-pack's walk, so a fetch on top of a branch reads only what it brought). A deepening fetch is checked against its new shallow commits before the shallow file changes; a clone checks the refs it writes, except those in a pack index-pack found self-contained. A failure throws `FetchCheckError` with rev-list's lines (`fatal: bad object`, `error: Could not read`, `fatal: bad tree object`, `fatal: missing blob object`). `FetchClientOptions.fsckObjects` runs index-pack's `--strict` over each received pack (imported into a quarantine, so a refused pack leaves nothing behind): fsck of every object and every named object received or present (`fatal: did not receive expected object`), as a clone's `--check-self-contained-and-connected` also does. `RepositoryFacade.loadObject` reads an object's content, `PackImportOptions.onObject` reports each received object, and commits and tags the typed stores refuse are walked as git parses them (`lenientCommitHeader`, `lenientTagTarget`).
  - **vcs-core:** pack imports report every received object with its place in the pack (`onObject` of `importPack`, `installPack` and `SerializationApi.importPack`: whole entries first, then deltas).
  - **vcs-commands:** `git fetch` fails with git's `error: <url> did not send all necessary objects` (exit 1) and `git clone` with `fatal: remote did not send all necessary objects` when a server leaves history out, writing no ref. `fetch.fsckObjects` / `transfer.fsckObjects` (or `FetchCommand.setCheckFetchedObjects`) check received objects with `fetch.fsck.<msg-id>` severities and `fetch.fsck.skipList` (`fetchFsckOf`), in git's words (`error: object <id>: <msg-id>: <message>`, `fatal: fsck error in packed object`, `fatal: index-pack failed`). `FetchCommand.setCompatibility` picks 2.43's or 2.5x's output.
  - **Received links read in memory:** pack imports report the content of every received commit, tree and tag while they hold it (`onContent` of `importPack`, `installPack`, `unpackObjects`, `SerializationApi.importPack` and `PackImportOptions`), and the fetch client checks index-pack's links from it (`ReceivedLinks`) instead of reading every object back: a clone's self-contained check of 219k objects takes 30 ms instead of 4 s. An import into a quarantine opens none for an empty stream, and a fetch discards its quarantine on any failure before the commit (a response error after the pack included). fsck reads only the blobs it checks (`ReceivedObjectsFsck.wantsBlob`). Lenient commit/tag reads ask the object's type first (`storedObjectType`) and are used by `VcsRepositoryFacade.getCommitInfo` with a commit-graph too; `VcsRepositoryFacade.getObjectType` reads the object header. `fetch.fsck.*` is read in config order where the config lists its variables (`RemoteConfigStore.entriesWithPrefix`): unknown ids give git's `warning: Skipping unknown msg id '<id>'`, the first demoted fatal id dies, and a `fetch.fsckObjects`/`transfer.fsckObjects` that is no boolean dies with `fatal: bad boolean config value`.
- Updated dependencies [d5158af]
- Updated dependencies [d84c354]
- Updated dependencies [d84c354]
- Updated dependencies [05a5cae]
- Updated dependencies [9517fc9]
- Updated dependencies [1777896]
- Updated dependencies [1777896]
- Updated dependencies [20c317e]
- Updated dependencies [21d6866]
- Updated dependencies [e1c44ca]
- Updated dependencies [457680a]
- Updated dependencies [7f697fd]
- Updated dependencies [4e839be]
- Updated dependencies [257e9cf]
- Updated dependencies [de6af72]
- Updated dependencies [a8df903]
- Updated dependencies [0a39cdc]
- Updated dependencies [57846c3]
- Updated dependencies [f078ebd]
- Updated dependencies [5863bf1]
- Updated dependencies [35239a9]
- Updated dependencies [32f7288]
- Updated dependencies [53ecad0]
- Updated dependencies [bbf5ca1]
- Updated dependencies [df0147c]
- Updated dependencies [c72622c]
- Updated dependencies [54f881d]
- Updated dependencies [7314646]
- Updated dependencies [8329312]
- Updated dependencies [2ce29f8]
- Updated dependencies [2ce29f8]
- Updated dependencies [2d0759a]
- Updated dependencies [c80355f]
- Updated dependencies [7314646]
- Updated dependencies [c3ee332]
- Updated dependencies [bd31e0f]
- Updated dependencies [9e462a8]
- Updated dependencies [1efa875]
- Updated dependencies [98be9b5]
- Updated dependencies [87d6d55]
- Updated dependencies [af93342]
- Updated dependencies [d489ee7]
- Updated dependencies [d489ee7]
- Updated dependencies [2796b2d]
- Updated dependencies [7c63add]
- Updated dependencies [68ef504]
- Updated dependencies [9234799]
- Updated dependencies [32ab2c4]
- Updated dependencies [68c571d]
- Updated dependencies [f745816]
- Updated dependencies [b7426bc]
- Updated dependencies [d676bf4]
- Updated dependencies [65e2515]
- Updated dependencies [68cedb7]
- Updated dependencies [f0d8ddd]
- Updated dependencies [0b1ccae]
- Updated dependencies [eb5ad83]
- Updated dependencies [8a603c0]
- Updated dependencies [b31fadc]
- Updated dependencies [5558be8]
- Updated dependencies [c80355f]
- Updated dependencies [35239a9]
- Updated dependencies [0798366]
  - @statewalker/vcs-utils@0.6.0
  - @statewalker/vcs-core@0.6.0
  - @statewalker/vcs-transport@0.6.0

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core crosses a breaking line
  - @statewalker/vcs-transport crosses a breaking line
  - @statewalker/vcs-utils crosses a breaking line

### Patch Changes

- 3292f46: **upload-pack honours `include-tag` and negotiates over v0 as git does, both servers hide refs as git's `hideRefs`, upload-pack gets hooks, and the fetch client gzips large requests.**
  
  - **vcs-transport, v0 negotiation (fix):** upload-pack answers haves exactly as git's `get_common_commits`: `ACK <oid> common` / `continue` / `ready` while a batch is read (`ready` also without no-done, once every want reaches a common commit), NAK at the end of every batch in the multi_ack modes, the final `ACK <oid>` on `done`, and with no-done after `ready` NAK and the final ACK before the pack. Before, a batch that found a common commit was answered without NAK, and a later batch with nothing new got no answer: our fetch client failed with "Expected ACK/NAK, got a flush" and native git with "expected ACK/NAK, got '?PACK'" (a stale remote-tracking ref plus many local commits over v0). In single-ack mode the server now waits for `done` after its ACK, as git. `multi_ack` is advertised again (git advertises both `multi_ack` and `multi_ack_detailed`).
  
  - **vcs-core:** `listObjects` takes `includeTags` (candidate tag ids) and `ExportOptions.includeTags` passes it from `SerializationApi.exportPack`: as `git pack-objects --include-tag`, each annotated tag peeling to a packed object is added after the other objects, with every tag of its chain. Only tag objects are read: a listed target, a lightweight tag of a listed object and an object the walk met cost no read.
  - **vcs-transport, include-tag:** upload-pack (v0/v1 and v2) adds the annotated tags of packed objects when the client asks for `include-tag`, so a client no longer needs a second fetch to backfill them. The candidates are the visible `refs/tags/*` (a hidden tag is never sent; git's pack-objects ignores hideRefs). `ExportPackOptions.includeTags` carries them to the facade; `includeTag: true` without it uses the facade's own `refs/tags/*` (both `createRepositoryFacade` and vcs-transport-adapters' `VcsRepositoryFacade`).
  - **vcs-transport, hidden refs:** new `hideRefs` (git's `transfer.hideRefs`) on `serveOverDuplex`, `createHttpHandler`, `createGitHttpServer`, `createFetchHandler` and `messagePortServe`, plus upload-pack's (`uploadPack.hideRefs` / `uploadPackHideRefs`, git's `uploadpack.hideRefs`) and receive-pack's (`receivePack.hideRefs` / `receivePackHideRefs`, git's `receive.hideRefs`), with git's pattern rules (`isRefHidden`: component prefixes, `!` negation, `^` full names, last match wins). Hidden refs are left out of the v0 advertisements and v2 `ls-refs`; a want of a hidden tip is `not our ref` under the "ADVERTISED" policy ("TIP" and the reachable policies count hidden tips, as git's `allow*SHA1InWant`); a v2 `want-ref` of one is `unknown ref <name>`; receive-pack refuses changing one (`deny updating a hidden ref`, `deny deleting a hidden ref`) after the connectivity check, as git. `handleGitSocketConnection` passes the hidden refs and both services' hooks through. **Hiding refs is not access control**, as in git: hidden history stays fetchable by id under the "ANY" (v2's default), "TIP" and reachable policies, and HEAD naming a hidden branch is still advertised.
  - **vcs-transport, upload-pack hooks:** new `UploadPackHooks` (`uploadPack.hooks` on the HTTP handlers, `uploadPackHooks` on `serveOverDuplex`, `hooks` on `messagePortServe`): `authorize(request, ctx)` sees the wants, every ref whose tip they name (hidden ones included), the `want-ref`s, the haves of a v2 request, a copy of the capabilities and the shallow/deepen arguments (`depth`, `deepenSince`, `deepenNot`, `filter`) before any negotiation or pack byte, and may refuse with `ERR <message>`; it runs on every request, so once per round over stateless HTTP. A want need not be a tip (a parent under "ANY" or the reachable policies), so a hook guarding refs must check reachability or keep "ADVERTISED". `postUpload(result, ctx)` runs detached once a pack was sent.
  - **vcs-transport, v2:** `ls-refs peel` fully peels a chain of tags (was one level); an unknown `want-ref` reads git's `unknown ref <name>` (was `Unknown ref: <name>`).
  - **vcs-transport, fetch client:** upload-pack request bodies over 1024 bytes (large have-batches) are sent with `Content-Encoding: gzip`, as git's remote-curl, where `CompressionStream` exists. `gzipRequests: false` (`fetch`, `openHttpConnection`) turns it off, for browsers behind a CORS proxy that does not allow `Content-Encoding` (not a CORS-safelisted header).
  - **vcs-commands:** `TransportCommand.setGzipRequests(false)` passes that to the fetch and clone commands.
  - **vcs-workspace:** `createSyncServer` takes `hideRefs` and `uploadPackHooks`.
- Updated dependencies [7d77bf8]
- Updated dependencies [875db86]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [01d2219]
- Updated dependencies [3818fee]
- Updated dependencies [3292f46]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [f474fe0]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-utils@0.5.0
  - @statewalker/vcs-transport@0.5.0
  - @statewalker/vcs-core@0.5.0

## 0.4.0

### Minor Changes

- 44b3105: **Breaking: one ref interface, `Refs`.**
  
  - **vcs-core removals:** the legacy `RefStore` interface, its `RefStoreLocation` alias (use `RefStorage`), `RefsAdapter` and `createRefsAdapter`.
  - **`createHistoryFromComponents`:** `refs` is now `{ type: "memory" }` or any `Refs` implementation, used as is. It replaces `{ type: "adapter", refStore }`. Anything else, including a stale `{ type: "adapter", … }` from untyped JavaScript, throws at runtime.
  - **vcs-store-files:** `FileRefStore` implements `Refs` directly. `delete(name)` is now `remove(name)`.
  - **vcs-commands:** `CheckoutCommandOptions.refs` is a `Refs`.
  - **Ref updates through `Refs`, on every backend:**
    - **Creates and updates** behave as before: one atomic command, `oldId` null meaning "must not exist".
    - **Deletes** are now one atomic command too. They remove the named ref itself (for a symbolic ref, not its target), check `oldId` when it is given, and return `false` for a missing ref.
    - **Names** outside `refs/` and `HEAD` are refused.
- d04f62d: **Breaking: receive-pack behaves like git's receive-pack.c (P3.4).**
  
  - **Connectivity check** (git's `check_connected`): after the pack is imported, every object a new tip needs (commits, trees, blobs, tags) must be present, walking down to what the existing refs reach. A broken tip gets `ng <ref> missing necessary objects`; the other refs go on. One analysis per push (`PushConnectivity`): a walk from the new tips that stops at the ref tips, then, only when something is wrong or old history is reached, git's `limit_list` over a binary heap; every command's verdict comes from that one walk. New `checkConnectivity`, `findNewCommits`, `PushConnectivity` and `isAncestorOf` (the fast-forward check, cut off below the old tip's date with a full-walk fallback). The facade gains optional `getObjectType`, `getTreeEntries`, `getTagInfo`, `isBare` and `updateShallow`, and `CommitGraphInfo.tree`. `createRepositoryFacade` and `VcsRepositoryFacade` implement all but `updateShallow` (vcs-core has no shallow store), and take `bare` (default true) for `isBare`; without the walk methods only the tips' presence is checked.
  - **git's per-ref checks and texts:** `funny refname` (one level allowed for deletes), a branch must point at a commit (`failed to update ref`), `deletion of the current branch prohibited` (`receivePack.denyDeleteCurrent`), `branch is currently checked out` for a non-bare repository (`bare: false`), `deletion prohibited`, `bad ref`, stale old values `failed to update ref` (was `remote ref changed since fetch`), the same ref twice (`failed to update ref`, atomic: `atomic transaction failed`), deleting a missing ref is ok, shallow pushes `shallow update not allowed` unless `shallowUpdate`, a failed unpack is `unpacker error` for every command. With side-band, git's `error:` lines explain refusals on channel 2.
  - **Hooks** (`ReceivePackHooks`): `authorize(commands, ctx)` runs before the pack is read (smart HTTP answers 403 for a push refused as a whole, without reading the body), `preReceive(commands, ctx)` (`pre-receive hook declined`), per-ref `update(refName, oldOid, newOid, ctx)` (`hook declined`), and `postReceive(commands, ctx)`, now started after the report is written, detached (failures logged). Wired through `serveOverDuplex({ hooks })`, `createHttpHandler`/`createGitHttpServer`/`createFetchHandler({ receivePack: { hooks } })` and `handleReceivePack`. `preReceive`'s second argument is now the hook context (`ctx.pushOptions`), and `ServerPushHooks` is `ReceivePackHooks`.
  - **Streamed smart-HTTP answer:** POST /git-receive-pack answers with its head once the commands are read and authorized, sends side-band keep-alives while the push is checked (`keepAliveMs`, git's `receive.keepAlive`), then the report. Failures before the head are HTTP statuses (400 malformed / too many commands, 403, 413); after it, they are reported in band.
  - **Limits:** `maxCommands` (default 65536), the request body limit, an idle timeout (`idleTimeoutMs`; HTTP default 10 min, cancelling the body: `readStreamWithIdleTimeout`; no overall deadline), `shallow` lines parsed. `quiet` suppresses progress; no report unless the client asks `report-status`. report-status-v2 stays unadvertised. A pack refused after the HTTP head is drained (bounded by the body limit), so the client reads its report.
  - **Current branch:** `bare` option, else non-bare when the caller passes `currentBranch`, else the facade's `isBare()`, else bare. Deleting an existing ref with the zero id as old value deletes it (git: "allowing deletion of corrupt ref"). An accepted shallow push records only the shallow commits the refs did not reach already.
  - **Hook failures** stay on the server: a throwing `authorize` is a generic 500 over HTTP (`authorization failed` for every ref elsewhere), throwing `preReceive`/`update` hooks send only `pre-receive hook error` / `update hook error`; details go to the logger.
  - **Client fixes:** the duplex push client reads the side-band report as git frames it (and skips keep-alives); `pushOverDuplex` returns `refStatus` per ref and fails when a ref was refused. `mapRejectReason` understands git's deletion and checked-out-branch texts.
  - FSM: states `CHECK_DELETE_ALLOWED` and `REJECT_COMMANDS` are gone; new `AUTHORIZE`; the order is git's (connectivity, pre-receive, per-ref checks with the update hook, ref transaction, report, post-receive).
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
- e77be2f: **Breaking: `RepositoryAccess` is removed.** Fetch, push and serve run on `RepositoryFacade`, whose `exportPack` and `importPack` stream; `RepositoryAccess` was on no live path and its implementations held whole objects in memory.
  
  - **vcs-transport removals:** the `RepositoryAccess` interface and its `ObjectInfo`, `RefInfo` and `HeadInfo` types, plus the `ObjectId` and `ObjectTypeCode` re-exports that came with them (import those from `@statewalker/vcs-core`).
  - **vcs-transport-adapters removals:**
    - `createVcsRepositoryAccess`, `VcsRepositoryAccess`, `VcsRepositoryAccessConfig`;
    - `createCoreRepositoryAccess`, `CoreRepositoryAccessOptions`, `GitNativeRepositoryAccess`, `DeltaAwareGitNativeRepositoryAccess`, `ObjectStoreAccess`, `DeltaAwareRepositoryAccess`, `DeltaAwareStore`, `RepositoryObjectInfo`, `ObjectData`;
    - `createStorageAdapter`, `MinimalStorage`;
    - `createObjectGraphWalker`, `ObjectGraphWalker`;
    - `createGitWireFormat`, `parseGitWireFormat`, `stringToObjectType`, `objectTypeToString`.
  - **Migration:** use `createVcsRepositoryFacade({ history, serialization })` (or `createStorageRepositoryFacade`) for objects and packs, `createTransportRefStore(refs)` from `@statewalker/vcs-transport` for refs, and the `History` API for per-object reads.
- 60dd7da: **Breaking: every store reads and writes objects through the object kernel (`GitObjects`).**
  
  Removed: `GitObjectStore`, `GitObjectStoreOptions`, `createGitObjectStore`, `GitObjectHeader`, `loadWithHeader`, `VolatileStore`, `VolatileContent`, `MemoryVolatileStore` (vcs-core); `FileVolatileStore` / `createFileVolatileStore` (vcs-store-files); `createGitObjectStoreTests` and `createVolatileStoreTests` (vcs-testing). Replace `createGitObjectStore(raw)` with `createGitObjects(rawStorageStaging(raw))`, and for a `.git/objects` directory use `createGitObjects(filesStagingStore(files, objectsDir))`.
  
  - `createBlobs`, `createTrees`, `createCommits`, `createTags` and `createHistoryFromComponents({ objects })` take a `GitObjects`; `createMemoryObjectStores`, `createKvObjectStores` and `createSqlObjectStores` return one as `objects`.
  - `Blobs.store(content, size?)`: with a size, the blob is written in one pass without being buffered.
  - `createGitFilesBackend` builds its objects as `withPacks(createGitObjects(skipPacked(filesStagingStore(...), packs)), packs)`: reads try loose objects, then packs, and an object already packed is not written again (as git and JGit). gc and repack ignore anything in `objects/` that is not an object file, such as git's `objects/ab/tmp_obj_*` in flight.
  - The typed stores' `remove` still returns false for a string that is not an object id; `GitObjects.remove` throws `InvalidObjectIdError` for one.
  - Stored bytes: the memory, KV and SQL object stores (and the `BlobStore` behind `createVcsCore` and `createStorageRepositoryFacade`) now hold zlib loose objects, as `.git/objects` does. Data those stores persisted before is not readable; re-import from a git remote.
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

- 07ace72: **Breaking: one pack importer, byte for byte and streamed.**
  
  - **New in vcs-core:** `unpackObjects(objects, pack, options?)` is git's `unpack-objects`. It reads the stream once, writes every object as a loose object exactly as git frames it, resolves OFS and REF deltas (thin packs from the objects the store has), bounds memory (`baseCacheBytes`, `bigObjectThreshold`), refuses corrupt packs with `PackError` and an object stored under the same id with other bytes with the new `ObjectCollisionError`. `importPack(objects, pack, { packs, unpackLimit })` keeps a pack of at least `unpackLimit` objects (default 100, git's `transfer.unpackLimit`) through `packs.install` and unpacks smaller ones, deciding from the pack header only. Also new: `DEFAULT_UNPACK_LIMIT`, `UnpackTarget`, `UnpackObjectsOptions`, `UnpackResult`, `ImportPackOptions`, `ImportPackResult`, and `InstalledPack.types`.
  - **History:** `History.objects` (the object kernel) and `History.packs` (the files backend's `PackSet`), both optional; `createHistoryFromStores`, `createHistoryFromComponents`, `createGitFilesHistory` and `createGitFilesBackend` set them.
  - **Everything delegates:** `SerializationApi.importPack`, `VcsCore.readPack`, the commands' clone and fetch, and the transport's receive paths go through `importPack`, over the history's object kernel. Commits and tags keep headers the parsers do not model; `SerializationApi.importPack` used to drop them and store the object under another id. The server receive path (`createStorageRepositoryFacade` in vcs-transport-adapters, and the HTTP server demo) now passes its kernel as `objects`, so a pushed commit with a `mergetag` header is stored byte for byte. A history with typed stores only (the SQL native stores) is written through them: an object they would re-encode is refused with `ObjectIdMismatchError` before anything is stored. `PackImportResult.blobsWithDelta` is always 0 and `packId` names a kept pack.
  - **Removed:** `SerializationApi.parseLooseObject` (inflate and `objects.putRaw` instead), `SerializationApi.createPackReader`, `PackReaderApi`, `PackEntry`, `PackHeader`, `ParsedObjectMeta`, `SerializationApiConfig.blobDeltaApi`/`treeDeltaApi`/`commitDeltaApi`, `parsePackEntries`, `parsePackEntriesStream`, `parsePackEntriesFromStream`, `indexPackFromStream`; in vcs-utils `PackObjectCache` and `MemoryPackObjectCache`; in vcs-transport `BufferWriter` and `createHttpClientDuplex`.
  - **Streaming fetch (vcs-transport):** `fetch` and `clone` take `onPack(pack)`, which receives the pack demultiplexed from the response body as it arrives (`packData` is then empty). The new `sidebandPackStream(body, { onProgress })` is that demultiplexer (an `ERR` line or channel 3 throws `ServerError`); `httpFetch` and the fetch state machine stream the pack into `importPack` the same way instead of collecting it. A fetch that sent wants and received no pack now fails instead of reporting success, so no refs are written to missing objects; a failed import cancels the response body (`readableStreamToAsyncIterable` cancels a stream it stops reading early). `fetch`'s `timeout` now bounds each wait for the server rather than the whole fetch, so a slow store does not abort a large clone.
  - **vcs-commands:** `importPackIntoHistory` takes a stream; clone and fetch import the pack while it downloads.
- 08309ab: **Large blobs in one pass.** A blob stored with its size streams from its source to `FilesApi.write` holding about one chunk (a FilesApi whose `write` streams keeps it so to the disk). The loose-ref reader skips dot-names, as git does. both add commands (`git.add()` and the core `AddCommand`) pass the worktree size of regular files (and collect a file that changed while being read; symlinks are collected), and merge, pack import, transport and conflict resolution pass the sizes of the buffers they already hold. `gc()` removes `tmp_obj_*` temporaries older than two weeks (`tmpExpiryMs`, `removedTemporaries`), as `git prune` does. A benchmark (`pnpm --filter @statewalker/vcs-store-files test:bench`, with a streaming FilesApi of its own) stores 200 MB with live memory under 64 MB and checks it with `git fsck`.
- c9bfe06: **Receive-pack applies pushes through `Refs.batch`, as git's receive-pack applies them in a ref transaction.** This happens when the transport `RefStore` has the new optional `batch`.
  - **Atomic push:** it is one batch, so every ref changes or none does. Before, it was a sequence of writes with a best-effort rollback.
    - If the batch is refused, every ref gets `atomic transaction failed`.
    - If validation or a hook already rejected a ref, nothing is applied and the others get `atomic push failure` (previously the rest were applied).
    - A store whose batch answers `unsupported` for several refs (such as `kvStoreRefs`) keeps the one-by-one path.
  - **Plain push:** it is one batch per ref.
  - **Old values:** every update checks the old id the client sent. A ref moved since the advertisement is refused with `failed to update ref`, where before it was silently overwritten.
  - **Failures:** a store failure is reported per ref instead of ending the session without a report.
  
  **Changed:** receive-pack refuses ref names outside `refs/` (including `HEAD`) and invalid names with `funny refname`, as git does. It names refs directly and does not follow symbolic refs. The client maps `failed to update ref` to `LOCK_FAILURE`.
  
  **New:** `createTransportRefStore(refs)` adapts a vcs-core `Refs`, including `batch`; its `listAll` also lists symbolic refs, such as `HEAD`, by their resolved ids. vcs-transport-adapters' `createStorageRepositoryFacade` uses it, as do the demo apps and test helpers, which used to carry their own copies.
  
  **Fixed:** a push deleting a ref through these adapters no longer stores the zero id as the ref's value; the ref is removed.
- 081386c: **upload-pack behaves as git's: "not our ref", ok_to_give_up, shallow fetches over protocol v2; smart-HTTP takes gzip bodies and limits their size.**
  
  - **Protocol v2 `fetch`:**
    - A want that is no tip and no commit reachable from one is refused with `ERR upload-pack: not our ref <oid>` (git's `uploadpack.allowReachableSHA1InWant`). Before, any object the repository held was served. `serveOverDuplex` takes `requestPolicy`; `"ANY"` serves any object, as git's own v2 does.
    - Negotiation follows `upload-pack.c`: `ready` only once every want reaches a common commit (`ok_to_give_up`), never with `wait-for-done`; `NAK` when nothing is common; no acknowledgments section after `done` or without haves (real git clients failed on it).
    - Shallow: `deepen`, `deepen-relative`, `deepen-since`, `deepen-not`, client `shallow` lines and unshallowing (`--deepen`, `--unshallow`) answer a `shallow-info` section, and the pack is cut at the boundary. `shallow-info` was always empty and depth ignored.
    - `filter` is no longer advertised (no partial clone), and a `filter` request is refused; with custom `capabilities` that advertise it, the filter is passed to `exportPack` as `filterSpec`.
    - `deepen-since` 0 or negative is refused (`Invalid deepen-since`), and a `deepen-not` matching no ref or several refs is refused as ambiguous, as git's `expand_ref`. `wanted-refs` lists only the current `fetch` command's `want-ref`s.
  - **Protocol v0/v1 upload-pack:** the refusal reads `upload-pack: not our ref <oid>`; the default advertisement drops `filter`, lists `allow-tip-sha1-in-want`/`allow-reachable-sha1-in-want` only when the request policy allows them, and `deepen-since`/`deepen-not`/`deepen-relative` when the repository facade implements `getCommitInfo`. Shallow requests go through `computeShallowUpdate`, as in v2: a shallow clone can be deepened (`fetch --depth`, `--unshallow`; real git failed with "remote did not send all necessary objects"), unshallowed commits are sent with their history, and a shallow client that does not deepen gets no shallow section (git reads none). `ok_to_give_up` is git's commit-graph walk here too. `computeShallowSince`/`computeShallowExclude` are no longer called; an invalid `deepen` line is answered with `ERR`.
  - **`ok_to_give_up`** walks each commit once for all wants (as git's `can_all_from_reach_with_flag`; it rewalked shared history per want), and always walks a want whose date is older than the oldest common commit.
  - **Without `getCommitInfo`**, deepening a shallow client is refused (it could not be unshallowed, leaving the client with missing objects).
  - **`RepositoryFacade`:** new optional `getCommitInfo(oid)` (parents and committer time) for these walks; `createRepositoryFacade` implements it and `computeShallowBoundaries`. New exports `findUnreachableWant`, `okToGiveUp`, `computeShallowUpdate`, `notOurRef`, `defaultUploadPackCapabilities`.
  - **Protocol v2 client:** each request resends the commits found common, and sends `done` once it has no new haves (it looped when the server was never ready).
  - **Smart-HTTP server:** `Content-Encoding: gzip` request bodies are inflated (`DecompressionStream`), other encodings get 415; `maxRequestBodyBytes` (default 10 MiB for upload-pack, 1 GiB for receive-pack, counted after inflating and, for gzip, on the compressed bytes too) answers 413; at the limit the body stream is cancelled. An upload-pack request is read whole before upload-pack runs (as git's http-backend), so an over-limit one is always a 413, never a cut-short 200. receive-pack no longer advertises `report-status-v2`, which it never wrote.
  - **vcs-transport-adapters:** `VcsRepositoryFacade.computeShallowBoundaries(wants, depth)` returns git's boundary (`depth` commits deep; it was one deeper), and the facade implements `getCommitInfo`.
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
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
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

## 0.3.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-transport@0.3.2
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/storage@0.1.1
  - @statewalker/vcs-transport@0.1.1
  - @statewalker/vcs-utils@0.1.1
