---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
---

git's environment variables (statewalker/statewalker-root#368): `setupGitDirectory` is setup.c's repository setup with `GIT_DIR`, `GIT_WORK_TREE`, `core.worktree`, `core.bare`, `GIT_IMPLICIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` (git directory, common directory, worktree, the directory git ends up in and its prefix), and `discoverRepository` uses it when the environment sets `GIT_DIR` or `GIT_WORK_TREE`; `createNodeGitHostEnvironment` reads these variables, `GIT_OPTIONAL_LOCKS` and `GIT_REF_PARANOIA`. `GIT_OPTIONAL_LOCKS=0` keeps `status` from writing the index. gc, repack and prune follow git's ref paranoia (on by default): a ref with a bad name or at a missing object stops them, `GIT_REF_PARANOIA=0` skips such refs. `rebase -i` without an `editTodo` handler runs `GIT_SEQUENCE_EDITOR` / `sequence.editor` / git's editor through the hook runner.
