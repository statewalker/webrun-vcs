---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": patch
---

**Breaking: worktree hashing and checkout writes stream.** No worktree file or blob is read whole just to hash it or to write it.

- **vcs-working-tree:** new `hashWorktreeFile(path, { size, read }, newHasher?)` hashes a file as it streams, with its size from stat. When the file changes size while it is read it re-stats and retries once, then returns `unknownContentId()`, a non-hex value unique to each call that never equals an index id, so it compares as modified (`isUnknownContentId` recognises it). `add -N` now records the empty blob's id flagged `intentToAdd`, as git does, instead of an empty id. Checkout writes are as atomic as `FilesApi.write`. `MemoryWorktree` uses it. The `hashFunction` option is removed; pass `newHasher` (an incremental `Hasher` factory, default `createSha1`). New type `NewHasher`.
- **vcs-store-files:** `FileWorktree.computeHash` and `FileTreeIterator.computeHash` stream through `hashWorktreeFile`; their `hashFunction` option is replaced by `newHasher`. `FileWorktree.checkoutTree` streams each blob into `FilesApi.write`. `GitResolutionStore` streams blobs into the worktree (`acceptOurs`, `acceptTheirs`), stores resolved files as streams of known size (`markAllResolved`), and scans for conflict markers chunk by chunk.
- **vcs-commands:** the core `CheckoutCommand`, `Git.checkout()`, `reset --hard` and `stash apply` hand the blob stream to the worktree instead of collecting it.
- **vcs-utils:** `computeObjectIdFromStream(type, size, content, newHasher?)` takes an optional hasher factory.
