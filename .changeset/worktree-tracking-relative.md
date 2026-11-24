---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-working-tree": minor
---

`git.worktreeAdd()` gets git's tracking options: `setTrack` (`--track`, `--track=inherit`,
`--no-track`, refused without a new branch), `setGuessRemote` (`--[no-]guess-remote`,
default `worktree.guessRemote`), and git's DWIM of a commit-ish that names no commit but one
remote-tracking branch (`checkout.defaultRemote` among several; 2.5x dies with git's advice on
an ambiguous name, `setCompatibility("2.43")` takes it for none, as 2.43 did). A new branch
now tracks its start as `git branch` does (`branch.autoSetupMerge`), printing
`branch 'x' set up to track 'r/x'.`; `WorktreeError.messages` carries what git prints before
dying.

Relative worktree links (git 2.48+): `setRelativePaths` on `worktreeAdd()`, `worktreeMove()`
and `worktreeRepair()` (default `worktree.useRelativePaths`) write `gitdir` and the
worktree's `.git` file relative to each other and set `extensions.relativeWorktrees` (with
`core.repositoryformatversion = 1`), only on request. Repair rewrites links of the other kind
(`absolute/relative path mismatch`), so a repair without the option turns relative links back
into absolute ones; both link files are written together, as `write_worktree_linking_files`.
Under `setCompatibility("2.43")` the option is refused and repair rewrites only the file at
fault. `LinkedWorktrees.create` takes `relativePaths`, `move`/`repair` take
`WorktreeLinkOptions`; relative links are read everywhere. A version-0 repository with an
extension git does not know cannot be upgraded: relative add, move and repair are refused
before anything is written (`WorktreeFormatUpgradeError`, git's `cannot upgrade repository
format: unknown extension <name>`), and `RepositoryFormat.unknownExtensions` lists them.

Checkout and switch: an ambiguous remote branch name prints git's
`advice.checkoutAmbiguousRemoteBranchName` hints (2.5x and 2.43 wordings), a name no ref has
dies `fatal: invalid reference: <name>`, and a branch created from a ref some remote fetches
outside `refs/remotes/` (`refs/repo_d/*`) tracks it, as git's `dwim_branch_start`
(statewalker/statewalker-root#320).
