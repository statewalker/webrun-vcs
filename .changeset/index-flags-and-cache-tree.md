---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-mem": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
---

**Index flags and the cache-tree survive index rewrites as in git, and more sequencer leftovers match git.**

- `reset --hard`, `reset --mixed`, `checkout -f`, `reset --merge`/`--keep` and the autostash reset of `merge --autostash` and rebase keep skip-worktree and assume-unchanged flags as unpack-trees does. An entry the target leaves unchanged keeps its flags. A changed entry keeps its skip-worktree bit. A skip-worktree file the tree keeps is not written. Before this, `git ls-files -v` showed every flag dropped. `Staging.readTree` takes `keepMatching` (`true` keeps the old entry, `"flags"` keeps only its flags) for this one-way merge.
- An entry whose flags cheat is checked against its file by its stat, as git's `verify_uptodate_1` does. `reset --hard` and `checkout -f` refuse such an entry when they would change or delete it over a changed file ("Entry 'f' not uptodate. Cannot merge."). A branch switch refuses an assume-unchanged file whose stat changed, even when its content did not.
- `stash apply --index` applies the stash's index as git does: a `diff-tree --binary` of it, run through `apply --cached`. A hunk whose context the index no longer has now fails with "error: patch failed: ...", "patch does not apply" and "conflicts in index. Try without --index.", where we used to merge it.
- `am --skip` cleans the index as git's `clean_index` does (the same as `am --abort`): a refusal ends with "failed to clean index", and a merge state left behind is removed.
- The cache-tree (`TREE`) now survives index edits as in git. When entries change, the paths that changed go invalid and every other directory stays valid. Before this, the whole extension was dropped. So a commit after an edit keeps an untouched subtree stored as 100664, and the commit ids match native git. `commit` writes the index with a fully valid cache-tree (git's `prepare_index`), and `checkout`, `reset --merge` and `reset --keep` update it before they write (`cache_tree_update` with `WRITE_TREE_REPAIR`). The `TREE` bytes match native git's.
- `verifyCacheTree` (vcs-working-tree) checks that every valid cache-tree node describes the index entries below it, for tests and fsck.
