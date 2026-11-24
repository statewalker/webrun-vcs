---
"@statewalker/vcs-commands": minor
---

`git log` and `git rev-list` commit filters (statewalker/statewalker-root#290). `LogCommand` and `RevListCommand` gain `addGrep`, `addAuthor`, `addCommitter`, `setAllMatch`, `setInvertGrep`, `setRegexpIgnoreCase`, `setPatternType` (`basic`, `extended`, `fixed`, `perl`), `setUseMailmap` and `setLogConfig`. They match as git's `commit_match` and grep.c do: author and committer patterns on their header lines without the date, through the mailmap under `log.mailmap`; `--grep` from the message's empty line on; `--all-match`; `--invert-grep` inverting `--grep` only; `grep.patternType` and `grep.extendedRegexp`; and git's `fatal:` line for a bad pattern (`GrepPatternError`).

`-P` (`--perl-regexp`, `grep.patternType=perl`) is refused the way a git built without PCRE refuses it (`cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE`). A pattern with no regex character still matches literally. No JavaScript RegExp ever runs a user's pattern. `grep.*` and `log.mailmap` are read only when a pattern is set, and `RevListCommand` reads neither by default, as `git rev-list` does. The log output (`callBytes`/`callText`) dies on a bad `grep.patternType` as `git log`/`git show` do.

Filters compose through `CommitFilters` (`all`, `none`, `and`, `or`, `not`, `noMerges`, `onlyMerges`, `parents`, `commitTime`, `grep`, `author`, `committer`, `message`) and `addCommitFilter`. They form one stage of the walk that log, rev-list and the log output share. A `CommitFilter` may be async and reads the commit's raw bytes, so pickaxe and line-log filters can plug in later.
