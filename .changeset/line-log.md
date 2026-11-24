---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
---

`git log -L <start>,<end>:<file>` and `git log -L :<funcname>:<file>`: `LogCommand.addLineRange` follows line ranges back through history as git's line-log.c (statewalker/statewalker-root#341). Ranges take line numbers, `+N`/`-N` offsets, `/regex/` and `^/regex/` searches and `:funcname` regexes found by the path's diff driver (`diff.<driver>.xfuncname`/`funcname`, the builtin drivers), all through `compilePosixRegex`; several ranges, renames, merges, `--first-parent`, `--graph`, `--oneline`, `-s` and formats work, each commit's patch cut to the ranges as git 2.5x prints it (`setCompatibility("2.43")`: 2.43's own diff and range arithmetic), and git's deaths (bad ranges, missing paths, a pathspec, unsupported formats) are matched. vcs-utils: `EmittedHunk.countsAlways` prints both counts of a hunk header.
