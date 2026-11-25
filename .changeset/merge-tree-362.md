---
"@statewalker/vcs-commands": minor
---

`git merge-tree`: `mergeTree()` runs merge-ort in memory (`--write-tree`: the result tree, the conflicted index entries, merge-ort's messages; `--messages`, `--name-only`, `-z` with each message's type and paths, `--stdin`, `--merge-base`, `-X`, `--allow-unrelated-histories`, `--quiet`) and the old three-tree trivial merge, with git's stdout, stderr and exit status; nothing but objects is written. `OrtMergeResult.details` gives merge-ort's messages with their conflict type and the paths involved (statewalker/statewalker-root#362).
