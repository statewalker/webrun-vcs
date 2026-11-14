---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-testing": minor
---

Ref batches write reflogs in every store, as git does with `core.logAllRefUpdates=true`: `MemoryRefs`, `KVRefStore` (`reflog:<name>` keys) and `SQLRefStore` (table `vcs_reflog`, migration 5) now keep them like `FileRefStore`, and expose `getReflog`. New in vcs-core: `planReflog` and `createReflogReaderOf`. The shared ref-batch suite gains reflog cases (`{ reflog: true }`).

`KVRefStore` adds a `:seq` entry (the root's write count) to `ref:root`, so its reflog lines keep commit order. Roots written before it are read as `:seq` 0 and keep working.
