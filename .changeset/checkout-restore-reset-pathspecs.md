---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
---

Pathspecs for `git checkout [<tree-ish>] -- <pathspec>`, `git restore` and `git reset [<tree-ish>] -- <pathspec>`.

`CheckoutCommand`'s path mode now runs git's `checkout_paths`: wildcards, magic (`:(glob)`, `:(icase)`, `:(literal)`, `:(top)`, `:/`), `:(attr:...)`, `:(exclude)`, directories and `GIT_LITERAL_PATHSPECS`; "pathspec 'x' did not match any file(s) known to git" (status `CONFLICTS`, nothing changed); `setOverlay(false)` (`--no-overlay`), `setStage` (`--ours`/`--theirs`, which now leaves the index unmerged as git does), `setMerge`/`setConflictStyle` (`-m`, `--conflict`, re-creating conflicts from resolve-undo too), `setForced` (unmerged paths passed over with a warning), `setIgnoreSkipWorktreeBits` (skip-worktree entries are passed over otherwise), `setQuiet`, `setCountCheckoutPaths` ("Updated N paths from ...") and `setPathspecFromFile`. A new `RestoreCommand` (`git.restore()`) covers `--source`, `--staged`, `--worktree`, `--overlay`, `--ours`/`--theirs`/`--merge`/`--conflict`, `--ignore-unmerged` and `--ignore-skip-worktree-bits`. `ResetCommand` with paths follows `read_from_tree`: pathspecs, unmerged paths (recorded for resolve-undo), skip-worktree bits, `setIntentToAdd` (`-N`, also without paths), `setPathspecFromFile`, an unborn HEAD, and git's refusals ("Cannot do soft reset with paths.").

`InitCommand.setDirectory` now roots the worktree at that directory (it rooted it at the FilesApi's root), and a clone into a fresh repository skips the repository's own git directory when checking that the destination is empty, so `setGitDir("meta").setWorktree(true)` accepts a clone. The staging areas gain `getResolveUndo` and `dropResolveUndo`, and `FileWorktree` exposes `getGitDir`.
