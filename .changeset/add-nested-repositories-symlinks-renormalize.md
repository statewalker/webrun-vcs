---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
---

**`git add` handles linked worktrees, files turned repositories, symbolic links and `--renormalize` as git does.**

- A linked worktree made inside the repository (`git worktree add`, absolute gitdir, branches in the main repository's `commondir`) is staged as a gitlink with git's warning, so `add .`, `-A` and globs no longer fail on it. A directory whose `.git` names a place the worktree's storage cannot reach is skipped with a warning instead of failing the whole add.
- A tracked file replaced by a repository without a commit fails as git fails ("'a/' does not have a commit checked out", "fatal: adding files failed"), leaving the index as it was; it used to drop the file from the index. Replaced by a repository with a commit, it is staged once as a gitlink, with git's embedded-repository warning.
- A directory whose `.git` holds no repository (an invalid HEAD, a gitfile naming nothing) is an ordinary directory: its files are added and the tracked file it replaced removed. The worktree checks HEAD as git's `validate_headref` does.
- A pathspec element reaching through a symbolic link fails with "fatal: pathspec 'x' is beyond a symbolic link", and one ending in "/" names a directory only, before anything changes.
- `--renormalize` needs a pathspec unless `-u`/`-A` is given ("Nothing specified, nothing added."), reports `add '<path>'` for every file it adds again, honours `--ignore-missing`, stages a file turned repository as its gitlink (or reports it), and fails with git's "fatal: unable to stat" on a missing tracked file.
- A tracked file replaced by a FIFO, socket or device fails `add -u`, `add .` and `commit -a` with git's "can only add regular files, symbolic links or git-directories" instead of being removed (new optional `Worktree.isSpecialFile`).
- `AddFailedError.output` keeps the `--dry-run` / `--verbose` lines printed before a failure; `--dry-run --ignore-missing` reports a missing element under an ignored directory as given (`Worktree.isIgnored` takes an optional `asDirectory`).
- `encodeIndexFileBytes` and `encodeIndexFile` hand out buffers of their own, so changing them cannot reach a later encode.
