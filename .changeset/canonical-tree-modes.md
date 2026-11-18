---
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-transport-adapters": patch
---

**Tree entry modes read as git reads them (`canon_mode`), everywhere.**

A tree that stores a blob as 100664 (older git wrote it) now reads as 100644, as git's `decode_tree_entry` reads it, so a repository with such trees behaves as with native git: `status` is clean after `reset --hard`, and `merge`, `checkout`, `cherry-pick`, `revert`, `rebase` (patch-ids), `stash`, `reset`, `diff` and `log` no longer see a mode change between 100664 and 100644, or refuse with "local changes would be overwritten".

- **vcs-core:** the tree store's `load`, `entries` and `getEntry` give canonical modes (`canonTreeMode`: a regular file 100644 or 100755 by its owner's execute bit, a symlink 120000, a directory 40000, anything else a gitlink); `raw` still gives the stored bytes, and serializing a stored tree (`SerializationApi`) copies them. `decodeTreeBytes(bytes, { canonicalModes: true })` reads canonical modes (without the option, modes as stored), and `treeModesRewritten(entries)` says whether such a list came from a tree written with other modes (encoding it again makes another tree). fsck keeps reading the modes as stored (`badFilemode` for 100664 under `--strict`).
- **vcs-working-tree:** the files and git stagings' `writeTree` reuses the directories the index's cache-tree has valid, as git's write-tree does (a tree primed by a reset keeps its stored 100664 modes). `updateCacheTree` computes a directory as the canonical tree its entries make: where the stored tree holds other modes, that tree is valid only if stored (git's `WRITE_TREE_REPAIR`), else invalid.
- **vcs-commands:** `reset --hard` primes the cache-tree with the target tree (`prime_cache_tree`) and `reset --mixed` keeps it with the changed paths invalid; `stash apply` invalidates the paths it merges. A combined diff's `-U0` hunk header prints a count below zero as git's `%lu` does (`+1,18446744073709551615`), in `diff` and `log --cc`.
- **vcs-store-sql**, **vcs-transport-adapters:** syncing a tree to the SQL store and an object's size read the stored bytes; the native SQL tree store reads canonical modes.
