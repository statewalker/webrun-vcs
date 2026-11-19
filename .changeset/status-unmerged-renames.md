---
"@statewalker/vcs-commands": patch
---

**`git status` pairs worktree renames with unmerged paths as git does.**

An unmerged path takes part in the worktree side's rename detection as `diff-files` queues it: its file, when there, is a rename destination (a worktree deletion paired with it is no longer shown), and its stage #2, when the file is gone, is a source (an intent-to-add file paired with it shows ` R`). Porcelain v2 prints the unmerged (`u`) lines after the changed ones, as git does.
