---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": patch
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
otherwise). A three-way merge handles file/directory conflicts as unpack-trees does
(`df_conflict_entry`: no trivial resolution against a conflicting side, no base stage for it),
several trees without `-m` are read in traversal order, and `--prefix` drops the index entries a
bound entry clashes with as a file or a directory; no index is written with a stage-0
file/directory clash.

`Worktree` gains optional `gitlinkRepository` (the place a submodule's gitfile names, null
when the FilesApi cannot reach it) and `connectGitlink` (implemented by the file worktree);
the file worktree's `rename` throws when the FilesApi refuses the move instead of reporting
success, and the commit-graph writer no longer ignores a refused move; `setCacheTree(undefined)` now drops the cache-tree from the next index write;
`repairCacheTree` computes git's `cache_tree_update(WRITE_TREE_REPAIR)` (an invalid
directory stops its ancestors, as `update_one` does); `IndexAdder.put`
stages a ready entry; `switchTrees` and `resetMerge` take `update`, plain-error and
sparse-skipping options.
