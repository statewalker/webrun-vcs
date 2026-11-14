---
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-testing": minor
---

**Atomic ref batches on git's files layout (vcs-store-files).** `FileRefStore.batch` implements git's lock-file protocol:
- **One ref:** lock `<ref>.lock` exclusively, re-check under the lock, then commit by rename.
- **Several refs:** lock every ref, then `packed-refs.lock`, then a two-phase `packed-refs` commit, as in JGit's `PackedBatchRefUpdate`.
- **Crashes:** a crash at any file operation leaves every ref at its old or its new value.
- **Interop:** native git reads the result and honours the locks, in both directions.
- **Reflog:** lines are written in git's format, HEAD's included when HEAD points at an updated branch.
- **`compareAndSwap`** is now a one-command batch, so it works on packed-only refs.
- **`createFilesRefBatch(atomicFiles, options)`** exposes the batch on its own.
- **Options:** `FileRefStore` / `createFileRefStore` / `createGitFilesBackend` accept `atomicFiles`, `refLockTimeoutMs` and `packedLockTimeoutMs`.
- **Format:** `packed-refs` written by a batch carries git's `sorted` trait.

**New (vcs-utils):**
- `AtomicFiles`: exclusive create, replace by rename, append, remove-if-empty, plus read, write and list.
- `atomicFilesOver(files, root)`: an implementation over any FilesApi. It is atomic only within one JavaScript process.

**New (vcs-utils-node):** `createNodeAtomicFiles(root)`, built on O_CREAT|O_EXCL, rename(2) and O_APPEND. Use it wherever another process, native git included, may write the same repository.

**vcs-core:** `RefStore` gains an optional `batch`; `RefsAdapter` uses it when present.

**New (vcs-testing):** `createAtomicFilesTests`, the `AtomicFiles` contract suite.
