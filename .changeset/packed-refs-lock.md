---
"@statewalker/vcs-store-files": patch
---

**Every rewrite of `packed-refs` takes `packed-refs.lock`, as git does.** `FileRefStore.packRefs` / `optimize` (and so gc), `FileRefStore.remove`, and the functions `packRefs`, `writePackedRefs`, `addPackedRef` and `removePackedRef` now use the ref batch's protocol: take `packed-refs.lock` exclusively (retrying for `packedLockTimeoutMs`, git's `core.packedRefsTimeout`, 1000 ms, then throwing `PackedRefsLockedError` with nothing changed), re-read `packed-refs` under the lock, write the new content into the lock and rename it over `packed-refs`, removing the lock on failure. They no longer lose a concurrent ref batch, or a native `git pack-refs` / `git update-ref -d`, by writing back content read before it committed.

**`packRefs` prunes in git's order.** As git's `files_pack_refs` and JGit's `RefDirectory.pack`, it writes `packed-refs` first and then removes each loose ref it packed under that ref's own `.lock`, only if it still holds the packed value: a ref updated in between stays loose with its new value. It no longer writes a `peeled` header without peel lines (git then showed annotated tags as unpeeled); symbolic and broken loose refs are left alone.

**New:** `createFilesRefOps(atomicFiles, options)` returns `{ batch, packRefs, updatePackedRefs }` sharing one lock protocol (`createFilesRefBatch` is its `batch`), and `PackedRefsLockedError`. The packed-refs functions take an optional last `options` argument (`atomicFiles`, `packedLockTimeoutMs`, `refLockTimeoutMs`).
