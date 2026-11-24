---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-working-tree": minor
---

`git submodule absorbgitdirs [--quiet] [<path>...]` (statewalker/statewalker-root#329):
`git.submoduleAbsorbGitDirs()` moves each submodule's embedded `.git` directory into the
superproject's git directory (`.git/modules/<name>`, or `submodule.<name>.gitdir` under
`extensions.submodulePathConfig`) and leaves a gitfile and `core.worktree`, then does the same in
nested submodules (git's `absorb_git_dir_into_superproject` and its child run per submodule), and
rewrites a nested gitfile that no longer names a repository. The move runs first and its result
is checked (`relocate_gitdir`), so a failure leaves the repository where git can still read it;
git's deaths (`could not lookup name`, more than one worktree, broken gitfiles, symlinked paths)
are reproduced, git's errno included (`could not migrate git directory ...: Directory not empty`).
Symbolic links are followed as git's `stat` follows them: a linked `.git/modules` and a `.git`
linked to a repository are migrated where they lead (`physicalFilesPath` resolves them through
the FilesApi's `lstat`/`readlink`); a link leading beyond the FilesApi is refused with git's
`could not create directory` line, nothing moved.
Leading directories are created as git's `safe_create_leading_directories` creates them
(`safeCreateLeadingDirectories`): a dangling link on the way refuses with git's line and its
target is never created; a loop is git's stat failure. `Worktree.openGitlink` takes `gitDir`, the
repository a caller found through a link the storage does not follow, so nested absorption
reaches a submodule whose `.git` or gitfile leads through a link. `git rm` removes a submodule
whose `.git` is a link (the link only) once it is absorbed. `submodule deinit` and `git rm` share this code: deinit now absorbs nested
submodules too, and `git rm` of a submodule holding a `.git` directory absorbs it before removing
it (`RmResult.messages` carries the `Migrating ...` lines, also in the result of an
`RmFailedError` raised afterwards; a failed absorb is an `RmFailedError` with exit 128), as git does. `modules/` is now looked
up in the worktree's own git directory (a linked worktree's `worktrees/<id>/modules/`), as git
keeps it per worktree.

Migration and rollback: the layout written is git's own, and older webrun versions already read
submodules through gitfiles, so no reverse move is needed to go back.
