---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-testing": minor
"@statewalker/vcs-utils": patch
---

**The object kernel, `createGitObjects`.** Git objects stored as zlib loose objects over a `StagingBlobStore`, written in one pass (`put(type, size, content)`), received with their id (`putRaw`), and read back checked (`get`, `getRaw`, `has`, `list`, `remove`). New in vcs-core: `GitObjects`, `GitObject`, `CorruptObjectError`, `ObjectIdMismatchError`, `InvalidObjectIdError`, `StagingBlobStore` and `rawStorageStaging`. New in vcs-store-files: `filesStagingStore` (git's `objects/` layout, `sweepStaged`). New in vcs-testing: `createGitObjectsTests` and `gitObjectSamples` (objects written by git). Additive: the typed stores move to it in a later change.

`deflate` (Web streams) now closes its source when the consumer stops early and rethrows the source's own errors unchanged.
