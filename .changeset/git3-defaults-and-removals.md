---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
---

**The initial branch of a new repository follows git, and git 3.0's defaults come with `breakingChanges`.**

- **Breaking:** `init` (and clone's fallback) no longer always names the initial branch `main`. As git's `repo_default_branch_name`, it takes `setInitialBranch`, else `init.defaultBranch` from the system or global configuration (or `git -c`), else `master`, or `main` with `GitHostEnvironment.breakingChanges` (git 3.0). Pass `setInitialBranch("main")`, or set `init.defaultBranch`, to keep the old name. `InitResult.hints` holds git's `advice.defaultBranchName` hint when the built-in default was used. An invalid name refuses as git does (`InvalidInitialBranchError`, `InvalidDefaultBranchError`).
- `safe.bareRepository` defaults to `explicit` with `breakingChanges` (`allowedBareRepository(entries, breakingChanges)`).
- `core.commentChar` / `core.commentString` = `auto` makes every command refuse with git 3.0's exact message and advice when `breakingChanges` is set (`AutoCommentCharRemovedError`). `autoCommentCharLines(workingCopy, "deprecated")` gives git 2.5x's warning for hosts that print it.
