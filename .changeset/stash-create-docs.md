---
"@statewalker/vcs-commands": patch
---

Document that `git.stashCreate()` is `git stash push` and that `stashCreate().setRef(null)` is `git stash create` (the stash commit only; worktree, index and `refs/stash` untouched), with a native twin checking the latter against git.
