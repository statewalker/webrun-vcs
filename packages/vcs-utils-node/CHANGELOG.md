# @statewalker/vcs-utils-node

## 0.4.0

### Minor Changes

- ee92812: **Breaking: only portable APIs in the packages.** Files go through `FilesApi` alone; no package source imports a `node:*` module, and a lint rule (`noNodejsModules`, error for `packages/*/src`) keeps it so.
  
  `@statewalker/vcs-utils-node` now only provides the Node `FilesApi` (`createNodeFilesApi`, returning `NodeFilesApi` from `@statewalker/webrun-files-node`). Removed: the `node:zlib` compression (`@statewalker/vcs-utils-node/compression`, `createNodeCompression`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode`; the Web `CompressionStream` default is used everywhere), `StreamingNodeFilesApi`, and `createNodeAtomicFiles` (ref batches use `atomicFilesOver(files, gitDir)`, which excludes writers sharing one `FilesApi`, not other processes such as a running `git`).
  
  `createNodeFilesApi().write` is `NodeFilesApi`'s, which streams from `@statewalker/webrun-files-node` 0.11 (a temporary file, then a rename, as the removed `StreamingNodeFilesApi` did), and lock files use its `createExclusive` (`open "wx"`), so they exclude other processes. `atomicFilesOver` now runs its exclusive creates and empty-directory removals one at a time per FilesApi, and a ref commit blocked by another writer's lock directory waits, then reports `df-conflict` instead of throwing.
- c2c944f: **New (vcs-utils):** `createInflater({ raw? })` is a push inflater that reports exactly where each zlib or raw-deflate stream ends: each push returns `{ out, done, consumed }`. `abort()` gives a stream up without an error. States are pooled, as in JGit's InflaterCache. `createInflaterPool()` creates a private pool. `TruncatedStreamError` and `InflateError` extend `CompressionError`.
  
  **Changed (vcs-utils):** `decompressBlockPartial` now throws `TruncatedStreamError` on truncated input; before, it returned short data with no error. `BufferedByteReader.readCompressedObject` and `readDecompressed` now pull and inflate each chunk once, where before they retried the whole buffer. They report corruption as `InflateError` rather than as missing data, and `readDecompressed` yields large objects in pieces. Breaking out of `readDecompressed` early is safe: the rest of the block is skipped. This fixes a size mismatch on large objects that arrive in small chunks.
  
  **Breaking (vcs-utils-node):** `decompressBlockPartialNode` is removed (its binary search ran log2(n) inflates per object); the portable path is exact and takes one pass.
- 46f2a01: **Move to `@statewalker/webrun-files` 0.12 and webrun-sync 0.3.** webrun-files, -browser, -mem and -node go from ^0.11.0 to ^0.12.0. webrun-storage, -content-store, -content-transfer and -files-sync go from ^0.2.0 to ^0.3.0, which are their releases on webrun-files 0.12. Both are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. Consumers must move to webrun-files 0.12 too, so a single copy of the core is installed.
  
  - **vcs-store-files:** `GitResolutionStore` without an explicit `worktreePath` now defaults it to `dirname(gitDir)`, not the literal path `<gitDir>/..`. That literal path left the resolution to the store, and with `gitDir` at the root it now throws.
  - **vcs-core:** `decodeTreeEntries` now refuses entry names that git fsck rejects: empty, `.`, `..`, or containing `/`. Such names come only from crafted trees, for example fetched from a remote. Checkout turns entry names into worktree paths, and webrun-files 0.12 resolves `..`, so a tree `sub/` → `..` → `.git/config` would otherwise write into the repository's own `.git`.

### Patch Changes

- e509d97: **Lock files use `FilesApi.createExclusive` when the FilesApi has it.** `atomicFilesOver(files, root).createExclusive` now delegates to the FilesApi's own exclusive create (webrun-files: `open "wx"` on Node, Web Locks in the browser, a transaction in sqlite) when it is present, detected at run time. Every git lock goes through it (`<ref>.lock` and `packed-refs.lock` in ref batches, `index.lock`, `gc.pid` and `gc.pid.takeover`), so the exclusion becomes cross-process: native git, other tabs and other FilesApi instances over the same directory are excluded. A delegated create that fails with ENOENT (another process, such as native git, pruned the empty directory between webrun-files-node's `mkdir` and its `open`) is retried, as git's `raceproof_create_file` does. Without it, locks behave as before: check-then-write, exclusive only among writers sharing one FilesApi instance.
  
  **webrun-files 0.11.** The catalog moves `@statewalker/webrun-files`, `-node`, `-mem` and `-browser` to `^0.11.0`. Every one of them now has `createExclusive`, so on Node locks hold across processes: two processes with their own `createNodeFilesApi` over one repository never both take `<ref>.lock` or `index.lock`, and native `git` sees our locks (and we see its). `createNodeFilesApi().write` streams to a temporary file and renames it over the target, and a `createNodeFilesApi({ rootDir: "/" })` accepts absolute paths. The vcs `FilesApi` interface declares the optional `createExclusive`, as webrun-files does.
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [e509d97]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [b6a5d9c]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [060fcd0]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [46f2a01]
  - @statewalker/vcs-utils@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-utils@0.1.1
