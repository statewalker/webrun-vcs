---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
---

`git init` and `git clone` layouts as git writes them (statewalker-root#348): `InitCommand.setSeparateGitDir` (the gitfile as git writes it; re-init moves an existing git directory and repairs its linked worktrees), `setTemplate` (and `$GIT_TEMPLATE_DIR` / `init.templateDir`, copied from a FilesApi directory with git's skip rules), `setShared` and `core.sharedRepository` with git's `adjust_shared_perm` modes on what a shared repository's commands create (objects, packs, refs, reflogs, the index, `info/refs`), new repositories get `objects/info` and `core.logallrefupdates`. vcs-utils: `parseSharedRepository`, `calcSharedPerm`, `adjustSharedPerm` (directories too), `withSharedPerm`; the Node FilesApi's `chmod` keeps setgid on directories.
