---
"@statewalker/vcs-commands": minor
---

`git blame --ignore-rev`, `--ignore-revs-file`, `blame.ignoreRevsFile` (git 2.52's `:(optional)` paths included), `blame.markIgnoredLines` and `blame.markUnblamableLines`, with git's fuzzy line matching for the changed lines of ignored commits (`guess_line_blames`, `fuzzy_find_matching_lines`, `fill_origin_fingerprints`); `--reverse <from>..<to>` (the last commit each line existed in) and `--first-parent`. `BlameEntry` gains `ignored`/`unblamable`, and the formatters print git's `?`/`*` marks and, from git 2.50, the porcelain `ignored`/`unblamable` lines (`lineMarks`). Ported from statewalker/statewalker-root#344.
