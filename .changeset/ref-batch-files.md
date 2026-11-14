---
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-testing": minor
---

**Atomic ref batches on git's files layout (vcs-store-files).** `FileRefStore.batch` implements git's lock-file protocol:
- **One ref:** lock `<ref>.lock` exclusively, re-check under the lock, then commit by rename.
- **Several refs:** lock every ref, then `packed-refs.lock`, then a two-phase `packed-refs` commit, as in JGit's `PackedBatchRefUpdate`.
- **Crashes:** a crash at any file operation leaves every ref at its old or its new value.
- **Interop:** native git reads the result and honours the locks, in both directions.
- **Reflog:** lines are written in git's format, as git with `core.logAllRefUpdates=true`: logs are created for HEAD, branches, remotes and notes (not tags); HEAD records no-op updates and deletes of its branch.
- **Readers (fixed):** `readAllRefs`, `list` and `packRefs` / `optimize` no longer treat `*.lock` files as refs (they could pack and delete another writer's live lock). Loose refs are re-read around `packed-refs`, so a listing never combines old and new states.
- **Reflog reader (fixed):** lines without a message, as git writes them, are read.
- **Limit:** a multi-ref batch that replaces a symbolic ref (`noDeref`) is refused as `unsupported`.
- **`compareAndSwap`** is now a one-command batch, so it works on packed-only refs.
- **`createFilesRefBatch(atomicFiles, options)`** exposes the batch on its own.
- **Options:** `FileRefStore` / `createFileRefStore` / `createGitFilesBackend` accept `atomicFiles`, `refLockTimeoutMs` and `packedLockTimeoutMs`.
- **Format:** `packed-refs` written by a batch carries git's `sorted` trait.

**New (vcs-utils):**
- `AtomicFiles`: exclusive create, replace by rename, append, remove-if-empty, plus read, write and list.
- `atomicFilesOver(files, root)`: an implementation over any FilesApi. It is atomic only among users of the same FilesApi instance (not across instances or processes).

Lock files go through `AtomicFiles`; the portable `atomicFilesOver(files, gitDir)` excludes writers sharing one FilesApi.

**vcs-core:** `RefStore` gains an optional `batch`; `RefsAdapter` uses it when present.

**New (vcs-testing):** `createAtomicFilesTests`, the `AtomicFiles` contract suite.
