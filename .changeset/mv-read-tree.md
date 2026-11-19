---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
---

Add `git mv` (`MvCommand`, `git.mv()`) and `git read-tree` (`ReadTreeCommand`, `git.readTree()`).

`mv` follows builtin/mv.c: every check before anything moves with git's messages (2.43's and
2.5x's), directory moves carrying their index entries, `-f`, `-k`, `-n`, `-v`, case-only
renames with `core.ignoreCase`, intent-to-add and symbolic-link sources, submodules (gitfile,
`core.worktree`, `.gitmodules`) and the sparse checkout (`--sparse`, moves into and out of the
cone). `read-tree` reads one or more trees, `-m` one-, two- and three-way (`--aggressive`,
`--trivial`), `--reset`, `-u`, `-i`, `--prefix`, `--empty` and `--no-sparse-checkout`, with
unpack-trees' plain refusal messages and git's cache-tree (primed for one tree, repaired
otherwise).

`Worktree` gains optional `gitlinkRepository` and `connectGitlink` (implemented by the file
worktree); `setCacheTree(undefined)` now drops the cache-tree from the next index write;
`repairCacheTree` computes git's `cache_tree_update(WRITE_TREE_REPAIR)`; `IndexAdder.put`
stages a ready entry; `switchTrees` and `resetMerge` take `update`, plain-error and
sparse-skipping options.
