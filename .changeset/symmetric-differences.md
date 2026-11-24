---
"@statewalker/vcs-commands": minor
---

Symmetric differences in `git log` and `git rev-list`: `--left-right` (the `<`/`>` marks in rev-list's output, `--oneline`, `--graph` and `%m`), `--left-only`/`--right-only`, `--cherry-pick`, `--cherry-mark` and `--cherry` (patch-ids computed lazily as revision.c's `cherry_pick_list`, limited to the walk's paths), `--count` with its left/right/same columns, and `git cherry [-v] [--abbrev] [<upstream> [<head> [<limit>]]]` (`git.cherry()`). The patch-id table (`PatchIds`) is shared with rebase's skipping of commits already upstream.
