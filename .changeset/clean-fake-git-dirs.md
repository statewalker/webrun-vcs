---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
---

**Clean never removes what it has not walked: fake `.git` directories as git.**

- **vcs-commands (data loss fix):** `clean -d`, `-dx` and `-X -d` no longer remove a directory holding a `.git` that is no repository whole and unwalked: like git's `remove_dirs`, they enter it (and the fake `.git`), skip the nested repositories in it ("Would skip repository", `-ff` removes them whole), remove the files one by one and the directories once empty. Recursive removal is used only for a nested repository under `-ff`. A directory whose listing failed is never removed. Plain `clean` now works on the same tree model as `-X`: a directory removed only in part reports its removed subdirectories without the trailing slash, as git.
- **vcs-working-tree:** `WorktreeWalkOptions.enterNonRepositoryGitDirs` (list and enter a `.git` that names no repository) and `onUnreadable` (directories whose listing failed); `Worktree.remove` takes `WorktreeRemoveOptions` (`nonRepositoryGitDirs` accepts such `.git` components; a real repository's `.git` is still refused), `removeEmptyDirectory` too.
- **vcs-store-files:** `FileWorktree` implements those options; a dangling `.git` link whose target lies inside the FilesApi is no repository (git removes its directory with `-d`).
