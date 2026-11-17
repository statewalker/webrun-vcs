---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-store-files": minor
---

**`addWorktree` checks before it writes; `parseGitBool` refuses integers outside git's `int`.**

- **vcs-store-files:** `addWorktree` refuses a missing branch and a repository without commits before it writes anything, and when a later write fails it removes what it created (git's `junk_git_dir`/`junk_work_tree`): `worktrees/NAME` and the worktree directory, never a directory that was there before. A retry therefore gets the plain name, not `NAME1` next to a stale locked `NAME`. While it sets up, `worktrees/NAME/locked` reads `initializing`, as git writes it, and is removed at the end unless `lock` keeps it; the lock reason gets a line end only when it has none, and an empty reason writes an empty file. `WorkingCopyFactoryFilesApi` now requires `remove`.
- **vcs-store-files:** `isAbsoluteGitPath` follows Git for Windows: a leading backslash (UNC paths included) and any drive prefix, the drive-relative `C:repo` too. An absolute `commondir` below the FilesApi's root on the host is mapped into the FilesApi; host paths built from a Windows root use forward slashes (`C:/Users/x/...`).
- **vcs-utils:** `parseGitBool` refuses what `git_parse_int` refuses: a magnitude above 2147483647 with its `k`/`m`/`g` unit applied (`2147483648`, `-2147483648`, `0x80000000`, `2g`), and a non-integer number (`k = 1.5`).
