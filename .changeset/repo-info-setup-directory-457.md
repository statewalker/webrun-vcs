---
"@statewalker/vcs-commands": minor
---

`git repo info`: `RepoInfoCommand.setSetupDirectory(hostPath)` takes the directory git's setup went to (`setupGitDirectory`'s `cwd` as a host path). The `path.*.relative` keys are relative to it plus the prefix, and a relative `$GIT_INDEX_FILE` is read there, so a git started outside the worktree (explicit `$GIT_DIR`/`$GIT_WORK_TREE`) or with a bare `$GIT_DIR` gets git's paths.
