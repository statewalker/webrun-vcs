---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-utils": minor
---

Progress callbacks for local commands (statewalker/statewalker-root#365): `GitCommand.setProgress(monitor)` reports a command's long local phases as `--progress` makes git print them, JGit's `ProgressMonitor` style (`{ phase, done, total?, finished }`, vcs-utils `ProgressMonitor`/`startProgress`). Checkout and clone's checkout report "Updating files"; repack and gc "Enumerating objects", "Counting objects", "Compressing objects", "Writing objects" and "Removing duplicate objects" (`writePack({ progress })`, the store's `repack`/`gc` `progress`); index-pack "Receiving objects" (or "Indexing objects") and "Resolving deltas" (`installPack({ progress, progressTitle })`, `importPack`, fetch and clone through `FetchClientOptions.progress`); fsck "Checking object directories", "Checking objects", "Verifying reverse pack-indexes" and "Checking connectivity". "Compressing objects" counts pack-objects' delta candidates (`should_attempt_deltas`), as git's total does; gc's commit-graph phases and cruft packs are not reported. A monitor that throws cancels the command, leaving the repository as an interrupted git leaves it. fsck's 2.43 compatibility now checks `.rev` files and bitmaps before the connectivity walk, as git 2.43 does.
