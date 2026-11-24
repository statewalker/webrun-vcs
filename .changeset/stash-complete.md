---
"@statewalker/vcs-commands": minor
---

`git stash` is complete: `git.stashPop()` (apply then drop, the entry kept on conflicts with
git's message, `stash.index` in 2.5x), `git.stashShow()` (`--stat`/`-p`/any diff format and
option through `DiffCommand`, `stash.showStat`/`showPatch`/`showIncludeUntracked`, `-u` and
`--only-untracked`), `git.stashBranch()` (`checkout -b` at the stash's base, apply with
`--index`, drop on success) and `git.stashStore()` (a created stash recorded with its reflog
message). `stashList().callText(options, walk)` prints `git stash list [<log-options>]`
through `LogCommand`, which gains `setReflogWalk(ref)` (`git log -g`: `Reflog:` lines,
`--oneline` selectors, `%gd`/`%gD`/`%gs`/`%gn`/`%ge`, date selectors). Pop, branch and show
print git's stdout (`getOutput()`) and fail with git's messages and exit statuses
(`setCompatibility("2.43")` for 2.43's). `StashApplyResult.messages` holds merge-ort's
messages (statewalker/statewalker-root#298).
