---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
---

**`clean` reads the worktree as git's directory scan does: no data loss on path filters, ignored nested repositories or nested negations.**

- **vcs-commands (data loss fixes):** `clean` is now a port of git's `read_directory` (with the flags `git clean` sets) and `correct_untracked_entries`, then `remove_dirs`. A glob path filter matching a directory's name no longer takes the directory (git descends and matches the files); a plain path next to a glob no longer removes the plain-named directory whole; an ignored nested repository (repository, gitfile, `.git` link) keeps its untracked parent under `-ff` without `-x`; a submodule entry wins over index paths below it; a nested repository the index tracks paths in is entered as git enters it. Path filters follow git's pathspec matching (`*` and `?` match `/`, a trailing slash names a directory, the common prefix starts the scan).
- **vcs-working-tree (ignore rules):** a rule matches the path itself, as git: a name-only pattern its last component, a directory-only pattern only a directory. A negated directory rule (`!*/`) re-includes directories, never the files below them that a parent rule excludes.
