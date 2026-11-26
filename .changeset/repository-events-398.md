---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

Repository event listeners (`WorkingCopy.listeners`, JGit's listener list): refs changed, index changed, config changed and working tree modified, told once per write in the order the writes happen (`RepositoryListeners`, `observeRefWrites`, `Staging.addWriteListener`, `Worktree.addModifiedListener`, `GitWorkingCopyConfig.addChangeListener`).
