---
"@statewalker/vcs-commands": minor
---

Plumbing diffs (statewalker/statewalker-root#354): `git.diffTree()`, `git.diffIndex()`,
`git.diffFiles()` and `git.diffPairs()`, with git's plumbing defaults (raw output with full ids,
no renames unless asked, subtrees as entries without `-r`, `-t`, `--root`, `--stdin` with
grafted parents, `-m`/`-c`/`--cc` and the combined raw form, `--no-commit-id`, `--pretty`).
`DiffCommand` and `git log` gain the `raw` format and `-z` (`DiffTextOptions.nullTerminated`,
`rawFullIds`; `LogOutputOptions.raw`); `diff-files`/`diff-index` compare the worktree by stat
as git's plumbing does (a stat-dirty file is a change, its raw id the null id).
