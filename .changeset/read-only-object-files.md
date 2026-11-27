---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

Loose objects and pack-family files (`.pack`, `.idx`, `.rev`, `.bitmap`, `.mtimes`, a multi-pack-index's bitmap and reverse index, incremental midx layers, commit-graphs) are now written 0444 under the umask in repositories that are not shared, as git writes them. The plain `multi-pack-index` and `multi-pack-index-chain` stay under the umask, as git's lock files leave them. `createGitFilesBackend` and the commands' repository FilesApi (repack, gc, maintenance) wrap their FilesApi with the new `withReadOnlyObjectFiles` (`isReadOnlyObjectPath`). Commit-graphs respect the umask (0400 under umask 077, as git). The Node FilesApi's `chmod` is synchronous now (one per loose object written). FilesApis without modes (memory, browser) are unchanged.
