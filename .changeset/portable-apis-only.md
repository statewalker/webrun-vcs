---
"@statewalker/vcs-utils-node": major
"@statewalker/vcs-utils": patch
"@statewalker/vcs-store-files": patch
---

**Breaking: only portable APIs in the packages.** Files go through `FilesApi` alone; no package source imports a `node:*` module, and a lint rule (`noNodejsModules`, error for `packages/*/src`) keeps it so.

`@statewalker/vcs-utils-node` now only provides the Node `FilesApi` (`createNodeFilesApi`, returning `NodeFilesApi` from `@statewalker/webrun-files-node`). Removed: the `node:zlib` compression (`@statewalker/vcs-utils-node/compression`, `createNodeCompression`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode`; the Web `CompressionStream` default is used everywhere), `StreamingNodeFilesApi`, and `createNodeAtomicFiles` (ref batches use `atomicFilesOver(files, gitDir)`, which excludes writers sharing one `FilesApi`, not other processes such as a running `git`).

`createNodeFilesApi().write` is `NodeFilesApi`'s, which streams from `@statewalker/webrun-files-node` 0.11 (a temporary file, then a rename, as the removed `StreamingNodeFilesApi` did), and lock files use its `createExclusive` (`open "wx"`), so they exclude other processes. `atomicFilesOver` now runs its exclusive creates and empty-directory removals one at a time per FilesApi, and a ref commit blocked by another writer's lock directory waits, then reports `df-conflict` instead of throwing.
