---
"@statewalker/vcs-commands": minor
---

`git blame -M[<num>]` and `-C[<num>]` (given up to three times): `BlameCommand.setDetectMoves` and `setDetectCopies` find lines moved within the file and copied from other files of the parents as git's `find_move_in_parent` and `find_copy_in_parent` do, with their score thresholds (statewalker/statewalker-root#343). Blame now maps authors and committers through the mailmap (`.mailmap`, `mailmap.blob`, `mailmap.file`) as git does; `setUseMailmap(false)` keeps the identities as written.
