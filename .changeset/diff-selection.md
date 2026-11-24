---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
---

`git.diff()` gets the options that choose what a diff shows, byte for byte as git: the new
`DiffTextOptions` `diffFilter` (`--diff-filter=[ACDMRTUXB*]`, lowercase letters exclude, `*` all
or none), `relative` (`--relative[=<path>]`, `--no-relative`: paths outside the prefix are not
queued, names shown without it, attributes and `--summary` by the full path), `rotateTo` /
`skipTo` (`--rotate-to`, `--skip-to`; `git diff` dies on a path not in the diff, `git log` starts
at the next one) and `ignoreMatchingLines` (`-I<regex>`, POSIX extended regexes through
`compilePosixRegex`, as xdiff's `xdl_mark_ignorable_regex`). `setExitCode` (`--exit-code`) and
`setQuiet` (`--quiet`, which prints nothing and stops at the first difference) set `exitCode`
(git's `diff_result_code`, with `-w`/`-I` counting only pairs whose patch shows a change) and
`hasChanges`; `quietDetectsRenames` keeps git 2.43's rename detection under `--quiet`.
`setOldTree("A...B")` diffs from the merge base (git's warning when there are several, its
errors when there is none), `"A..B"` is `A B`, and `setMergeBase` is `--merge-base`. `git log`
takes `diffFilter` (only the commits whose filtered diff is not empty), `relative`,
`ignoreMatchingLines` and non-strict `rotateTo`/`skipTo` through `setDiffOptions`. `exitCodeFromContents` keeps git 2.43's exit status (every queued pair counts). In
vcs-utils, `UnifiedDiffOptions.ignoreRegex`, `markIgnorableRegex`, and `compilePosixRegex`'s
`newline` option (`REG_NEWLINE`) (statewalker/statewalker-root#313).
