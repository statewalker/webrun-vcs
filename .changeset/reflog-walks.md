---
"@statewalker/vcs-commands": minor
---

Reflog walks follow `git log -g` and `git reflog show`, checked against native git 2.43 and 2.56
(statewalker/statewalker-root#315). `RevListCommand.setWalkReflogs` (`-g`/`--walk-reflogs`) reads
each revision as a reflog to walk, as reflog-walk.c does: `HEAD`, `main` and `refs/heads/main`
keep the name given in `<ref>@{n}`, `@{0}` walks the current branch's reflog, `@{-1}` the branch
left before, `<ref>@{<n>}` starts at that entry and `<ref>@{<date>}` (`HEAD@{now}`) at the entry
of that date, shown as `<ref>@{<date>}`; an explicit `--date` shows dates for refs named without a
selector, `log.date` does not. Several reflogs interleave by entry date, entries whose value is no
commit are passed over, `--since`/`--until` compare the entry's date, paths are limited against
the commit's parents, and `-n`/`--skip`/`--grep`/`--no-merges` apply. New: `--grep-reflog`
(`addGrepReflog` on `LogCommand` and `RevListCommand`, the `reflogs` of `CommitGrepOptions`), git's
refusals (`cannot walk reflogs for <rev>` for `^a`/`a..b`, a sorted walk, `--reverse`,
`--grep-reflog` without `-g`, in each version's order: `setCompatibility("2.43" | "2.56")`),
`LogCommand.addReflogWalk`/`setWalkReflogs`, `LogResult.reflog` (rev-list's `-g`),
`RevListCommand.getWarnings`, `%gd` shortened as `shorten_unambiguous_ref`, and on
`ReflogCommand` `callText` (`git reflog [show] [<ref>]`: `%h <ref>@{n}: <message>`, its defaults
under other log options), `setMaxCount` and `callExists` (`git reflog exists`).
