---
"@statewalker/vcs-commands": minor
---

`cherry-pick` and `revert` take git's remaining flags (statewalker/statewalker-root#311):
`CherryPickCommand.setRecordOrigin` (`-x`, its `(cherry picked from commit …)` line after a
blank line unless the message ends with a trailer block), `setSignoff` on both commands (`-s`,
through the trailers engine and `trailer.*`), `setAllowEmpty`, `setAllowEmptyMessage`,
`setKeepRedundantCommits` and `setEmpty("stop" | "drop" | "keep")` (`--empty`, git 2.45+:
a dropped commit prints git's `dropping … -- patch contents already upstream` in the output),
`setFastForward` (`--ff`, also onto an unborn branch, reflog `cherry-pick: fast-forward`), and
`RevertCommand.setReference` (`--reference`, `revert.reference`). The commit message is cleaned
up as git's try_to_commit cleans it (`whitespace` for `-s`/`-x`, else `commit.cleanup`), a pick's
message starts at its subject, a revert of a revert is titled `Reapply "…"`, and every flag is
saved in and read back from `sequencer/opts`, so native git continues our sequences and the
other way round. Options git refuses together (`--ff` with `-s`/`-x`/`-n`/`--edit`; `-n`, `-s`,
`-m`, `-x`, `--ff`, `--keep-redundant-commits`, `--empty` with `--continue`/`--skip`/`--abort`/
`--quit`, the last two only from 2.45) throw git's `fatal:` line. `-m` follows git: a parent a
merge does not have, or `-m 2` on a non-merge, refuses with `error: commit <id> does not have
parent <n>`; `-m 0` with exit 129. Picking onto an unborn branch commits a root commit, and
`-n` over an unmerged index refuses with `error: your index file is unmerged.`.
A sequence of picks onto an unborn branch runs as git's (`sequencer/head` as git leaves it, an
empty abort-safety), a revert sequence there refuses with `can't revert as initial commit`, a
commit named twice is picked once, and `--skip` with nothing stopped says
`no cherry-pick in progress` / `no revert in progress`.
