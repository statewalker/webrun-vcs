---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport-adapters": minor
---

**Breaking: one ref interface, `Refs`.**

- **vcs-core:** the legacy `RefStore` interface and its `RefStoreLocation` alias are removed (use `RefStorage`), along with `RefsAdapter` and `createRefsAdapter`.
- **`createHistoryFromComponents`:** `refs` is now `{ type: "memory" }` or any `Refs` implementation, used as is. It replaces `{ type: "adapter", refStore }`.
- **vcs-store-files:** `FileRefStore` implements `Refs` directly. Its `delete(name)` is now `remove(name)`.
- **vcs-transport-adapters:** `createCoreRepositoryAccess({ refStore })` takes a `Refs`. `updateRef` is one atomic `batch` command: the old value is checked and the ref is written or deleted in one step, where before it was a check followed by a write.
