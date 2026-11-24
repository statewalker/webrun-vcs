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

`GitWorkingCopyConfig.save()` writes unsets as `git config --unset-all` does (its
`maybe_remove_section`): a run of headers of one section whose every variable goes is removed
with the blank lines before it, unless a comment stands in the run, right before it or after a
header's `]`; consecutive headers of one section count as one run; a file whose last lines go
still ends with a newline. A key unset and then given values again is written after the
removals: at the end of what is left of its section, or in a new section at the end of the file
when its section went (statewalker/statewalker-root#295).
