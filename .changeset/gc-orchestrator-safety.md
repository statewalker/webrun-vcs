---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

**`GcOrchestrator` no longer deletes reachable history: a corrupt or missing reachable object aborts the run, and it keeps what git keeps (HEAD, the index, reflogs, linked worktrees, recent objects).**

- **vcs-core (data loss fix):** `collectReachableObjects` throws `CorruptObjectError` for a reachable object that is stored but cannot be read or decoded, on the object kernel and on the typed-store fallback, instead of treating it as absent (which cut the walk and let gc prune everything behind it). The typed stores' `has()` throws `CorruptObjectError` for such an object instead of returning false. A new third argument (`CollectReachableOptions`) makes an absent reachable object throw `MissingObjectError` (`missing: "throw"`) and names the shallow commits, whose parents may be absent. Commits are walked by their tree and parent lines only, and gitlinks are not followed.
- **vcs-core (gc roots):** `GcOrchestrator` walks strictly from every ref, HEAD, the old and new ids of the refs' reflogs, and the roots a strategy adds (`GcStrategy.collectRoots`); unreachable objects the strategy reports as recent (`GcStrategy.recentObjects`, new `GcRunOptions.pruneExpireMs`, default two weeks as git's `gc.pruneExpire`) are kept with everything they reach. `GcRunResult.keptRecentObjects` counts them.
- **vcs-store-files:** `FileGcStrategy` gives the orchestrator the roots `gc()` uses (`collectReachabilityRoots`) and the ages of loose objects, so unreachable loose objects younger than `pruneExpireMs` survive (pass `pruneExpireMs: 0` for `--prune=now`). `collectReachabilityRoots` now also keeps the trees of the index's cache-tree, the blobs of its resolve-undo, and the commits pseudo-refs name (`MERGE_HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, ...), in the repository and in each linked worktree. `gc()` and `repack()` stop at the shallow boundary instead of failing on a shallow clone's absent parents.
