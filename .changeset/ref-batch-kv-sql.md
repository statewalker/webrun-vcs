---
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-core": patch
---

**Atomic ref batches in `KVRefStore` and `SQLRefStore`.** They now pass the full `createRefBatchTests` contract, including 20 concurrent two-ref batches.

**`KVRefStore`:**
- Every ref lives in one root value (`ref:root`, JSON in git's name order).
- Every write, whole batches included, is one `compareAndSwap` of that value. A lost race re-reads and re-checks; after 100 lost races a batch reports `locked`, and `set` / `setSymbolic` / `remove` throw.
- The decoded root is cached while its bytes are unchanged.
- **Breaking:** the persisted layout changed. A store holding the earlier one-key-per-ref layout now throws a clear error instead of reading as empty.
- **New:** `CorruptRefRootError`, thrown when the root is not a JSON object of strings. A corrupt root is never overwritten.

**`SQLRefStore`:**
- A batch is planned and written in one `DatabaseClient.transaction`.
- `list(prefix)` now matches the prefix exactly: case-sensitive, with no `LIKE` wildcards.
- `set` and batch writes clear a stale peeled id and mark the ref `loose`.

**Both stores, `compareAndSwap`:** it is now a one-command batch, as in `MemoryRefs`, and atomic.
- It follows symbolic refs: CAS on a symbolic `HEAD` writes its branch.
- It refuses names other than `HEAD` and those under `refs/` (e.g. `ORIG_HEAD`), and directory/file conflicts.
- On failure, `errorMessage` names the reason (`mismatch`, …).

**Fixed (vcs-store-sql), `SqlJsAdapter`:**
- **Concurrent transactions were merged.** A concurrent `transaction` ran inside the one in flight, so a rollback of either undid both. Transactions are now queued.
- **Plain statements ran inside open transactions.** A `query` or `execute` issued while a transaction was open ran inside it: dirty reads, and writes undone by someone else's rollback. They now wait for the transaction to finish.
- **Nesting:** a nested transaction joins only through the client handed to `fn`. The `DatabaseClient` docs now state these rules.
- **Failing `BEGIN`:** a `BEGIN` that fails no longer rolls back a transaction it did not start.

**`kvStoreRefs` (vcs-core)** keeps one key per ref, the layout shared with webrun-storage's `refStore` facade. It stays on the single-command batch, now documented.
