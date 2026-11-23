---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
---

`git branch`'s upstream management: `git.branchSetUpstream()` (`-u`/`--set-upstream-to`, with
git 2.5x's `<remote> <branch>` slip refusal and the `advice.setUpstreamFailure` hint) and
`git.branchUnsetUpstream()` (`--unset-upstream`); `branchCreate()` gains `setTrack(TrackMode)`
(`-t`/`--track[=direct|inherit]`, `--no-track`, `branch.autoSetupMerge` `false`/`true`/`always`/
`inherit`/`simple`, `branch.autoSetupRebase`), `setCreateReflog` (`--create-reflog`) and
`setQuiet`, and reports git's `branch 'x' set up to track 'origin/y'.` and its warnings through
`getOutput()`/`getWarnings()`; a missing start point fails as git's `not a valid object name`.
New `git.branchShowCurrent()` (`--show-current`) and `git.branchEditDescription()`
(`--edit-description`, an editor callback as `CommitCommand.setEditor`). `checkout -b` shares the
tracking code and returns the message in `CheckoutResult.output`, inherit and own-upstream
warnings in `warnings`; ambiguous remotes get git's `advice.ambiguousFetchRefspec` hint.

`GitWorkingCopyConfig.save()` writes unsets as `git config` does: a section block left without
variables loses its header (and the blank lines before it) unless a comment is in or right before
it, and a key unset then given values again is written at its section's end
(statewalker/statewalker-root#295).
