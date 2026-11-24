---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-core": patch
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
`tag -f` over a symbolic tag ref updates the ref it names, as git; a `tag -d` whose deletion
fails reports git's `could not delete references` lines (exit 1) after the others. Ref stores
create the reflogs of the symbolic refs an update goes through under `createReflog` (git's
REF_FORCE_CREATE_REFLOG reaching split_symref_update), not HEAD's when it only records its
branch's update (`reflogInChain`).
