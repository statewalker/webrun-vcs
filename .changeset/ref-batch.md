---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-mem": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-testing": minor
---

**New (vcs-core):** `Refs.batch(commands, options?)` applies ref updates atomically: all of them or none. It follows `git update-ref --stdin`'s rules:
- names must be `HEAD` or valid names under `refs/`;
- no duplicates;
- no directory/file conflicts;
- each `old` must match (`undefined` means no check, `null` means the ref must not exist);
- commands follow symbolic refs unless `noDeref` is set. With `noDeref`, `old` is still compared with the resolved value, as git does.

It returns `{ ok, rejected: [{ name, reason }] }`.

Two rules are project policy rather than git's:
- a detached HEAD cannot join a multi-ref batch (`not-atomic`);
- symbolic-ref chains are followed for at most 5 refs.

A symbolic ref pointing outside `refs/` is refused as `invalid-name`.

**Also new:**
- `planRefBatch`, the backend-independent planner, with its view and result types `RefBatchView`, `PlannedRefUpdate` and `RefBatchPlan`. A planned update carries the raw value it read and the refs whose reflogs also record it (HEAD included, as git logs it).
- `isUpdatableRefName`, plus the types `RefCommand`, `RefRejectReason`, `RefRejection`, `BatchResult` and `BatchOptions`.

**Breaking:**
- `batch` is required on every `Refs` implementation.
- `MemoryRefStore` is removed. It duplicated `MemoryRefs`; use `MemoryRefs` (vcs-store-mem re-exports it).
- `MemoryRefs.compareAndSwap` is now a one-command batch:
  - it refuses names outside `HEAD` / `refs/` (e.g. `ORIG_HEAD`), D/F conflicts, and symbolic-ref chains longer than 5;
  - on a symbolic `HEAD` it updates the target instead of detaching HEAD;
  - on failure, `errorMessage` names the reason.
- `MemoryRefs.set`, `setSymbolic` and `remove` apply in order with batches, under one write lock: await them before reading.
- `MemoryRefs.list` snapshots the refs when iteration starts.

**Interim (deprecated, will be removed):** `batchBySingleRef` / `SingleRefWriter`. The SQL, KV and git-files stores run one command through `compareAndSwap`, so a batch is only as atomic as that is. They refuse multi-command batches, and `noDeref` on a symbolic ref, as `unsupported` until their atomic batches land.

**Fixed (vcs-store-files):**
- `compareAndSwap` now works on refs that exist only in packed-refs, and writes through a symbolic ref to its target.
- `delete` removes a ref from packed-refs too.

**New (vcs-testing):** `createRefBatchTests(name, factory, { multiRef?, symbolicRefs? })`, the batch contract suite.
