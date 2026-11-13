---
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-core": patch
---

**Atomic ref batches in `KVRefStore` and `SQLRefStore`.** They now pass the full `createRefBatchTests` contract, including 20 concurrent two-ref batches.

- **`KVRefStore`:** every ref lives in one root value (`ref:root`, JSON in git's name order). Every write, whole batches included, is one `compareAndSwap` of that value; a lost race re-reads and re-checks. **Breaking:** the persisted layout changed. Stores written with one `ref:<name>` key per ref are not read. `errorMessage` on a failed `compareAndSwap` now names the reason (`mismatch`, …).
- **`SQLRefStore`:** a batch is planned and written in one `DatabaseClient.transaction`. `compareAndSwap` is a one-command batch, so it is atomic now, where before it was a read followed by a write.
- **Fixed (vcs-store-sql):** `SqlJsAdapter.transaction` ran a concurrent caller inside the transaction already in flight, so a rollback of either undid both. Transactions are now queued. A nested transaction joins only through the client handed to `fn`.
- **`kvStoreRefs` (vcs-core)** keeps one key per ref, the layout shared with webrun-storage's `refStore` facade. It stays on the single-command batch, now documented.
