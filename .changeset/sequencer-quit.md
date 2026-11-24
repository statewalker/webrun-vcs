---
"@statewalker/vcs-commands": minor
---

`rebase --quit` (`RebaseOperation.QUIT`) and `--show-current-patch`
(`RebaseOperation.SHOW_CURRENT_PATCH`, the text in `RebaseResult.currentPatch`) as git: quit
removes `rebase-merge/` (deleting its `refs-to-delete`) or `rebase-apply/`, keeps an autostash
on `refs/stash` with git's lines, and leaves HEAD, the index, the worktree, ORIG_HEAD,
REBASE_HEAD and AUTO_MERGE; show is `git show REBASE_HEAD --` (or `git am
--show-current-patch` for an apply-backend rebase). Without a rebase both refuse with
`fatal: no rebase in progress` (2.43: `No rebase in progress?`, `RebaseCommand.setCompatibility`).
`am().setShowCurrentPatch("raw" | "diff")` prints the stopped mail or `rebase-apply/patch`.
`cherry-pick --quit` and `revert --quit` now run git's remove_branch_state after removing
`sequencer/`: CHERRY_PICK_HEAD, REVERT_HEAD, MERGE_MSG, AUTO_MERGE and the rest of the merge
state go, as in git (statewalker/statewalker-root#308).
