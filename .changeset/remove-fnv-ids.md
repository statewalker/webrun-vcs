---
"@statewalker/vcs-core": major
"@statewalker/vcs-store-mem": major
"@statewalker/vcs-store-kv": major
"@statewalker/vcs-store-sql": major
"@statewalker/vcs-testing": minor
---

**Breaking: every store uses git's SHA-1 object ids; the FNV-1a ids are gone.**

Removed: `computeCommitHash`, `computeTreeHash` and `computeTagHash` (vcs-core), `MemoryCommitStore` / `MemoryTreeStore` / `MemoryTagStore` (vcs-store-mem), `KVCommitStore` / `KVTreeStore` / `KVTagStore` with their scan queries (vcs-store-kv), and `SQLCommitStore` / `SQLTreeStore` / `SQLTagStore` (vcs-store-sql). Use `createMemoryObjectStores()`, `createKvObjectStores({ kv })`, and `createSqlNativeStores(db)` or `createSqlObjectStores({ db })`.

`SQLHistoryFactory` (`createHistory("sql", …)`) now wires the native SQL stores, so its trees, commits and tags get git ids. Persisted ids change: databases it wrote before hold FNV ids in `tree`, `tree_entry`, `vcs_commit`, `commit_parent`, `vcs_tag`, `vcs_ref` and `vcs_reflog`, and KV stores in `commit:`, `tree:` and `tag:` keys. There is no migration; re-import from a git remote.

The shared tree, commit and tag suites check ids against ones git computes.
