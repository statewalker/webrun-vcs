---
"@statewalker/vcs-commands": minor
---

Interactive patch modes as a library API: `add -p`, `reset -p`, `checkout -p`, `restore -p` and
`stash push -p` (`setPatch(true)` with a `setPatchSelector` callback answering git's prompts),
backed by a port of git's add-patch.c hunk engine (`runAddPatch`, git's patch-mode tables and
prompt texts for 2.43 and 2.5x, split, edit, goto, search, `--no-auto-advance`). `DiffCommand`
takes `reverse` (`diff -R`) and `setTemporaryIndex` (a diff over another index, as
`GIT_INDEX_FILE`). `git apply --cached/--index` now smudges the racily clean entries it keeps,
as git's write without a refresh does.
Under 2.5x compatibility `stash push -p` builds its temporary index as git's
`create_index_from_tree` (skip-worktree and assume-unchanged paths are not offered, and a replaced
flagged entry whose file changed fails the stash); the post-index-change hooks a selection runs
report through the calling command's `getHookOutput()`.
