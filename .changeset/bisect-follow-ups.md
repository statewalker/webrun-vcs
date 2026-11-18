---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**`diff.renames=copies` finds copies.** `git diff` and `git log` (`--stat`, `--name-status`, `--summary`, `-p`) detect copies as git's `diffcore_rename` does under DIFF_DETECT_COPY: modified paths are sources too, a source can be taken by several destinations (the last use of a deleted source is the rename, the others copies), no basename matches. `detectRenames` takes `copies` and sources marked `kept`, and its pairs say `copy`.

**`git diff` of a conflict prints the combined diff first.** With several formats including the patch, the `diff --cc` of a conflicted path comes before the stat and summary of the other paths, as `run_diff_files` prints it.

**`git bisect` checkouts.** The tracking report follows `status.compareBranches` (git 2.56: each of `@{upstream}` and `@{push}` compared once, a blank line between reports, `git pull <remote> <branch>` advice for a push ref behind), and `GIT_PRINT_SHA1_ELLIPSIS=yes` puts `...` after the ids of "HEAD is now at" and "Previous HEAD position was". `GitHostEnvironment` gains `printSha1Ellipsis`, which `createNodeGitHostEnvironment` reads from `GIT_PRINT_SHA1_ELLIPSIS`.
