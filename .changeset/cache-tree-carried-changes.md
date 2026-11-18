---
"@statewalker/vcs-core": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-sql": patch
---

**A staged change carried over by a merge, checkout or pick is no longer lost by the next commit.**

A fast-forward `merge` or `merge --squash` (and every operation that switches the index with git's two-way unpack-trees: picks, rebases, `am`) wrote the index's cache-tree from the target tree. A staged change on a path the two trees agree on stays in the index, so the cache-tree claimed directories the index does not hold, and the next commit (or native `git write-tree`) took the target's tree there: the staged change was dropped, or the commit refused as empty.

- **vcs-working-tree:** `invalidateCacheTreeAgainstIndex` invalidates in a cache-tree computed from a tree every path where the index differs from that tree (an entry kept, added or removed), reading only the directories the index's previous cache-tree does not vouch for. The stagings' `writeTree` reuses a valid cache-tree node only when it counts the entries under it and its tree is stored (git's `update_one`), else it computes it again.
- **vcs-commands:** the two-way switch derives the cache-tree it writes from the index it leaves.
- **vcs-core:** a tree entry with an empty mode or another character than an octal digit fails to read with git's "malformed mode in tree entry" (`decodeTreeBytes`, `TreeEntryCursor`), instead of reading as a gitlink.
- **vcs-store-sql:** the native tree store gives a tree's stored bytes (`raw`, modes as written), and `exportToGit` copies a tree through them, so a tree holding a 100664 blob keeps its id; a tree that would be written under another id fails loudly.
