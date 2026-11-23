---
"@statewalker/vcs-commands": minor
---

`git.branchList()` gets git's list mode on the ref filter: `callText()` prints `git branch`'s
listing byte for byte (`*`/`+` markers, the detached HEAD's description while detached,
rebasing or bisecting, symbolic refs as `name -> target`, `--color` and `color.branch.<slot>`),
with `setPatterns`, `-r`/`-a` (`setListMode`), `setVerbose(1|2)` (ids, subjects, upstream
tracking, worktree paths, aligned), `setFormat`, `setSort` after `branch.sort`, `setAbbrev`,
`setIgnoreCase`, `setOmitEmpty`, and the reachability filters `setContains`/`setNoContains`/
`setMerged`/`setNoMerged`/`setPointsAt`, which now take revision names. `call()` applies the
same filters. `ListBranchCommand` now extends `RefListingCommand` (statewalker/statewalker-root#294).
