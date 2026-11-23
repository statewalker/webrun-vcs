---
"@statewalker/vcs-commands": minor
---

`git log` and `git rev-list` commit filters (statewalker/statewalker-root#290). `LogCommand` and `RevListCommand` gain `addGrep`, `addAuthor`, `addCommitter`, `setAllMatch`, `setInvertGrep`, `setRegexpIgnoreCase`, `setPatternType` (`basic`, `extended`, `fixed`, `perl`), `setUseMailmap` and `setLogConfig`. They match as git's `commit_match` and grep.c do: author and committer patterns on their header lines without the date, through the mailmap under `log.mailmap`; `--grep` from the message's empty line on; `--all-match`; `--invert-grep` inverting `--grep` only; `grep.patternType` and `grep.extendedRegexp`; and git's `fatal:` line for a bad pattern (`GrepPatternError`).

`-P` runs PCRE2 syntax through a translated JavaScript `RegExp` with byte semantics, as in the C locale. Possessive quantifiers, atomic groups, recursion, `\p`, `\K`, verbs and other syntax without an exact equivalent are refused with a clear error, never run as something else.

Filters compose through `CommitFilters` (`all`, `none`, `and`, `or`, `not`, `noMerges`, `onlyMerges`, `parents`, `commitTime`, `grep`, `author`, `committer`, `message`) and `addCommitFilter`. They form one stage of the walk that log, rev-list and the log output share. A `CommitFilter` may be async and reads the commit's raw bytes, so pickaxe and line-log filters can plug in later.
