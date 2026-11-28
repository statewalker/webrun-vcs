---
"@statewalker/vcs-commands": patch
---

`log --graph -p` with `--word-diff` (porcelain, plain, color) and `--color-words` now writes the graph's line prefix where git's diff.c does: only where a word hunk starts on a new line or after a newline inside a piece, so porcelain's `~` and most `-`/`+` lines go without it (statewalker/webrun-vcs#310).
