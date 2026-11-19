---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-mem": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
---

**A staged deletion survives `stash apply --index`, and `rm` keeps the flags of the other entries.**

- `stash apply --index` could write a cache-tree that no longer described the index: a path removed from the index outside the merged paths stayed in a valid directory node, and the next commit (ours or native git's) put the deleted file back. The index it leaves now has git's fully valid cache-tree (`reset_tree`'s `cache_tree_update`).
- A cache-tree set with `setCacheTree` no longer goes stale when entries change before the write. The staging records the entries it describes, and the write invalidates every path that changed since, as it already did for the cache-tree read from the index.
- Intent-to-add entries are left out of every tree, as git's `update_one` leaves them out, even when they are also skip-worktree. Before this, `git add -N new; git update-index --skip-worktree new` committed `new` as an empty file.
- `rm` keeps the other entries as they are. Before this, it rebuilt them from path, mode and id: intent-to-add entries became real entries naming a blob never written, and skip-worktree, assume-unchanged and the stat data were dropped. `commit --only` also gives the index its own entries back once it has written its tree.
- `commit` refuses an index that another writer replaced since this instance read it (`IndexChangedError`), as index writes do, instead of committing the stale entries.
- `rebase` goes on over a dirty assume-unchanged or skip-worktree file, as git's `require_clean_work_tree` does. The stat check of flagged entries counts an intent-to-add entry as changed and finds no racy entry in an index without a timestamp, as git's `ie_match_stat` does.
