---
"@statewalker/vcs-commands": minor
---

`git.rebase()` gets `addTrailer` (`--trailer <token>=<value>`, git 2.46+): each rebased
commit's message gets the trailer through the trailers engine (`trailer.*` configuration and
commands apply; fixups and squashes add none, `fixup -C` adds them to the message it takes),
kept in `rebase-merge/trailer` for `--continue`. Like git it forces the rebase, refuses an
empty argument or one without a key before anything is done, and is an unknown option
(exit 129) under 2.43 compatibility. The date options (`setCommitterDateIsAuthorDate`,
`setIgnoreDate`) are checked against native git across picks, rewords, squashes, `exec`,
`--rebase-merges` and conflict resolutions. Conflicting picks now give git 2.45+'s
`advice.mergeConflict` hints (off drops them, unset adds how to turn them off), an `edit`
stop writes the picked message to `rebase-merge/message` as 2.5x does, and an interactive
rebase with nothing to replay shows its `noop` list to the editor instead of moving to the
upstream at once (statewalker/statewalker-root#310).
