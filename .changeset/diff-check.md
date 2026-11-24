---
"@statewalker/vcs-commands": minor
---

`git diff --check`, `git log --check` and `git show --check` (statewalker/statewalker-root#325):
the `check` output format of `DiffCommand` (`callBytes("check")`, `LogOutputOptions.check`)
prints diff.c's `<file>:<line>: <error>.` lines with the offending line (its errors in the
`whitespace` color under `--color`), `leftover conflict marker` lines (the
`conflict-marker-size` attribute) and `new blank line at EOF.`; `DiffCommand.exitCode` adds 2
when it found errors (3 with `--exit-code` and changes), `LogCommand.exitCode` and `git show`'s
exit status are 2, as git's. The `whitespace` attribute overrides `core.whitespace` per path,
and a `core.whitespace` git cannot parse (`tab-in-indent,indent-with-non-tab`, or a variable
without a value) now stops every command before it reads or writes anything
(`GitCommand.checkConfigOnLoad`, git's `git_default_core_config`), except those git lets
through: `git config`, `git remote`, `git ls-remote`, and `git bisect`, whose checkout fails
instead. Under git 2.43 compatibility `incomplete-line` names no rule, and the rules after it
still apply. `git apply`, the colored diff and `--check` share one implementation of ws.c's rules
(vcs-commands `whitespace/`: `parseWhitespaceRule`, `wsCheck`, `wsCheckEmit`, `wsBlankLine`,
`wsFixCopy`, `checkBlankAtEof`).
