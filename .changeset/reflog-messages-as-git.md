---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**Reflog lines as native git writes them, and `git worktree` from a bare repository.**

- **vcs-commands:** every ref update of the porcelain writes git's reflog line, with the old and new ids, git's committer identity and git's message: `checkout: moving from main to feat` (HEAD only; a detached HEAD named by its full id), `commit: <subject>` / `commit (initial)` / `commit (amend)` / `commit (merge)` / `commit (cherry-pick)` (branch and HEAD), `reset: moving to <rev>`, `merge <names>: Fast-forward` / `Merge made by the 'ort' strategy.`, `rebase (start): checkout <onto>`, `rebase (pick)` / `(continue)`, `rebase (finish): <branch> onto <id>` and `returning to <branch>`, `rebase (abort): returning to <branch>`, `cherry-pick: <subject>`, `revert: <subject>`, `pull[ --rebase]: Fast-forward` (a `pull --rebase` that only fast-forwards merges `--ff-only`, as git), `clone: from <url>` (HEAD, the branch, `refs/remotes/<remote>/HEAD`; the remote's refs unlogged), `fetch[ <remote> <refspecs>]: fast-forward` / `forced-update` / `storing head` / `storing tag` / `storing ref` / `updating tag`, `branch: Created from <start>` / `Reset to <start>`, `Branch: renamed a to b` (the log carried over), `update by push`, the `reset: moving to HEAD` of `stash push`, and `tag: tagging ...` (logged only with core.logAllRefUpdates=always). The identity is git's `git_committer_info`: `GIT_COMMITTER_NAME/EMAIL/DATE` from the host environment, else `user.name` / `user.email` and the clock (a commit's committer for the commands that commit). The messages live in one place (`reflogMessages`, `committerIdent`, `parseGitDate`); `GitCommand.setReflogAction` is git's `GIT_REFLOG_ACTION`. `stash push` writes its index and untracked commits' messages with git's line end (the same stash ids as git). `Git.fromWorktreeAdmin` runs `worktree add/list/prune/lock/unlock/remove/move/repair` from a bare repository (`list` shows it `(bare)`); commands that need a working tree refuse there with git's `this operation must be run in a work tree`.
- **vcs-core:** `Refs.set` and `Refs.setSymbolic` take an optional reflog line (`RefLogOptions`: `message`, `ident`); `setSymbolic` with a message logs as git's `create_symref` (old resolved id to the target's id, nothing for an unborn target). `BatchOptions.skipReflog` writes no reflog line (git's initial transaction). `symrefReflogLine`, `logsByDefault`, `defaultReflogIdent`. `MemoryRefs` logs both.
- **vcs-store-files:** the files store and a linked worktree's refs honour those reflog lines; `GitLinkedWorktrees.openAdmin` gives a bare repository's history and configuration without a working copy.
- **vcs-working-tree:** `WorktreeAdmin` and `LinkedWorktrees.openAdmin`; `GitHostEnvironment.committer` carries git's committer variables.
- **vcs-transport:** fetch writes git's per-ref reflog messages (`reflogAction`, `reflogIdent`, `skipReflog`; `fetchReflogWhat`).
- **vcs-utils-node:** `createNodeGitHostEnvironment` reads `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `GIT_COMMITTER_DATE`.
