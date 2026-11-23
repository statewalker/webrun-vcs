---
"@statewalker/vcs-commands": minor
---

`git commit` gains `-s`/`--signoff` (`setSignoff`), `--trailer` (`addTrailer`), `--author` as one
string (`setAuthor("Name <email>")`, or a pattern resolved as git's `find_author_by_nickname`:
the newest matching, mailmapped author of `--all`), `--date` (`setDate`: `parse_date` forms, then
approxidate) and `-C` (`setReuseMessage`), with git's refusals (`--reset-author` without `-C`/`--amend`,
`--reset-author` with `--author`, `-m` with `-C`). Sign-offs and trailers go through the trailers
engine (`appendSignoff`, `amendWithTrailers`). `GitCommand.loadMailmap` is shared by log and commit.
