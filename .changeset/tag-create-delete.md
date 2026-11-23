---
"@statewalker/vcs-commands": minor
---

`git tag` creation and deletion follow git: `tag().setEdit()`/`setEditor()` (`-e`, git's
template and cleanup, the previous tag's body reused under `-f`), `setCreateReflog()`
(`--create-reflog`), `addTrailer()` (`--trailer`), `setCompatibility()`, and `callText()`
giving `Updated tag 'x' (was abc1234)` and the nested-tag advice; `tagDelete().callText()`
gives `Deleted tag 'x' (was abc1234)`, `error: tag 'x' not found.` and the exit status.
Refusals carry git's messages (`fatal: tag 'x' already exists`, `fatal: 'x' is not a valid
tag name.`, `fatal: no tag message?`); an annotated tag without a message and without an
editor now fails as `GIT_EDITOR=: git tag -a` does; a tag of a tree, blob or tag records its
real type; `tagDelete()` always deletes `refs/tags/<name>`, as git.
