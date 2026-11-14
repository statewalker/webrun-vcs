---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-testing": minor
"@statewalker/vcs-utils": patch
---

**The object kernel, `createGitObjects`.** Git objects stored as zlib loose objects over a `StagingBlobStore`, written in one pass (`put(type, size, content)`), received with their id (`putRaw`), and read back checked (`get`, `getRaw`, `has`, `list`, `remove`). New in vcs-core: `GitObjects`, `GitObject`, `CorruptObjectError`, `ObjectIdMismatchError`, `InvalidObjectIdError`, `StagingBlobStore`, `rawStorageStaging`, and a re-export of `SizeMismatchError`. New in vcs-store-files: `filesStagingStore` and `FilesStagingStore` (git's `objects/` layout, `sweepStaged`). New in vcs-testing: `createGitObjectsTests` and `gitObjectSamples` (objects written by git). Additive: the typed stores move to it in a later change.

`deflate` (Web streams): input is pulled with backpressure, a consumer that stops early closes the source without waiting for a stalled one, the source's own errors come out unchanged and compressor errors as `CompressionError`.
