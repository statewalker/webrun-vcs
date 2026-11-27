---
"@statewalker/vcs-commands": patch
---

`git init` and `git clone` read `init.defaultBranch` and `advice.defaultBranchName` as git's `repo_default_branch_name` does once the new repository exists: from its whole configuration (system, global, its own config with what a template brought in, the command line), with `includeIf "gitdir:..."` / `"gitdir/i:..."` conditions matched against the new repository's git directory. A per-directory include (`[includeIf "gitdir:~/work/"]` setting `init.defaultBranch = trunk`) now names the initial branch, and clone's guess of a remote HEAD without symref prefers that branch. `defaultInitialBranch` takes the new repository's configuration (`NewRepositoryConfig`). (#224)
