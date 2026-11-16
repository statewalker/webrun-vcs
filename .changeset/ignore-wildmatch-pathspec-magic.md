---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
---

**Ignore rules as git's wildmatch; clean never removes an unverifiable repository; pathspec magic.**

- **vcs-working-tree (data loss fixes):** `.gitignore` rules are matched as git matches them (`match_basename` / `match_pathname` over a port of git's `wildmatch`): a name-only rule tests the last component (`foo` then `!foo/` keeps `foo/foo` ignored), a directory-only rule ending in `**` never matches a file, a backslash makes the next character literal (`\*.txt`, `\[x\]`, `\#hash`, `\!bang`, `sp\ `), unescaped trailing spaces go. New `wildmatch()` export and `IgnoreRule.matchesPath()`. A pattern git accepts is never dropped (an unclosed bracket simply matches nothing).
- **vcs-store-files, vcs-working-tree:** new `Worktree.repositoryState(path)` (`"repository" | "none" | "unknown"`); `FileWorktree.isIgnored` decides a directory by `lstat` (an empty one too).
- **vcs-commands (data loss fixes):** `clean -ff` never removes a directory whose `.git` cannot be checked (a link or gitfile naming a place beyond the root): it is kept as a possible repository. Path filters take git's pathspec magic: `:!`/`:^`/`:(exclude)` (an implicit `.` when only excludes are given), `:/`/`:(top)`, `:(literal)`, `:(glob)`, `:(icase)`; `.` and `..` are normalised as git does and a path above the top is refused, as is `attr` magic.
