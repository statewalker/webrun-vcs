---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": minor
---

**Breaking: receive-pack quarantines a pushed pack until the push is accepted (git's `tmp_objdir`).**

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
