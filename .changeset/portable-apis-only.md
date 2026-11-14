---
"@statewalker/vcs-utils-node": major
"@statewalker/vcs-utils": patch
"@statewalker/vcs-store-files": patch
---

**Breaking: only portable APIs in the packages.** Files go through `FilesApi` alone; no package source imports a `node:*` module, and a lint rule (`noNodejsModules`, error for `packages/*/src`) keeps it so.

`@statewalker/vcs-utils-node` now only provides the Node `FilesApi` (`createNodeFilesApi`, returning `NodeFilesApi` from `@statewalker/webrun-files-node`). Removed: the `node:zlib` compression (`@statewalker/vcs-utils-node/compression`, `createNodeCompression`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode`; the Web `CompressionStream` default is used everywhere), `StreamingNodeFilesApi`, and `createNodeAtomicFiles` (ref batches use `atomicFilesOver(files, gitDir)`, which excludes writers sharing one `FilesApi`, not other processes such as a running `git`).

Two things now wait for `@statewalker/webrun-files(-node)`: a streaming `write` (the Node `FilesApi` collects a file before writing it, so a large object is held in memory once on Node), and an exclusive create for lock files across processes.

`createNodeFilesApi().write` is `NodeFilesApi`'s: it collects the content, then writes the file in place (no temporary and rename), so a crash mid-write can leave a truncated file where the removed streaming write left the old one. `atomicFilesOver` now runs its exclusive creates and empty-directory removals one at a time per FilesApi, and a ref commit blocked by another writer's lock directory waits, then reports `df-conflict` instead of throwing.
