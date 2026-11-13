---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-mem": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-testing": minor
---

**New (vcs-core):** `Refs.batch(commands, options?)` applies ref updates atomically, all or nothing, with `git update-ref --stdin`'s rules:
- names must be `HEAD` or valid names under `refs/`;
- no duplicates;
- no directory/file conflicts;
- each `old` must match (`undefined` = no check, `null` = must not exist);
- commands follow symbolic refs unless `noDeref` is set.

It returns `{ ok, rejected: [{ name, reason }] }`. Also new: `planRefBatch` (backend-independent checking), `isUpdatableRefName`, and the types `RefCommand`, `RefRejectReason`, `BatchResult` and `BatchOptions`.

**Breaking:**
- `batch` is required on every `Refs` implementation.
- `MemoryRefStore` is removed. It duplicated `MemoryRefs`; use `MemoryRefs` (vcs-store-mem re-exports it).
- `MemoryRefs.compareAndSwap` now runs as a one-command batch. It refuses names that are not `HEAD` and not under `refs/`, and on failure `errorMessage` names the reason.

**Interim:** the SQL, KV and git-files stores implement `batch` for a single command (through `compareAndSwap`). They refuse multi-command batches as `not-atomic` until their atomic batches land.

**New (vcs-testing):** `createRefBatchTests(name, factory)`, the batch contract suite.
