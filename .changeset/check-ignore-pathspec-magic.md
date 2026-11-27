---
"@statewalker/vcs-commands": patch
---

check-ignore: read each path as git's `parse_pathspec` does, with every magic but `:/` refused. `:]` is the path `]`, `:/x` is `x` from the top, `:!x`, `:(glob)x` and the other magic die with git's "pathspec magic not supported by this command" line, and an empty path dies ("empty string is not a valid pathspec") before any output for arguments, after the earlier records' output for `--stdin`. Every argument is checked before the first line is printed, as git parses them all first.
