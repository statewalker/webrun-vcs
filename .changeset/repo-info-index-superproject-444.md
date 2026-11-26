---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": patch
---

`Staging.indexLocation()` (optional; `GitStaging`, `FileStagingStore`): the index file a staging reads and writes, git's `repo_get_index_file`. `git repo info` reports a relative `$GIT_INDEX_FILE` as the file the working copy opened (read from where git's setup went), and finds `path.superprojectworkingtree.*` as submodule.c's `get_superproject_working_tree` does: a gitlink at the worktree's path in the index of the repository above it, so embedded submodules and a superproject's linked-worktree submodules are found and a dropped gitlink is not (statewalker/webrun-vcs#444, statewalker/webrun-vcs#445).
