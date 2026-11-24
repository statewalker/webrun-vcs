---
"@statewalker/vcs-commands": minor
---

`git submodule absorbgitdirs [--quiet] [<path>...]` (statewalker/statewalker-root#329):
`git.submoduleAbsorbGitDirs()` moves each submodule's embedded `.git` directory into the
superproject's git directory (`.git/modules/<name>`, or `submodule.<name>.gitdir` under
`extensions.submodulePathConfig`) and leaves a gitfile and `core.worktree`, then does the same in
nested submodules (git's `absorb_git_dir_into_superproject` and its child run per submodule), and
rewrites a nested gitfile that no longer names a repository. The move runs first and its result
is checked (`relocate_gitdir`), so a failure leaves the repository where git can still read it;
git's deaths (`could not lookup name`, more than one worktree, broken gitfiles, symlinked paths)
are reproduced. `submodule deinit` and `git rm` share this code: deinit now absorbs nested
submodules too, and `git rm` of a submodule holding a `.git` directory absorbs it before removing
it (`RmResult.messages` carries the `Migrating ...` lines), as git does. `modules/` is now looked
up in the worktree's own git directory (a linked worktree's `worktrees/<id>/modules/`), as git
keeps it per worktree.

Migration and rollback: the layout written is git's own, and older webrun versions already read
submodules through gitfiles, so no reverse move is needed to go back.
