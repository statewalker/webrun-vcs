---
"@statewalker/vcs-commands": minor
---

`git rebase` separates onto from the upstream, as native git 2.43 and 2.56 do (native twins in
`rebase-onto-fork-point-native.test.ts`, from t3400, t3416, t3431, t6010 and t6099).
`RebaseCommand.setOnto` is `--onto <newbase>`, `A...B` included (the one merge base, git's
`need exactly one merge base` otherwise); `setBranch` is the `<branch>` argument (a local branch
switched to and moved, or any commit rebased on a detached HEAD; up to date, it is checked out
with `rebase: checkout <branch>`); `setKeepBase` is `--keep-base` (onto `<upstream>...<branch>`,
cherry-picks kept unless `setReapplyCherryPicks(false)`); `setForkPoint` is
`--[no-]fork-point`: the commits the upstream's reflog shows were once on it are left out (git's
get_fork_point). Without an upstream the branch's `@{upstream}` is used with the fork point on
(unless `rebase.forkPoint=false`), or git's advice is returned when it has none.
`can_fast_forward`, the todo list's range and its cherry-pick detection follow git's upstream,
onto and fork point; ORIG_HEAD is the rebased branch's tip. The new `git.mergeBase()`
(`MergeBaseCommand`) is `git merge-base` with `--all`, `--octopus`, `--independent`,
`--is-ancestor` and `--fork-point`, with git's messages and exit statuses.
