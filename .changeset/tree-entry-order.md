---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
---

**Tree entries are sorted exactly as git sorts them, so some tree ids change to git's.** A directory `a` next to a file `a-` (or any file whose name continues `a` with a byte below `/`, such as `a!` or `a.`) used to compare equal to it: the order of the two in the encoded tree then followed the order the entries came in, and a tree built from a different order got an id native git never writes (and `git fsck` reports as not properly sorted). Now a tree compares as its name plus `/` in every case (git's `base_name_compare`), so `a-`, `a.b`, then the tree `a`, then `a0`, whatever the input order. Trees that were written in git's order before keep their ids; a tree written out of order before is written with a new id (git's) when it is built again.

- **vcs-core:** `compareTreeEntries` and `compareTreeEntryNames` (exported) are git's tree order over UTF-8 bytes; `encodeTreeEntries`, `serializeTree` and the structural tree deltas use them (the deltas sorted with `localeCompare` before).
- **vcs-store-sql:** the native tree store sorts and hashes trees with the same comparator (it compared UTF-16 strings).
- **vcs-commands:** patch ids walk trees in that order.
