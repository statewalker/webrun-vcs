---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-sql": minor
---

Commits and tags keep their bytes through stores of parsed objects (statewalker/webrun-vcs#399).
`Commits` and `Tags` gain optional `raw(id)` and `storeRaw(content)`; `DefaultSerializationApi`
exports a commit or tag from `raw` when the store has it, imports through `storeRaw`, and without
it refuses (`ObjectIdMismatchError`, nothing stored) a commit or tag whose parsed form would encode
to other bytes, instead of storing it under another id.

vcs-store-sql: schema migration 10 adds a nullable `raw` BLOB to `vcs_commit` and `vcs_tag`,
filled only for objects the columns cannot rebuild (extra headers such as `mergetag` and
`change-id`, names and messages that are not UTF-8); git.git now imports through `importPack` and
`importObject` and exports byte for byte. Rows written before keep reading as they did (what they
lost cannot be recovered: re-import those objects from a git source). Rolling back below version
10 refuses while any row keeps raw bytes; with none, it drops the column. `importToNative` and
`exportToGit` copy commits and tags byte for byte.
